import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sshManager", () => ({
  executeSshCommand: vi.fn(),
}));

import { executeSshCommand } from "./sshManager";
import {
  buildWindowsCommandScript,
  buildWindowsRunnerScript,
  buildWindowsDetachedProcessLauncherScript,
  encodeWindowsPowerShell,
  isWindowsRemote,
  launchWindowsRemoteJob,
  runWindowsPowerShell,
} from "./windowsRemoteRunner";

const executeSshCommandMock = vi.mocked(executeSshCommand);

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

  it("uses WMI breakaway creation to detach runners from the OpenSSH process tree", async () => {
    const launcher = buildWindowsDetachedProcessLauncherScript(
      "[Console]::Out.Write('ok')"
    );
    expect(launcher).toContain("New-CimInstance -ClassName Win32_ProcessStartup");
    expect(launcher).toContain("CreateFlags = 16777216");
    expect(launcher).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(launcher).not.toContain("Start-Process");

    executeSshCommandMock.mockClear();
    executeSshCommandMock.mockResolvedValueOnce("4242");
    await launchWindowsRemoteJob(
      "session",
      "C:/Users/snow/AppData/Local/SnowApp/jobs/runner.ps1",
      "018f5f17-5d18-7bd1-9210-117f17d50001"
    );
    const command = executeSshCommandMock.mock.calls[0]?.[1] ?? "";
    const encoded = command.match(/EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("New-CimInstance -ClassName Win32_ProcessStartup");
    expect(decoded).toContain("CreateFlags = 16777216");
    expect(decoded).not.toContain("Start-Process");
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
