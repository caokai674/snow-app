import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "C:/Temp" },
}));

vi.mock("./sshCredentials", () => ({
  getSshCredential: () => ({
    authMethod: "password",
    encryptedSecret: "test-only",
  }),
  getDecryptedSecret: () => "snow-test-password",
}));

vi.mock("./sshHostKeys", () => ({
  getSshHostKey: () => null,
  saveSshHostKey: (params: Record<string, unknown>) => ({
    ...params,
    trustedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

import { connectSsh, disconnectAllSsh, disconnectSsh, executeSshCommand } from "./sshManager";
import { getRemoteJob, startRemoteJob } from "./remoteJobs";

const enabled = process.env.SNOW_WINDOWS_SSH_TEST === "1";
const openSsh = enabled ? describe : describe.skip;
const host = process.env.SNOW_WINDOWS_SSH_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.SNOW_WINDOWS_SSH_TEST_PORT ?? "22");
const user = process.env.SNOW_WINDOWS_SSH_TEST_USER ?? "snow";
const originalBindings = process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;

const workspacePath = (): string =>
  `ssh://${user}@${host}:${port}/C:/Users/${user}/workspace`;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

openSsh("Durable Remote Job Windows OpenSSH", () => {
  beforeEach(async () => {
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = `C:/Temp/snow-remote-jobs-${randomUUID()}`;
    const sessionId = await connectSsh({
      host,
      port,
      username: user,
      authMethod: "password",
      password: "snow-test-password",
    });
    try {
      await executeSshCommand(
        sessionId,
        `powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path 'C:/Users/${user}/workspace' | Out-Null; Remove-Item -Force -Recurse -ErrorAction SilentlyContinue (Join-Path $env:LOCALAPPDATA 'SnowApp/jobs')"`
      );
    } finally {
      disconnectSsh(sessionId);
    }
  });

  afterEach(() => {
    disconnectAllSsh();
  });

  afterAll(() => {
    if (originalBindings === undefined) {
      delete process.env.SNOW_REMOTE_JOB_BINDINGS_DIR;
    } else {
      process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = originalBindings;
    }
  });

  it("detects PowerShell, completes a Job Object-backed job, and preserves output", async () => {
    const jobId = randomUUID();
    const job = await startRemoteJob({
      workspacePath: workspacePath(),
      command: "Write-Output 'started'; Start-Sleep -Milliseconds 500; Write-Output 'finished'",
      timeoutMs: 15_000,
      jobId,
      backend: "windows-job",
    });
    expect(job.backend).toBe("windows-job");

    const deadline = Date.now() + 20_000;
    let result = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
    while (Date.now() < deadline && result.state.status === "running") {
      await wait(250);
      result = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
    }
    expect(result.state.status).toBe("succeeded");
    expect(result.output).toContain("started");
    expect(result.output).toContain("finished");
  }, 45_000);
});
