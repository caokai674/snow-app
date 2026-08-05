import { describe, expect, it } from "vitest";
import {
  buildWindowsCommandScript,
  buildWindowsRunnerScript,
  isWindowsRemote,
} from "./windowsRemoteRunner";

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
  });
});
