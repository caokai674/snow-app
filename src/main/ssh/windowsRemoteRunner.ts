import { Buffer } from "node:buffer";
import { executeSshCommand, type SshCapabilities } from "./sshManager";

const powerShellQuote = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const windowsCommandQuote = (value: string): string =>
  `"${value.replace(/"/g, '\\"')}"`;

const POWER_SHELL_NON_INTERACTIVE_PRELUDE =
  "$ProgressPreference = 'SilentlyContinue'\r\n";

export const encodeWindowsPowerShell = (script: string): string =>
  Buffer.from(
    `${POWER_SHELL_NON_INTERACTIVE_PRELUDE}${script}`,
    "utf16le"
  ).toString("base64");

export const runWindowsPowerShell = (
  sessionId: string,
  script: string,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> =>
  executeSshCommand(
    sessionId,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodeWindowsPowerShell(script)}`,
    { timeoutMs, signal }
  );

const getWindowsTaskName = (id: string): string => `SnowAppRemoteJob-${id}`;

export const buildWindowsScheduledTaskLauncherScript = (
  taskName: string,
  scriptPath: string
): string => {
  const taskCommand =
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
    windowsCommandQuote(scriptPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = ${powerShellQuote(taskName)}`,
    `$taskCommand = ${powerShellQuote(taskCommand)}`,
    "$taskArguments = @('/Create', '/TN', $taskName, '/SC', 'ONCE', '/ST', '23:59', '/SD', '12/31/2099', '/TR', $taskCommand, '/RL', 'LIMITED', '/F')",
    "$createOutput = & schtasks.exe @taskArguments 2>&1",
    "if ($LASTEXITCODE -ne 0) { throw \"Failed to create detached Windows task $taskName with exit code $($LASTEXITCODE): $($createOutput | Out-String)\" }",
    "$runOutput = & schtasks.exe /Run /TN $taskName 2>&1",
    "if ($LASTEXITCODE -ne 0) { & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null; throw \"Failed to start detached Windows task $taskName with exit code $($LASTEXITCODE): $($runOutput | Out-String)\" }",
    "",
  ].join("\r\n");
};

export const launchWindowsDetachedPowerShell = (
  sessionId: string,
  taskName: string,
  scriptPath: string,
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    buildWindowsScheduledTaskLauncherScript(taskName, scriptPath),
    timeoutMs,
    signal
  );

export const getWindowsRemoteJobTaskName = (jobId: string): string =>
  getWindowsTaskName(jobId);

export const isWindowsRemote = (capabilities: SshCapabilities): boolean =>
  capabilities.platform === "windows" &&
  capabilities.powerShell &&
  capabilities.windowsJobObjects;

export const getWindowsRemoteJobRoot = async (sessionId: string): Promise<string> => {
  const root = (
    await runWindowsPowerShell(
      sessionId,
      "$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SnowApp\\jobs'; New-Item -ItemType Directory -Force -Path $root | Out-Null; [Console]::Out.Write($root.Replace('\\','/'))",
      10_000
    )
  ).trim();
  if (!/^[A-Za-z]:\//.test(root) || root.includes("\n")) {
    throw new Error("Remote Job state directory is not an absolute Windows path");
  }
  return root.replace(/\/+$/, "");
};

export const createWindowsRemoteDirectory = (
  sessionId: string,
  path: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `New-Item -ItemType Directory -Path ${powerShellQuote(path)} -ErrorAction Stop | Out-Null`
  );

export const moveWindowsRemotePath = (
  sessionId: string,
  source: string,
  target: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `Move-Item -LiteralPath ${powerShellQuote(source)} -Destination ${powerShellQuote(
      target
    )} -ErrorAction Stop`
  );

export const removeWindowsRemotePath = (
  sessionId: string,
  path: string
): Promise<string> =>
  runWindowsPowerShell(
    sessionId,
    `Remove-Item -LiteralPath ${powerShellQuote(path)} -Force -Recurse -ErrorAction Stop`
  );

