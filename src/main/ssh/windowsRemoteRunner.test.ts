import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sshManager", () => ({
  executeSshCommand: vi.fn(),
  getSshSession: vi.fn(),
}));

import { executeSshCommand, getSshSession } from "./sshManager";
import {
  buildWindowsCommandScript,
  buildWindowsRunnerScript,
  buildWindowsScheduledTaskLauncherScript,
  encodeWindowsPowerShell,
  isWindowsRemote,
  launchWindowsRemoteJob,
  runWindowsPowerShell,
} from "./windowsRemoteRunner";

const executeSshCommandMock = vi.mocked(executeSshCommand);
const getSshSessionMock = vi.mocked(getSshSession);

const passwordSession = {
  params: {
    username: "snowssh",
    authMethod: "password" as const,
    password: "test-password",
  },
};

describe("Windows Remote Job runner", () => {
  it("requires a PowerShell host with Job Object support", () => {
    expect(
      isWindowsRemote({
        platform: "windows",
        posixShell: false,
        systemdUser: false,
        tmux: false,
        setsid: false,
        nohup: false,
        powerShell: true,
        windowsJobObjects: true,
      })
    ).toBe(true);
    expect(
      isWindowsRemote({
        platform: "windows",
        posixShell: false,
        systemdUser: false,
        tmux: false,
        setsid: false,
        nohup: false,
        powerShell: false,
        windowsJobObjects: true,
      })
    ).toBe(false);
  });

  it("uses NTFS replacement and a kill-on-close Job Object", () => {
    expect(buildWindowsCommandScript("C:/Users/snow/workspace")).toContain(
      "Set-Location -LiteralPath 'C:/Users/snow/workspace'"
    );
    const runner = buildWindowsRunnerScript(
      "018f5f17-5d18-7bd1-9210-117f17d50001",
      "2026-08-05T00:00:00.000Z"
    );
    expect(runner).toContain("[System.IO.File]::Replace");
    expect(runner).toContain("CreateKillOnCloseJob");
    expect(runner).toContain("AssignProcessToJobObject");
    expect(runner).toContain("state.lock");
    expect(runner).toContain("ConvertFrom-Json");
  });

  it("uses Task Scheduler to detach runners from the OpenSSH process tree", async () => {
    const taskName = "SnowAppRemoteJob-018f5f17-5d18-7bd1-9210-117f17d50001";
    const launcher = buildWindowsScheduledTaskLauncherScript(
      taskName,
      "C:/Users/snow/AppData/Local/SnowApp/jobs/probe.ps1",
      passwordSession.params
    );
    expect(launcher).toContain("& schtasks.exe @taskArguments");
    expect(launcher).toContain("& schtasks.exe /Run /TN $taskName");
    expect(launcher).toContain("'/RL', 'LIMITED'");
    expect(launcher).toContain("'12/31/2099'");
    expect(launcher).toContain("'/RU', $taskUsername, '/RP', $taskPassword");
    expect(launcher).toContain("$taskUsername = 'snowssh'");
    expect(launcher).toContain("$null = & schtasks.exe @taskArguments 2>&1");
    expect(launcher).toContain("$createExitCode = $LASTEXITCODE");
    expect(launcher).toContain("exit code $createExitCode\"");
    expect(launcher).toContain("$runExitCode = $LASTEXITCODE");
    expect(launcher).toContain("exit code $runExitCode\"");
    expect(launcher).not.toContain("$createOutput");
    expect(launcher).not.toContain("$runOutput");
    expect(launcher).toContain("-File \"C:/Users/snow/AppData/Local/SnowApp/jobs/probe.ps1\"");
    expect(launcher).not.toContain("-EncodedCommand");
    expect(launcher).not.toContain("Start-Process");

    executeSshCommandMock.mockClear();
    getSshSessionMock.mockReturnValue(passwordSession as never);
    executeSshCommandMock.mockResolvedValueOnce("");
    await launchWindowsRemoteJob(
      "session",
      "C:/Users/snow/AppData/Local/SnowApp/jobs/runner.ps1",
      "018f5f17-5d18-7bd1-9210-117f17d50001"
    );
    const command = executeSshCommandMock.mock.calls[0]?.[1] ?? "";
    const encoded = command.match(/EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("schtasks.exe @taskArguments");
    expect(decoded).toContain(taskName);
    expect(decoded).toContain("'/RU', $taskUsername, '/RP', $taskPassword");
    expect(decoded).not.toContain("Start-Process");
  });

  it("rejects non-password sessions without exposing a credential", async () => {
    executeSshCommandMock.mockClear();
    getSshSessionMock.mockReturnValue({
      params: { username: "snowssh", authMethod: "privateKey" },
    } as never);

    await expect(
      launchWindowsRemoteJob(
        "session",
        "C:/Users/snow/AppData/Local/SnowApp/jobs/runner.ps1",
        "018f5f17-5d18-7bd1-9210-117f17d50001"
      )
    ).rejects.toThrow(
      "Windows durable jobs require password authentication for detached scheduling"
    );
    expect(executeSshCommandMock).not.toHaveBeenCalled();
  });

  it("suppresses first-use PowerShell progress for every encoded command", async () => {
    const script = "[Console]::Out.Write('ok')";
    expect(Buffer.from(encodeWindowsPowerShell(script), "base64").toString("utf16le")).toBe(
      "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::Out.Write('ok')"
    );

    executeSshCommandMock.mockResolvedValueOnce("ok");
    await expect(runWindowsPowerShell("session", script)).resolves.toBe("ok");
    expect(executeSshCommandMock).toHaveBeenCalledWith(
      "session",
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodeWindowsPowerShell(script)}`,
      { timeoutMs: 15_000, signal: undefined }
    );
  });
});
