import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostKeys = vi.hoisted(() => new Map<string, string>());

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
}));

vi.mock("./sshCredentials", () => ({
  getSshCredential: () => ({
    authMethod: "password",
    encryptedSecret: "test-only",
  }),
  getDecryptedSecret: () => "snow-test-password",
}));

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
} from "./sshManager";
import {
  cancelRemoteJob,
  getRemoteJob,
  startRemoteJob,
  type RemoteJobBackendKind,
  type RemoteJobOutput,
  type RemoteJobStartRequest,
} from "./remoteJobs";

const enabled = process.env.SNOW_SSH_TEST === "1";
const host = process.env.SNOW_SSH_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.SNOW_SSH_TEST_PORT ?? "0");
const openSsh = enabled ? describe : describe.skip;
const originalBindingsDir = process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
let bindingsDirectory = "";

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const workspacePath = (): string =>
  `ssh://snow@${host}:${port}/home/snow`;

const passwordParams = () => ({
  host,
  port,
  username: "snow",
  authMethod: "password" as const,
  password: "snow-test-password",
});

const clearRemoteJobDirectory = async (): Promise<void> => {
  const sessionId = await connectSsh(passwordParams());
  try {
    await executeSshCommand(
      sessionId,
      "rm -rf -- /home/snow/.local/state/snow-app/jobs && mkdir -p -- /home/snow/workspace"
    );
  } finally {
    disconnectSsh(sessionId);
  }
};

const waitFor = async (
  jobId: string,
  predicate: (result: RemoteJobOutput) => boolean,
  timeoutMs = 12_000
): Promise<RemoteJobOutput> => {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteJobOutput | null = null;
  while (Date.now() < deadline) {
    last = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
    if (predicate(last)) {
      return last;
    }
    await wait(200);
  }
  throw new Error(
    `Remote Job ${jobId} did not reach the expected state: ${JSON.stringify(last?.state)}`
  );
};

const isTerminal = (status: string): boolean =>
  [
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
  ].includes(status);

openSsh("Durable Remote Job OpenSSH fault injection", () => {
  beforeEach(async () => {
    expect(port).toBeGreaterThan(0);
    bindingsDirectory = mkdtempSync(join(tmpdir(), "snow-remote-jobs-test-"));
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = bindingsDirectory;
    await clearRemoteJobDirectory();
  });

  afterEach(async () => {
    disconnectAllSsh();
    hostKeys.clear();
    if (bindingsDirectory) {
      rmSync(bindingsDirectory, { recursive: true, force: true });
      bindingsDirectory = "";
    }
    await clearRemoteJobDirectory();
  });

  afterAll(() => {
    if (originalBindingsDir === undefined) {
      delete process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
    } else {
      process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = originalBindingsDir;
    }
  });

  for (const backend of ["posix-detach", "tmux"] as const) {
    it(`${backend} survives SSH disconnection, is idempotent, and restores a deleted Binding`, async () => {
      const jobId = randomUUID();
      const executionsPath = `/home/snow/${jobId}.executions`;
      const request: RemoteJobStartRequest = {
        workspacePath: workspacePath(),
        command: [
          "printf 'started\\n'",
          "sleep 2",
          "printf 'finished\\n'",
          `printf 1 >> ${executionsPath}`,
        ].join("; "),
        timeoutMs: 10_000,
        jobId,
        backend: backend as RemoteJobBackendKind,
      };

      // startRemoteJob closes its launch SSH session before this wait. A later
      // connection observes that the remote runner completed independently.
      const accepted = await startRemoteJob(request);
      const retry = await startRemoteJob(request);
      expect(retry.jobId).toBe(jobId);
      expect(retry.createdAt).toBe(accepted.createdAt);

      const completed = await waitFor(jobId, (result) =>
        isTerminal(result.state.status)
      );
      expect(completed.state.status).toBe("succeeded");
      expect(completed.output).toContain("started");
      expect(completed.output).toContain("finished");

      const sessionId = await connectSsh(passwordParams());
      try {
        await expect(
          executeSshCommand(sessionId, `cat -- ${executionsPath}`)
        ).resolves.toBe("1");
      } finally {
        disconnectSsh(sessionId);
      }

      const bindingsPath = join(bindingsDirectory, "bindings.json");
      expect(existsSync(bindingsPath)).toBe(true);
      rmSync(bindingsPath);
      const restored = await startRemoteJob(request);
      expect(restored.jobId).toBe(jobId);
      expect(restored.status).toBe("succeeded");
      await expect(getRemoteJob(jobId, { offset: 0 })).resolves.toMatchObject({
        state: { status: "succeeded" },
        output: expect.stringContaining("finished"),
      });
    }, 30_000);
  }

  it("records cancellation and keeps prior output readable", async () => {
    const jobId = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "printf 'cancellable-start\\n'; sleep 30; printf 'must-not-complete\\n'",
      timeoutMs: 30_000,
      jobId,
      backend: "posix-detach",
    });

    await waitFor(jobId, (result) => result.output.includes("cancellable-start"));
    const cancelled = await cancelRemoteJob(jobId);
    expect(cancelled.status).toBe("cancelled");

    const result = await waitFor(
      jobId,
      (current) => current.state.status === "cancelled"
    );
    expect(result.output).toContain("cancellable-start");
    expect(result.output).not.toContain("must-not-complete");
  }, 30_000);
});
