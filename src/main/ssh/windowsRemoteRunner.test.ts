import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sshManager", () => ({
  executeSshCommand: vi.fn(),
}));

import { executeSshCommand } from "./sshManager";
import {
  buildWindowsCommandScript,
  buildWindowsRunnerScript,
  encodeWindowsPowerShell,
  isWindowsRemote,
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