export const buildWindowsCommandScript = (workingDirectory: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${powerShellQuote(workingDirectory)}`,
    "$command = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'command.txt'), [System.Text.Encoding]::UTF8)",
    "& ([ScriptBlock]::Create($command)) *>> (Join-Path $PSScriptRoot 'output.log')",
    "if ($null -eq $LASTEXITCODE) { exit 0 }",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");

/**
 * The runner owns a Windows Job Object with KILL_ON_JOB_CLOSE. Killing the
 * runner therefore also terminates its descendants, unlike a bare
 * Start-Process call over OpenSSH.
 */
export const buildWindowsRunnerScript = (jobId: string, createdAt: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$jobDirectory = $PSScriptRoot",
    `$jobId = ${powerShellQuote(jobId)}`,
    "$scheduledTaskName = 'SnowAppRemoteJob-' + $jobId",
    `$createdAt = ${powerShellQuote(createdAt)}`,
    "$statePath = Join-Path $jobDirectory 'state.json'",
    "$revisionPath = Join-Path $jobDirectory 'revision'",
    "$timeoutMs = [int64](Get-Content -LiteralPath (Join-Path $jobDirectory 'timeout-ms') -Raw)",
    "$backend = 'windows-job'",
    "$runnerPid = $PID",
    "$stateLockPath = Join-Path $jobDirectory 'state.lock'",
    "[System.IO.File]::WriteAllText((Join-Path $jobDirectory 'runner.pid'), [string]$runnerPid, [System.Text.Encoding]::ASCII)",
    "function Enter-StateLock() { for ($i = 0; $i -lt 400; $i++) { try { New-Item -ItemType Directory -Path $stateLockPath -ErrorAction Stop | Out-Null; return } catch { Start-Sleep -Milliseconds 25 } }; throw 'Remote Job state lock timed out' }",
    "function Exit-StateLock() { Remove-Item -LiteralPath $stateLockPath -Force -Recurse -ErrorAction SilentlyContinue }",
    "function Write-State([string]$status, [Nullable[int]]$exitCode, [string]$reason) {",
    "  Enter-StateLock",
    "  try {",
    "    if (Test-Path -LiteralPath $statePath) { $currentState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json; if ($currentState.status -in @('succeeded','failed','timed_out','cancelled','lost','launch_failed','indeterminate')) { return } }",
    "    $revision = 1 + [int](Get-Content -LiteralPath $revisionPath -Raw)",
    "    [System.IO.File]::WriteAllText($revisionPath, [string]$revision, [System.Text.Encoding]::ASCII)",
    "    $now = [DateTime]::UtcNow.ToString('o')",
    "    $state = [ordered]@{ schemaVersion = 1; jobId = $jobId; status = $status; revision = $revision; backend = $backend; runnerPid = $runnerPid; createdAt = $createdAt; updatedAt = $now; exitCode = $exitCode }",
    "    if ($status -in @('succeeded','failed','timed_out','cancelled','lost','launch_failed','indeterminate')) { $state.completedAt = $now }",
    "    if ($reason) { $state.reason = $reason }",
    "    $temporary = \"$statePath.$([Guid]::NewGuid().ToString('N')).tmp\"",
    "    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)",
    "    if (Test-Path -LiteralPath $statePath) { [System.IO.File]::Replace($temporary, $statePath, $null, $true) } else { [System.IO.File]::Move($temporary, $statePath) }",
    "  } finally { Exit-StateLock }",
    "}",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SnowWindowsJob {",
    "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);",
    "  [StructLayout(LayoutKind.Sequential)] public struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimit { public BasicLimit BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }",
    "  public static IntPtr CreateKillOnCloseJob() { var job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); var value = new ExtendedLimit(); value.BasicLimitInformation.LimitFlags = 0x00002000; int size = Marshal.SizeOf(value); IntPtr memory = Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(value, memory, false); if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new System.ComponentModel.Win32Exception(); return job; } catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(memory); } }",
    "}",
    "'@",
    "Write-State 'launching' $null ''",
    "$job = [SnowWindowsJob]::CreateKillOnCloseJob()",
    "try {",
    "  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $jobDirectory 'command.ps1')) -WindowStyle Hidden -PassThru",
    "  if (-not [SnowWindowsJob]::AssignProcessToJobObject($job, [IntPtr]$child.Id)) { throw [ComponentModel.Win32Exception]::new() }",
    "  Write-State 'running' $null ''",
    "  $started = [Environment]::TickCount64; $cancelled = $false; $timedOut = $false",
    "  while (-not $child.HasExited) {",
    "    if (Test-Path -LiteralPath (Join-Path $jobDirectory 'cancel.request')) { $cancelled = $true; Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }",
    "    elseif (([Environment]::TickCount64 - $started) -ge $timeoutMs) { $timedOut = $true; Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }",
    "    Start-Sleep -Milliseconds 250; $child.Refresh()",
    "  }",
    "  if ($timedOut) { Write-State 'timed_out' $child.ExitCode 'timeout' }",
    "  elseif ($cancelled) { Write-State 'cancelled' $child.ExitCode 'cancelled' }",
    "  elseif ($child.ExitCode -eq 0) { Write-State 'succeeded' 0 '' }",
    "  else { Write-State 'failed' $child.ExitCode 'exit' }",
    "} catch { Write-State 'launch_failed' $null $_.Exception.Message }",
    "finally { if ($job -and $job -ne [IntPtr]::Zero) { [SnowWindowsJob]::CloseHandle($job) | Out-Null }; & schtasks.exe /Delete /TN $scheduledTaskName /F 2>$null | Out-Null }",
    "",
  ].join("\r\n");

export const launchWindowsRemoteJob = async (
  sessionId: string,
  runnerPath: string,
  jobId: string,
  signal?: AbortSignal
): Promise<void> => {
  await launchWindowsDetachedPowerShell(
    sessionId,
    getWindowsTaskName(jobId),
    runnerPath,
    15_000,
    signal
  );
};

export const inspectWindowsRemoteJob = async (
  sessionId: string,
  runnerPid: number | undefined
): Promise<"active" | "inactive"> => {
  if (!runnerPid) {
    return "inactive";
  }
  const output = await runWindowsPowerShell(
    sessionId,
    `if (Get-Process -Id ${Math.max(0, Math.floor(runnerPid))} -ErrorAction SilentlyContinue) { [Console]::Out.Write('active') } else { [Console]::Out.Write('inactive') }`
  );
  return output.trim() === "active" ? "active" : "inactive";
};

export const cancelWindowsRemoteJob = async (
  sessionId: string,
  runnerPid: number | undefined
): Promise<void> => {
  if (!runnerPid) {
    return;
  }
  await runWindowsPowerShell(
    sessionId,
    `Stop-Process -Id ${Math.max(0, Math.floor(runnerPid))} -Force -ErrorAction SilentlyContinue`
  );
};
