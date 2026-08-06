import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostKeys = vi.hoisted(() => new Map<string, string>());

vi.mock("./sshHostKeys", () => ({
  getSshHostKey: (host: string, port: number) => {
    const fingerprint = hostKeys.get(`${host}:${port}`);
    return fingerprint
      ? { host, port, fingerprint, trustedAt: "2026-01-01T00:00:00.000Z" }
      : null;
  },
  saveSshHostKey: (params: {
    host: string;
    port: number;
    fingerprint: string;
  }) => {
    hostKeys.set(`${params.host}:${params.port}`, params.fingerprint);
    return { ...params, trustedAt: "2026-01-01T00:00:00.000Z" };
  },
}));

import {
  connectSsh,
  disconnectAllSsh,
  disconnectSsh,
  executeSshCommand,
  readSshFile,
  readSshFileWithVersion,
  writeInternalSshFile,
  writeSshFile,
} from "./sshManager";

const enabled = process.env.SNOW_SSH_TEST === "1";
const host = process.env.SNOW_SSH_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.SNOW_SSH_TEST_PORT ?? "0");
const container = process.env.SNOW_SSH_TEST_CONTAINER;
const hostKeyPath = process.env.SNOW_SSH_TEST_HOST_KEY;
const privateKeyPath = process.env.SNOW_SSH_TEST_PRIVATE_KEY;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const passwordParams = () => ({
  host,
  port,
  username: "snow",
  authMethod: "password" as const,
  password: "snow-test-password",
});

const waitForServer = async (): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const sessionId = await connectSsh(passwordParams());
      disconnectSsh(sessionId);
      return;
    } catch (error) {
      lastError = error;
      if ((error as { code?: string }).code === "SSH_HOST_KEY_CHANGED") {
        throw error;
      }
      await wait(200);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SSH test server did not start");
};

