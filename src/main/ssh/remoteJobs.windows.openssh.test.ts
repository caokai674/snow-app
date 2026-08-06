import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowsTestPassword = vi.hoisted(
  () => process.env.SNOW_WINDOWS_SSH_TEST_PASSWORD ?? "snow-test-password"
);

vi.mock("electron", () => ({
  app: { getPath: () => "C:/Temp" },
}));

vi.mock("./sshCredentials", () => ({
  getSshCredential: () => ({
    authMethod: "password",
    encryptedSecret: "test-only",
  }),
  getDecryptedSecret: () => windowsTestPassword,
}));

vi.mock("./sshHostKeys", () => ({
  getSshHostKey: () => null,
  saveSshHostKey: (params: Record<string, unknown>) => ({
    ...params,
    trustedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

import { connectSsh, disconnectAllSsh, disconnectSsh, executeSshCommand } from "./sshManager";
import { cancelRemoteJob, getRemoteJob, startRemoteJob } from "./remoteJobs";

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

const waitForTerminal = async (jobId: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let result = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
  while (Date.now() < deadline) {
    if (result.state.status !== "preparing" && result.state.status !== "launching" && result.state.status !== "running") {
      return result;
    }
    await wait(250);
    result = await getRemoteJob(jobId, { offset: 0, limit: 64 * 1024 });
  }
  throw new Error(`Windows Remote Job ${jobId} did not reach a terminal state`);
};

openSsh("Durable Remote Job Windows OpenSSH", () => {
  beforeEach(async () => {
    process.env.SNOW_REMOTE_JOB_BINDINGS_DIR = `C:/Temp/snow-remote-jobs-${randomUUID()}`;
    const sessionId = await connectSsh({
      host,
      port,
      username: user,
      authMethod: "password",
      password: windowsTestPassword,
    });
    try {
      await executeSshCommand(
        sessionId,
        `powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path 'C:/Users/${user}/workspace' | Out-Null; Remove-Item -Force -Recurse -ErrorAction SilentlyContinue (Join-Path $env:LOCALAPPDATA 'SnowApp/jobs')"`
      );
    } finally {
      disconnectSsh(sessionId);
    }
  }, 30_000);

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

  it("records timeout and cancellation, then cleans up child processes", async () => {
    const timedOut = randomUUID();
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: "Start-Sleep -Seconds 30",
      timeoutMs: 500,
      jobId: timedOut,
      backend: "windows-job",
    });
    const timeoutResult = await waitForTerminal(timedOut);
    expect(timeoutResult.state.status).toBe("timed_out");

    const cancelled = randomUUID();
    const childPidPath = `C:/Users/${user}/child-${cancelled}.pid`;
    await startRemoteJob({
      workspacePath: workspacePath(),
      command: [
        "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru",
        `[System.IO.File]::WriteAllText('${childPidPath}', [string]$child.Id)`,
        "Start-Sleep -Seconds 30",
      ].join("; "),
      timeoutMs: 30_000,
      jobId: cancelled,
      backend: "windows-job",
    });

    let childPid = "";
    const childDeadline = Date.now() + 10_000;
    const childSession = await connectSsh({
      host,
      port,
      username: user,
      authMethod: "password",
      password: windowsTestPassword,
    });
    try {
      while (!childPid && Date.now() < childDeadline) {
        try {
          childPid = (
            await executeSshCommand(
              childSession,
              `powershell.exe -NoProfile -NonInteractive -Command "Get-Content -LiteralPath '${childPidPath}' -Raw"`
            )
          ).trim();
        } catch {
          await wait(250);
        }
      }
    } finally {
      disconnectSsh(childSession);
    }
    expect(childPid).toMatch(/^\d+$/);
    await cancelRemoteJob(cancelled);
    const cancelledResult = await waitForTerminal(cancelled);
    expect(cancelledResult.state.status).toBe("cancelled");

    const probeSession = await connectSsh({
      host,
      port,
      username: user,
      authMethod: "password",
      password: windowsTestPassword,
    });
    try {
      await expect(
        executeSshCommand(
          probeSession,
          `powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { Write-Output alive } else { Write-Output gone }"`
        )
      ).resolves.toContain("gone");
    } finally {
      disconnectSsh(probeSession);
    }
  }, 60_000);
});