const restartContainer = (mode: "same-key" | "new-key"): void => {
  if (!container) {
    throw new Error("SNOW_SSH_TEST_CONTAINER is required for OpenSSH fault injection");
  }
  if (mode === "new-key") {
    if (!hostKeyPath) {
      throw new Error("SNOW_SSH_TEST_HOST_KEY is required for host-key replacement");
    }
    rmSync(hostKeyPath, { force: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  }
  execFileSync("docker", ["restart", container], { stdio: "ignore" });
};

afterEach(() => {
  disconnectAllSsh();
  hostKeys.clear();
});

const openSsh = enabled ? describe : describe.skip;

openSsh("OpenSSH regression environment", () => {
  it("handles cancellation, disconnect, SSH_AUTH_SOCK and host-key replacement", async () => {
    expect(port).toBeGreaterThan(0);
    expect(container).toBeTruthy();
    expect(hostKeyPath && existsSync(hostKeyPath)).toBe(true);
    expect(privateKeyPath && existsSync(privateKeyPath)).toBe(true);

    const sessionId = await connectSsh(passwordParams());
    await writeInternalSshFile(sessionId, "/home/snow/phase0.txt", "phase-0");
    await expect(readSshFile(sessionId, "/home/snow/phase0.txt")).resolves.toEqual(
      Buffer.from("phase-0")
    );

    const privateKeySession = await connectSsh({
      host,
      port,
      username: "snow",
      authMethod: "privateKey",
      privateKeyPath,
    });
    await expect(executeSshCommand(privateKeySession, "printf private-key-ok")).resolves.toBe(
      "private-key-ok"
    );
    disconnectSsh(privateKeySession);

    const cancelled = new AbortController();
    const cancelledCommand = executeSshCommand(sessionId, "sleep 30", {
      signal: cancelled.signal,
    });
    await wait(100);
    cancelled.abort();
    await expect(cancelledCommand).rejects.toMatchObject({
      code: "SSH_COMMAND_CANCELLED",
      remoteProcessTermination: "unconfirmed",
    });
    disconnectSsh(sessionId);

    const disconnectedSession = await connectSsh(passwordParams());
    const disconnectedCommand = executeSshCommand(
      disconnectedSession,
      "sleep 30"
    );
    await wait(100);
    execFileSync("docker", ["stop", container as string], { stdio: "ignore" });
    try {
      await disconnectedCommand;
      throw new Error("Expected the command to fail after the SSH server stopped");
    } catch (error) {
      expect(error).toMatchObject({
        remoteProcessTermination: "unconfirmed",
        sideEffect: "possible",
      });
      expect(["SSH_CONNECTION_CLOSED", "SSH_CONNECTION_ERROR"]).toContain(
        (error as { code?: string }).code
      );
    }
    execFileSync("docker", ["start", container as string], { stdio: "ignore" });
    await waitForServer();

    restartContainer("new-key");
    await expect(waitForServer()).rejects.toMatchObject({
      code: "SSH_HOST_KEY_CHANGED",
    });

    const replacementSession = await connectSsh({
      ...passwordParams(),
      hostKeyPolicy: "replace",
    });
    disconnectSsh(replacementSession);

    const agentSession = await connectSsh({
      host,
      port,
      username: "snow",
      authMethod: "agent",
    });
    await expect(executeSshCommand(agentSession, "printf agent-ok")).resolves.toBe(
      "agent-ok"
    );
  }, 60_000);

  it("uses a verified compatibility update without overwriting links or concurrent edits", async () => {
    expect(port).toBeGreaterThan(0);
    const sessionId = await connectSsh(passwordParams());
    const root = "/home/snow/phase2";
    const filePath = `${root}/document.txt`;
    await expect(
      executeSshCommand(
        sessionId,
        `mkdir -p ${root} && printf old > ${filePath} && chmod 640 ${filePath}`
      )
    ).resolves.toBe("");

    const loaded = await readSshFileWithVersion(sessionId, filePath);
    const saved = await writeSshFile(sessionId, filePath, "new", {
      workspaceRoot: root,
      expectedVersion: loaded.version,
    });
    expect(saved.guarantee).toBe("compatibility");
    expect(saved.durability).toEqual({ fsynced: true, posixRename: false });
    expect(saved.sideEffect).toBe("committed");
    await expect(
      executeSshCommand(sessionId, `cat ${filePath}; stat -c %a ${filePath}`)
    ).resolves.toBe("new640\n");

    const stale = await readSshFileWithVersion(sessionId, filePath);
    await executeSshCommand(sessionId, `printf external > ${filePath}`);
    await expect(
      writeSshFile(sessionId, filePath, "lost", {
        workspaceRoot: root,
        expectedVersion: stale.version,
      })
    ).rejects.toMatchObject({ code: "SSH_FILE_CONFLICT", sideEffect: "none" });
    await expect(readSshFile(sessionId, filePath)).resolves.toEqual(
      Buffer.from("external")
    );

    const linkPath = `${root}/linked.txt`;
    await executeSshCommand(sessionId, `ln -s ${filePath} ${linkPath}`);
    await expect(
      writeSshFile(sessionId, linkPath, "blocked", {
        workspaceRoot: root,
        expectedVersion: { exists: false },
      })
    ).rejects.toMatchObject({
      code: "SSH_FILE_SYMLINK_NOT_ALLOWED",
      sideEffect: "none",
    });
    await expect(readSshFile(sessionId, filePath)).resolves.toEqual(
      Buffer.from("external")
    );

    const restrictedDirectory = `${root}/restricted`;
    const restrictedFile = `${restrictedDirectory}/file.txt`;
    await executeSshCommand(
      sessionId,
      `mkdir -p ${restrictedDirectory} && printf intact > ${restrictedFile} && chmod 500 ${restrictedDirectory}`
    );
    const restrictedVersion = await readSshFileWithVersion(sessionId, restrictedFile);
    await expect(
      writeSshFile(sessionId, restrictedFile, "blocked", {
        workspaceRoot: root,
        expectedVersion: restrictedVersion.version,
      })
    ).resolves.toMatchObject({
      guarantee: "compatibility",
      sideEffect: "committed",
    });
    await executeSshCommand(sessionId, `chmod 700 ${restrictedDirectory}`);
    await expect(
      executeSshCommand(sessionId, `cat ${restrictedFile}; stat -c %a ${restrictedFile}`)
    ).resolves.toBe("blocked644\n");
  }, 60_000);
});
