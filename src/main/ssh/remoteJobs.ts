import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  executeSshCommand,
  probeSshCapabilities,
  readSshFile,
  readSshFileRange,
  statSshEntry,
  writeSshFile,
  type SshCapabilities,
} from "./sshManager";
import {
  normalizeRemotePath,
  shellQuote,
  withSshSession,
} from "./remoteWorkspaceCommand";
import {
  buildWindowsCommandScript,
  buildWindowsRunnerScript,
  cancelWindowsRemoteJob,
  createWindowsRemoteDirectory,
  getWindowsRemoteJobRoot,
  inspectWindowsRemoteJob,
  isWindowsRemote,
  launchWindowsRemoteJob,
  moveWindowsRemotePath,
  removeWindowsRemotePath,
} from "./windowsRemoteRunner";
import {
  cancelSnowAgentJob,
  inspectSnowAgentJob,
  launchSnowAgentJob,
  negotiateSnowAgent,
  probeSnowAgentLiveness,
} from "./snowAgent";

const JOB_SCHEMA_VERSION = 1;
const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = MAX_JOB_TIMEOUT_MS;
const MAX_OUTPUT_READ_BYTES = 64 * 1024;
const SUCCESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const BACKEND_PROBE_CACHE_MS = 10 * 60 * 1000;

export type RemoteJobStatus =
  | "preparing"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost"
  | "launch_failed"
  | "indeterminate";

export type RemoteJobBackendKind =
  | "snow-agent"
  | "systemd-user"
  | "tmux"
  | "posix-detach"
  | "windows-job";

export type RemoteJobState = {
  schemaVersion: number;
  jobId: string;
  status: RemoteJobStatus;
  revision: number;
  backend?: RemoteJobBackendKind;
  runnerPid?: number;
  exitCode?: number;
  createdAt?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
};

export type RemoteJobBinding = {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  profileId: string;
  commandHash: string;
  displayCommand: string;
  backend: RemoteJobBackendKind;
  jobTokenHash: string;
  createdAt: string;
  updatedAt: string;
  status: RemoteJobStatus;
  revision: number;
  conversationId?: string;
  toolCallId?: string;
  lastOutputOffset: number;
  lastError?: string;
};

export type RemoteJobStartRequest = {
  workspacePath: string;
  workspaceId?: string;
  command: string;
  timeoutMs?: number;
  jobId?: string;
  backend?: RemoteJobBackendKind;
  conversationId?: string;
  toolCallId?: string;
};

export type RemoteJobOutput = {
  job: RemoteJobBinding;
  state: RemoteJobState;
  output: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
};

export type RemoteJobAttachSpec = {
  jobId: string;
  workspacePath: string;
  backend: RemoteJobBackendKind;
  remoteCommand: string;
};

export type RemoteJobBackendContext = {
  sessionId: string;
  jobDirectory: string;
  jobId: string;
  timeoutMs: number;
  capabilities: SshCapabilities;
};

export interface RemoteJobBackend {
  kind: RemoteJobBackendKind;
  isAvailable(capabilities: SshCapabilities): boolean;
  launch(context: RemoteJobBackendContext): Promise<void>;
  inspect(context: RemoteJobBackendContext): Promise<"active" | "inactive">;
  cancel(context: RemoteJobBackendContext): Promise<void>;
  supportsInteractiveAttach?: boolean;
}

type StoredBindings = {
  schemaVersion: number;
  jobs: RemoteJobBinding[];
};

const TERMINAL_STATUSES = new Set<RemoteJobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "launch_failed",
  "indeterminate",
]);

const BACKEND_PROBE_CACHE = new Map<string, number>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJobId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

const isRemoteJobStatus = (value: unknown): value is RemoteJobStatus =>
  typeof value === "string" &&
  [
    "preparing",
    "launching",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
  ].includes(value);

const isBackendKind = (value: unknown): value is RemoteJobBackendKind =>
  value === "snow-agent" ||
  value === "systemd-user" ||
  value === "tmux" ||
  value === "posix-detach" ||
  value === "windows-job";

const normalizeWorkspacePath = (value: string): string => {
  const path = value.trim();
  if (!path.startsWith("ssh://")) {
    throw new Error("Remote Job requires an SSH workspace path");
  }
  return path.replace(/\/+$/, "") || path;
};

const normalizeTimeout = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Remote Job timeout must be a positive number");
  }
  return Math.min(Math.floor(value), MAX_JOB_TIMEOUT_MS);
};

const getBindingsDirectory = (): string =>
  process.env.SNOW_REMOTE_JOB_BINDINGS_DIR?.trim() ||
  join(app.getPath("userData"), "remote-jobs");

const getBindingsPath = (): string => join(getBindingsDirectory(), "bindings.json");

const ensureBindingsDirectory = (): void => {
  const directory = getBindingsDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Some platforms do not expose POSIX permissions.
  }
};

const readBindings = (): RemoteJobBinding[] => {
  const path = getBindingsPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) {
      return [];
    }
    return parsed.jobs.filter(
      (job): job is RemoteJobBinding =>
        isRecord(job) &&
        typeof job.jobId === "string" &&
        isJobId(job.jobId) &&
        typeof job.workspacePath === "string" &&
        typeof job.workspaceId === "string" &&
        typeof job.profileId === "string" &&
        typeof job.commandHash === "string" &&
        typeof job.displayCommand === "string" &&
        isBackendKind(job.backend) &&
        typeof job.jobTokenHash === "string" &&
        typeof job.createdAt === "string" &&
        typeof job.updatedAt === "string" &&
        isRemoteJobStatus(job.status) &&
        typeof job.revision === "number" &&
        typeof job.lastOutputOffset === "number"
    );
  } catch {
    return [];
  }
};

const writeBindings = (jobs: RemoteJobBinding[]): void => {
  ensureBindingsDirectory();
  const path = getBindingsPath();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content: StoredBindings = { schemaVersion: JOB_SCHEMA_VERSION, jobs };
  writeFileSync(temporaryPath, JSON.stringify(content, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some platforms do not expose POSIX permissions.
  }
};

const upsertBinding = (binding: RemoteJobBinding): RemoteJobBinding => {
  const jobs = readBindings();
  const index = jobs.findIndex((job) => job.jobId === binding.jobId);
  if (index >= 0) {
    jobs[index] = binding;
  } else {
    jobs.push(binding);
  }
  writeBindings(jobs);
  return binding;
};

const updateBinding = (
  jobId: string,
  update: Partial<RemoteJobBinding>
): RemoteJobBinding | null => {
  const jobs = readBindings();
  const index = jobs.findIndex((job) => job.jobId === jobId);
  if (index < 0) {
    return null;
  }
  const binding = { ...jobs[index], ...update, updatedAt: new Date().toISOString() };
  jobs[index] = binding;
  writeBindings(jobs);
  return binding;
};

const getBinding = (jobId: string): RemoteJobBinding | null =>
  readBindings().find((job) => job.jobId === jobId) ?? null;

const commandHash = (command: string): string =>
  createHash("sha256").update(command).digest("hex");

const redactCommand = (command: string): string =>
  command
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*=\s*)(['"]?)[^\s'"]+\2/gi,
      "$1***"
    )
    .slice(0, 1_000);

const pathForJob = (root: string, jobId: string): string => `${root}/${jobId}`;

const powerShellEncodedCommand = (script: string): string =>
  Buffer.from(script, "utf16le").toString("base64");

const runPowerShell = (
  sessionId: string,
  script: string,
  timeoutMs = 15_000
): Promise<string> =>
  executeSshCommand(
    sessionId,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${powerShellEncodedCommand(
      script
    )}`,
    { timeoutMs }
  );

const runPlatformScript = (
  sessionId: string,
  capabilities: SshCapabilities,
  posixScript: string,
  powerShellScript: string,
  timeoutMs = 15_000
): Promise<string> =>
  capabilities.platform === "windows"
    ? runPowerShell(sessionId, powerShellScript, timeoutMs)
    : executeSshCommand(sessionId, `sh -lc ${shellQuote(posixScript)}`, {
        timeoutMs,
      });

const remotePathExists = async (sessionId: string, path: string): Promise<boolean> =>
  (await statSshEntry(sessionId, path)) !== null;

const createRemoteJobDirectory = (
  sessionId: string,
  capabilities: SshCapabilities,
  path: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? createWindowsRemoteDirectory(sessionId, path)
    : runShell(sessionId, `umask 077 && mkdir -- ${shellQuote(path)}`);

const moveRemoteJobDirectory = (
  sessionId: string,
  capabilities: SshCapabilities,
  source: string,
  target: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? moveWindowsRemotePath(sessionId, source, target)
    : runShell(
        sessionId,
        `mv -- ${shellQuote(source)} ${shellQuote(target)}`
      );

const removeRemoteJobPath = (
  sessionId: string,
  capabilities: SshCapabilities,
  path: string
): Promise<string> =>
  capabilities.platform === "windows"
    ? removeWindowsRemotePath(sessionId, path)
    : runShell(sessionId, `rm -rf -- ${shellQuote(path)}`);

const getRemoteJobRoot = async (
  sessionId: string,
  knownCapabilities?: SshCapabilities
): Promise<string> => {
  const capabilities = knownCapabilities ?? (await probeSshCapabilities(sessionId));
  if (capabilities.platform === "windows") {
    return getWindowsRemoteJobRoot(sessionId);
  }
  const root = (
    await executeSshCommand(
      sessionId,
      [
        'state_root="${XDG_STATE_HOME:-$HOME/.local/state}/snow-app/jobs"',
        'mkdir -p -- "$state_root"',
        'cd -- "$state_root"',
        "pwd -P",
      ].join("\n"),
      { timeoutMs: 10_000 }
    )
  ).trim();
  if (!root.startsWith("/") || root.includes("\n")) {
    throw new Error("Remote Job state directory is not an absolute POSIX path");
  }
  return normalizeRemotePath(root);
};

const readRemoteJson = async <T>(
  sessionId: string,
  path: string,
  label: string
): Promise<T> => {
  const content = await readSshFile(sessionId, path);
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`Remote Job ${label} is invalid JSON`);
  }
};

const parseRemoteState = (value: unknown, expectedJobId: string): RemoteJobState => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== JOB_SCHEMA_VERSION ||
    value.jobId !== expectedJobId ||
    !isRemoteJobStatus(value.status) ||
    typeof value.revision !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Remote Job state is malformed");
  }
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: expectedJobId,
    status: value.status,
    revision: Math.max(0, Math.floor(value.revision)),
    backend: isBackendKind(value.backend) ? value.backend : undefined,
    runnerPid:
      typeof value.runnerPid === "number" && Number.isInteger(value.runnerPid)
        ? value.runnerPid
        : undefined,
    exitCode:
      typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
        ? value.exitCode
        : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    updatedAt: value.updatedAt,
    completedAt:
      typeof value.completedAt === "string" ? value.completedAt : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
};

const readRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  jobId: string
): Promise<RemoteJobState> =>
  parseRemoteState(
    await readRemoteJson<unknown>(sessionId, `${jobDirectory}/state.json`, "state"),
    jobId
  );

const writeRemoteState = async (
  sessionId: string,
  jobDirectory: string,
  previous: RemoteJobState,
  update: Partial<RemoteJobState>
): Promise<RemoteJobState> => {
  const next: RemoteJobState = {
    ...previous,
    ...update,
    schemaVersion: JOB_SCHEMA_VERSION,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeSshFile(sessionId, `${jobDirectory}/state.json`, `${JSON.stringify(next)}\n`);
  return next;
};

const getUnitName = (jobId: string): string =>
  `snow-app-job-${jobId.replace(/-/g, "")}`;

const getTmuxSessionName = (jobId: string): string =>
  `snow-app-${jobId.replace(/-/g, "")}`;

const runShell = (
  sessionId: string,
  script: string,
  timeoutMs = 15_000
): Promise<string> =>
  executeSshCommand(sessionId, `sh -lc ${shellQuote(script)}`, { timeoutMs });

const remoteBackends: Record<RemoteJobBackendKind, RemoteJobBackend> = {
  "snow-agent": {
    kind: "snow-agent",
    isAvailable: (capabilities) => capabilities.posixShell,
    supportsInteractiveAttach: true,
    async launch(context): Promise<void> {
      await launchSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory,
        context.jobId
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      return inspectSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory
      );
    },
    async cancel(context): Promise<void> {
      await cancelSnowAgentJob(
        context.sessionId,
        context.capabilities,
        context.jobDirectory
      );
    },
  },
  "systemd-user": {
    kind: "systemd-user",
    isAvailable: (capabilities) => capabilities.systemdUser,
    async launch(context): Promise<void> {
      const unit = getUnitName(context.jobId);
      const timeoutSeconds = Math.max(1, Math.ceil(context.timeoutMs / 1000));
      await runShell(
        context.sessionId,
        [
          "exec systemd-run --user --no-block --quiet",
          `--unit ${shellQuote(unit)}`,
          `--property=${shellQuote(`RuntimeMaxSec=${timeoutSeconds}`)}`,
          `--property=${shellQuote("KillMode=control-group")}`,
          `/bin/sh ${shellQuote(`${context.jobDirectory}/runner.sh`)}`,
        ].join(" ")
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const unit = getUnitName(context.jobId);
      const output = await runShell(
        context.sessionId,
        `if systemctl --user is-active --quiet ${shellQuote(
          unit
        )}; then printf active; else printf inactive; fi`
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      await runShell(
        context.sessionId,
        `systemctl --user stop ${shellQuote(getUnitName(context.jobId))} || true`
      );
    },
  },
  tmux: {
    kind: "tmux",
    isAvailable: (capabilities) => capabilities.tmux,
    supportsInteractiveAttach: true,
    async launch(context): Promise<void> {
      await runShell(
        context.sessionId,
        [
          "tmux -L snow-app -f /dev/null new-session -d",
          `-s ${shellQuote(getTmuxSessionName(context.jobId))}`,
          `/bin/sh ${shellQuote(`${context.jobDirectory}/runner.sh`)}`,
        ].join(" ")
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const output = await runShell(
        context.sessionId,
        `if tmux -L snow-app -f /dev/null has-session -t ${shellQuote(
          getTmuxSessionName(context.jobId)
        )} 2>/dev/null; then printf active; else printf inactive; fi`
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      await runShell(
        context.sessionId,
        `tmux -L snow-app -f /dev/null kill-session -t ${shellQuote(
          getTmuxSessionName(context.jobId)
        )} 2>/dev/null || true`
      );
    },
  },
  "posix-detach": {
    kind: "posix-detach",
    isAvailable: (capabilities) => capabilities.setsid && capabilities.nohup,
    async launch(context): Promise<void> {
      const output = await runShell(
        context.sessionId,
        `nohup setsid /bin/sh ${shellQuote(
          `${context.jobDirectory}/runner.sh`
        )} </dev/null >/dev/null 2>&1 & printf '%s' "$!"`
      );
      if (!/^\d+$/.test(output.trim())) {
        throw new Error("POSIX detached backend did not return a runner PID");
      }
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      if (!state.runnerPid) {
        return "inactive";
      }
      const output = await runShell(
        context.sessionId,
        `if kill -0 ${state.runnerPid} 2>/dev/null; then printf active; else printf inactive; fi`
      );
      return output.trim() === "active" ? "active" : "inactive";
    },
    async cancel(context): Promise<void> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      if (state.runnerPid) {
        await runShell(
          context.sessionId,
          `kill -TERM -- -${state.runnerPid} 2>/dev/null || kill -TERM ${state.runnerPid} 2>/dev/null || true`
        );
      }
    },
  },
  "windows-job": {
    kind: "windows-job",
    isAvailable: isWindowsRemote,
    async launch(context): Promise<void> {
      await launchWindowsRemoteJob(
        context.sessionId,
        `${context.jobDirectory}/runner.ps1`
      );
    },
    async inspect(context): Promise<"active" | "inactive"> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      return inspectWindowsRemoteJob(context.sessionId, state.runnerPid);
    },
    async cancel(context): Promise<void> {
      const state = await readRemoteState(
        context.sessionId,
        context.jobDirectory,
        context.jobId
      );
      await cancelWindowsRemoteJob(context.sessionId, state.runnerPid);
    },
  },
};

const buildCommandScript = (workingDirectory: string, command: string): string =>
  [
    "#!/bin/sh",
    "set -eu",
    `cd -- ${shellQuote(workingDirectory)}`,
    `exec /bin/sh -lc ${shellQuote(command)}`,
    "",
  ].join("\n");

const buildRunnerScript = (jobId: string, createdAt: string): string => [
  "#!/bin/sh",
  "set -eu",
  'job_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
  `job_id=${shellQuote(jobId)}`,
  `created_at=${shellQuote(createdAt)}`,
  'backend=$(cat "$job_dir/backend")',
  'timeout_ms=$(cat "$job_dir/timeout-ms")',
  'log_path="$job_dir/output.log"',
  'revision_path="$job_dir/revision"',
  'runner_pid="$$"',
  'printf "%s\\n" "$runner_pid" > "$job_dir/runner.pid"',
  "chmod 600 \"$job_dir/runner.pid\" 2>/dev/null || true",
  "ulimit -f 102400 2>/dev/null || true",
  "next_revision() {",
  '  current=$(cat "$revision_path" 2>/dev/null || printf 0)',
  '  current=$((current + 1))',
  '  printf "%s\\n" "$current" > "$revision_path"',
  '  printf "%s" "$current"',
  "}",
  "write_state() {",
  '  status="$1"',
  '  exit_code="${2:-null}"',
  '  reason="${3:-}"',
  '  revision=$(next_revision)',
  '  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")',
  '  completed=""',
  '  case "$status" in succeeded|failed|timed_out|cancelled|lost|launch_failed|indeterminate) completed=",\\"completedAt\\":\\"$now\\"" ;; esac',
  '  reason_json=""',
  '  if [ -n "$reason" ]; then reason_json=",\\"reason\\":\\"$reason\\"" ; fi',
  '  printf "{\\"schemaVersion\\":1,\\"jobId\\":\\"%s\\",\\"status\\":\\"%s\\",\\"revision\\":%s,\\"backend\\":\\"%s\\",\\"runnerPid\\":%s,\\"createdAt\\":\\"%s\\",\\"updatedAt\\":\\"%s\\"%s%s,\\"exitCode\\":%s}\\n" "$job_id" "$status" "$revision" "$backend" "$runner_pid" "$created_at" "$now" "$completed" "$reason_json" "$exit_code" > "$job_dir/state.json.tmp"',
  '  mv -f -- "$job_dir/state.json.tmp" "$job_dir/state.json"',
  "}",
  'write_state launching null ""',
  'write_state running null ""',
  'timeout_seconds=$(( (timeout_ms + 999) / 1000 ))',
  '( sleep "$timeout_seconds"; if [ -f "$job_dir/command.pid" ] && kill -0 "$(cat "$job_dir/command.pid")" 2>/dev/null; then touch "$job_dir/timeout.request"; kill -TERM "$(cat "$job_dir/command.pid")" 2>/dev/null || true; fi ) &',
  'watchdog_pid="$!"',
  '"/bin/sh" "$job_dir/command.sh" >> "$log_path" 2>&1 &',
  'command_pid="$!"',
  'printf "%s\\n" "$command_pid" > "$job_dir/command.pid"',
  'cancelled=0',
  'while kill -0 "$command_pid" 2>/dev/null; do',
  '  if [ -f "$job_dir/cancel.request" ]; then',
  '    cancelled=1',
  '    kill -TERM "$command_pid" 2>/dev/null || true',
  "  fi",
  "  sleep 1",
  "done",
  'wait "$command_pid" || exit_code="$?"',
  'exit_code="${exit_code:-0}"',
  'kill "$watchdog_pid" 2>/dev/null || true',
  'wait "$watchdog_pid" 2>/dev/null || true',
  'if [ -f "$job_dir/timeout.request" ]; then',
  '  write_state timed_out "$exit_code" "timeout"',
  'elif [ "$cancelled" -eq 1 ] || [ -f "$job_dir/cancel.request" ]; then',
  '  write_state cancelled "$exit_code" "cancelled"',
  'elif [ "$exit_code" -eq 0 ]; then',
  '  write_state succeeded 0 ""',
  "else",
  '  write_state failed "$exit_code" "exit"',
  "fi",
  "",
].join("\n");

const backendProbeScript = (markerPath: string): string =>
  `sleep 1; printf ok > ${shellQuote(markerPath)}`;

const windowsBackendProbeScript = (markerPath: string): string =>
  `Start-Sleep -Seconds 1; [System.IO.File]::WriteAllText('${markerPath.replace(
    /'/g,
    "''"
  )}', 'ok', [System.Text.Encoding]::ASCII)`;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const verifyBackendLiveness = async (
  workspacePath: string,
  backend: RemoteJobBackend,
  capabilities: SshCapabilities
): Promise<boolean> => {
  if (!backend.isAvailable(capabilities)) {
    return false;
  }
  const cacheKey = `${workspacePath}|${backend.kind}`;
  const cachedUntil = BACKEND_PROBE_CACHE.get(cacheKey);
  if (cachedUntil && cachedUntil > Date.now()) {
    return true;
  }

  const probeId = randomUUID();
  try {
    if (backend.kind === "snow-agent") {
      await withSshSession(workspacePath, async (sessionId) => {
        await negotiateSnowAgent(sessionId, capabilities);
        await probeSnowAgentLiveness(sessionId, capabilities);
      });
      BACKEND_PROBE_CACHE.set(cacheKey, Date.now() + BACKEND_PROBE_CACHE_MS);
      return true;
    }
    await withSshSession(workspacePath, async (sessionId) => {
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const marker = `${root}/.backend-probe-${probeId}`;
      const probeScript = backendProbeScript(marker);
      if (backend.kind === "systemd-user") {
        await runShell(
          sessionId,
          [
            "exec systemd-run --user --no-block --quiet",
            `--unit ${shellQuote(`snow-app-probe-${probeId.replace(/-/g, "")}`)}`,
            `/bin/sh -lc ${shellQuote(probeScript)}`,
          ].join(" ")
        );
      } else if (backend.kind === "tmux") {
        await runShell(
          sessionId,
          [
            "tmux -L snow-app -f /dev/null new-session -d",
            `-s ${shellQuote(`snow-probe-${probeId.replace(/-/g, "")}`)}`,
            `/bin/sh -lc ${shellQuote(probeScript)}`,
          ].join(" ")
        );
      } else if (backend.kind === "windows-job") {
        const encoded = powerShellEncodedCommand(windowsBackendProbeScript(marker));
        await runPowerShell(
          sessionId,
          `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -WindowStyle Hidden -PassThru; [Console]::Out.Write($process.Id)`
        );
      } else {
        await runShell(
          sessionId,
          `nohup setsid /bin/sh -lc ${shellQuote(
            probeScript
          )} </dev/null >/dev/null 2>&1 &`
        );
      }
    });
    await wait(1_250);
    await withSshSession(workspacePath, async (sessionId) => {
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const marker = `${root}/.backend-probe-${probeId}`;
      const content = await readSshFile(sessionId, marker);
      if (content.toString("utf8") !== "ok") {
        throw new Error("Remote backend did not survive the SSH disconnect");
      }
      if (capabilities.platform === "windows") {
        await removeWindowsRemotePath(sessionId, marker);
      } else {
        await runShell(sessionId, `rm -f -- ${shellQuote(marker)}`);
      }
    });
    BACKEND_PROBE_CACHE.set(cacheKey, Date.now() + BACKEND_PROBE_CACHE_MS);
    return true;
  } catch {
    return false;
  }
};

const selectBackend = async (
  workspacePath: string,
  requested: RemoteJobBackendKind | undefined
): Promise<RemoteJobBackend> => {
  const capabilities = await withSshSession(workspacePath, async (sessionId) =>
    probeSshCapabilities(sessionId)
  );
  const candidates = requested
    ? [remoteBackends[requested]]
    : capabilities.platform === "windows"
      ? [remoteBackends["windows-job"]]
      : [
          remoteBackends["snow-agent"],
          remoteBackends["systemd-user"],
          remoteBackends.tmux,
          remoteBackends["posix-detach"],
        ];
  for (const backend of candidates) {
    if (await verifyBackendLiveness(workspacePath, backend, capabilities)) {
      return backend;
    }
  }
  throw new Error(
    requested
      ? `Remote Job backend ${requested} is unavailable or failed disconnect verification`
      : "No Remote Job backend passed disconnect verification"
  );
};

const getRemoteOutput = async (
  sessionId: string,
  outputPath: string,
  offset: number,
  limit: number
): Promise<string> => {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const normalizedLimit = Math.min(
    MAX_OUTPUT_READ_BYTES,
    Math.max(1, Math.floor(limit))
  );
  const output = await readSshFileRange(sessionId, outputPath, {
    offset: normalizedOffset,
    length: normalizedLimit,
  });
  return output.toString("utf8");
};

const buildBinding = (params: {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  command: string;
  backend: RemoteJobBackendKind;
  jobTokenHash: string;
  createdAt: string;
  conversationId?: string;
  toolCallId?: string;
}): RemoteJobBinding => ({
  jobId: params.jobId,
  workspacePath: params.workspacePath,
  workspaceId: params.workspaceId,
  profileId: params.workspacePath.replace(/^ssh:\/\//, "").split("/")[0],
  commandHash: commandHash(params.command),
  displayCommand: redactCommand(params.command),
  backend: params.backend,
  jobTokenHash: params.jobTokenHash,
  createdAt: params.createdAt,
  updatedAt: params.createdAt,
  status: "preparing",
  revision: 0,
  conversationId: params.conversationId,
  toolCallId: params.toolCallId,
  lastOutputOffset: 0,
});

const readExistingJob = async (
  sessionId: string,
  jobDirectory: string,
  expected: RemoteJobBinding,
  trustedJobTokenHash?: string
): Promise<RemoteJobBinding> => {
  const manifest = await readRemoteJson<Record<string, unknown>>(
    sessionId,
    `${jobDirectory}/manifest.json`,
    "manifest"
  );
  if (
    manifest.jobId !== expected.jobId ||
    manifest.commandHash !== expected.commandHash ||
    manifest.workspacePath !== expected.workspacePath
  ) {
    throw new Error("JOB_ID_COLLISION: jobId already belongs to another command");
  }
  if (
    typeof manifest.jobTokenHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.jobTokenHash)
  ) {
    throw new Error("Remote Job manifest has an invalid cleanup token");
  }
  if (trustedJobTokenHash && manifest.jobTokenHash !== trustedJobTokenHash) {
    throw new Error("JOB_ID_COLLISION: jobId cleanup token does not match the local Binding");
  }
  const state = await readRemoteState(sessionId, jobDirectory, expected.jobId);
  return {
    ...expected,
    jobTokenHash: manifest.jobTokenHash,
    createdAt:
      typeof manifest.createdAt === "string"
        ? manifest.createdAt
        : expected.createdAt,
    backend:
      state.backend ??
      (isBackendKind(manifest.backend) ? manifest.backend : expected.backend),
    status: state.status,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
};

export const startRemoteJob = async (
  request: RemoteJobStartRequest
): Promise<RemoteJobBinding> => {
  const workspacePath = normalizeWorkspacePath(request.workspacePath);
  const command = request.command;
  if (!command.trim()) {
    throw new Error("Remote Job command is required");
  }
  if (Buffer.byteLength(command, "utf8") > 512 * 1024) {
    throw new Error("Remote Job command is too large");
  }
  const jobId = request.jobId?.trim() || randomUUID();
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  if (request.backend !== undefined && !isBackendKind(request.backend)) {
    throw new Error("Unknown Remote Job backend");
  }
  const timeoutMs = normalizeTimeout(request.timeoutMs);
  const existingBinding = getBinding(jobId);
  const requestedCommandHash = commandHash(command);
  if (
    existingBinding &&
    (existingBinding.workspacePath !== workspacePath ||
      existingBinding.commandHash !== requestedCommandHash)
  ) {
    throw new Error("JOB_ID_COLLISION: jobId already belongs to another command");
  }

  const createdAt = existingBinding?.createdAt ?? new Date().toISOString();
  const bindingFor = (backend: RemoteJobBackendKind): RemoteJobBinding =>
    buildBinding({
      jobId,
      workspacePath,
      workspaceId:
        existingBinding?.workspaceId ??
        request.workspaceId?.trim() ??
        workspacePath,
      command,
      backend,
      jobTokenHash:
        existingBinding?.jobTokenHash ??
        createHash("sha256").update(randomUUID()).digest("hex"),
      createdAt,
      conversationId:
        existingBinding?.conversationId ??
        request.conversationId?.trim() ??
        undefined,
      toolCallId:
        existingBinding?.toolCallId ?? request.toolCallId?.trim() ?? undefined,
    });

  const recoveryBinding = bindingFor(
    existingBinding?.backend ?? request.backend ?? "posix-detach"
  );

  const recovered = await withSshSession(workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    if (!(await remotePathExists(sessionId, jobDirectory))) {
      return null;
    }
    return readExistingJob(
      sessionId,
      jobDirectory,
      recoveryBinding,
      existingBinding?.jobTokenHash
    );
  });
  if (recovered) {
    upsertBinding(recovered);
    return recovered;
  }

  const backend = await selectBackend(workspacePath, request.backend);
  const binding = bindingFor(backend.kind);
  upsertBinding(binding);

  try {
    return await withSshSession(workspacePath, async (sessionId) => {
      const capabilities = await probeSshCapabilities(sessionId);
      const root = await getRemoteJobRoot(sessionId, capabilities);
      const jobDirectory = pathForJob(root, jobId);
      if (await remotePathExists(sessionId, jobDirectory)) {
        const recoveredExisting = await readExistingJob(
          sessionId,
          jobDirectory,
          binding,
          existingBinding?.jobTokenHash
        );
        upsertBinding(recoveredExisting);
        return recoveredExisting;
      }

      const temporaryDirectory = `${root}/.${jobId}.${randomUUID()}.tmp`;
      const manifest = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        jobTokenHash: binding.jobTokenHash,
        workspacePath,
        commandHash: binding.commandHash,
        displayCommand: binding.displayCommand,
        createdAt,
        timeoutMs,
        backend: backend.kind,
      };
      const agentRequest = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        jobTokenHash: binding.jobTokenHash,
        workspacePath,
        workingDirectory: normalizeRemotePath(
          workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/"
        ).replace(/^\/([A-Za-z]:\/)/, "$1"),
        command,
        timeoutMs,
        createdAt,
        resourceLimits: {
          maxLogBytes: 50 * 1024 * 1024,
          maxRuntimeMs: timeoutMs,
        },
      };
      const initialState: RemoteJobState = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        status: "preparing",
        revision: 0,
        backend: backend.kind,
        createdAt,
        updatedAt: createdAt,
      };

      await createRemoteJobDirectory(sessionId, capabilities, temporaryDirectory);
      const workingDirectory = normalizeRemotePath(
        workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/"
      ).replace(/^\/([A-Za-z]:\/)/, "$1");
      const jobFiles = capabilities.platform === "windows"
        ? [
            writeSshFile(
              sessionId,
              `${temporaryDirectory}/command.ps1`,
              buildWindowsCommandScript(workingDirectory)
            ),
            writeSshFile(sessionId, `${temporaryDirectory}/command.txt`, command),
            writeSshFile(
              sessionId,
              `${temporaryDirectory}/runner.ps1`,
              buildWindowsRunnerScript(jobId, createdAt)
            ),
          ]
        : [
            writeSshFile(
              sessionId,
              `${temporaryDirectory}/command.sh`,
              buildCommandScript(workingDirectory, command)
            ),
            writeSshFile(
              sessionId,
              `${temporaryDirectory}/runner.sh`,
              buildRunnerScript(jobId, createdAt)
            ),
          ];
      await Promise.all([
        ...jobFiles,
        writeSshFile(
          sessionId,
          `${temporaryDirectory}/manifest.json`,
          `${JSON.stringify(manifest)}\n`
        ),
        writeSshFile(
          sessionId,
          `${temporaryDirectory}/agent-request.json`,
          `${JSON.stringify(agentRequest)}\n`
        ),
        writeSshFile(sessionId, `${temporaryDirectory}/backend`, `${backend.kind}\n`),
        writeSshFile(sessionId, `${temporaryDirectory}/timeout-ms`, `${timeoutMs}\n`),
        writeSshFile(sessionId, `${temporaryDirectory}/revision`, "0\n"),
        writeSshFile(
          sessionId,
          `${temporaryDirectory}/state.json`,
          `${JSON.stringify(initialState)}\n`
        ),
        writeSshFile(sessionId, `${temporaryDirectory}/output.log`, ""),
      ]);
      if (capabilities.platform === "posix") {
        await runShell(
          sessionId,
          `chmod 700 -- ${shellQuote(
            `${temporaryDirectory}/command.sh`
          )} ${shellQuote(`${temporaryDirectory}/runner.sh`)} && chmod 600 -- ${shellQuote(
            `${temporaryDirectory}/manifest.json`
          )} ${shellQuote(`${temporaryDirectory}/agent-request.json`
          )} ${shellQuote(`${temporaryDirectory}/state.json`)} ${shellQuote(
            `${temporaryDirectory}/backend`
          )} ${shellQuote(`${temporaryDirectory}/timeout-ms`)}`
        );
      }
      try {
        await moveRemoteJobDirectory(
          sessionId,
          capabilities,
          temporaryDirectory,
          jobDirectory
        );
      } catch (error) {
        const existingAfterRace = await remotePathExists(sessionId, jobDirectory).catch(
          () => false
        );
        if (existingAfterRace) {
          const recoveredExisting = await readExistingJob(
            sessionId,
            jobDirectory,
            binding,
            existingBinding?.jobTokenHash
          );
          upsertBinding(recoveredExisting);
          return recoveredExisting;
        }
        throw error;
      }
      if (backend.kind !== "snow-agent") {
        await createRemoteJobDirectory(
          sessionId,
          capabilities,
          `${jobDirectory}/launch.lock`
        );
      }

      try {
        const launching = await writeRemoteState(
          sessionId,
          jobDirectory,
          initialState,
          { status: "launching", backend: backend.kind }
        );
        await backend.launch({
          sessionId,
          jobDirectory,
          jobId,
          timeoutMs,
          capabilities,
        });
        const accepted: RemoteJobBinding = {
          ...binding,
          status: launching.status,
          revision: launching.revision,
          updatedAt: launching.updatedAt,
        };
        upsertBinding(accepted);
        return accepted;
      } catch (error) {
        const current = await readRemoteState(sessionId, jobDirectory, jobId).catch(
          () => initialState
        );
        const failed = await writeRemoteState(sessionId, jobDirectory, current, {
          status: "launch_failed",
          reason: error instanceof Error ? error.message.slice(0, 300) : "launch failure",
        }).catch(() => ({
          ...current,
          status: "indeterminate" as const,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        }));
        const updated = {
          ...binding,
          status: failed.status,
          revision: failed.revision,
          updatedAt: failed.updatedAt,
          lastError: failed.reason,
        };
        upsertBinding(updated);
        throw error;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getBinding(jobId);
    if (current?.status === "preparing" || current?.status === "launching") {
      updateBinding(jobId, {
        status: "indeterminate",
        lastError: message,
      });
    }
    throw error;
  }
};

export const getRemoteJob = async (
  jobId: string,
  options?: { offset?: number; limit?: number }
): Promise<RemoteJobOutput> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  const offset = Math.max(0, Math.floor(options?.offset ?? binding.lastOutputOffset));
  const limit = Math.min(
    MAX_OUTPUT_READ_BYTES,
    Math.max(1, Math.floor(options?.limit ?? MAX_OUTPUT_READ_BYTES))
  );
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    let resolvedState = state;
    if (state.status === "running") {
      const backend = remoteBackends[state.backend ?? binding.backend];
      const activity = await backend
        .inspect({
          sessionId,
          jobDirectory,
          jobId,
          timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
          capabilities,
        })
        .catch(() => "active" as const);
      if (activity === "inactive") {
        resolvedState = await writeRemoteState(sessionId, jobDirectory, state, {
          status: "lost",
          reason: "backend inactive before a terminal state was recorded",
        });
      }
    }
    const output = await getRemoteOutput(
      sessionId,
      `${jobDirectory}/output.log`,
      offset,
      limit
    );
    const updated = {
      ...binding,
      backend: resolvedState.backend ?? binding.backend,
      status: resolvedState.status,
      revision: resolvedState.revision,
      updatedAt: resolvedState.updatedAt,
      lastOutputOffset: offset + Buffer.byteLength(output, "utf8"),
    };
    upsertBinding(updated);
    return {
      job: updated,
      state: resolvedState,
      output,
      offset,
      nextOffset: updated.lastOutputOffset,
      eof: Buffer.byteLength(output, "utf8") < limit,
    };
  });
};

export const listRemoteJobs = async (
  workspacePath?: string
): Promise<RemoteJobBinding[]> => {
  const normalizedWorkspace = workspacePath
    ? normalizeWorkspacePath(workspacePath)
    : undefined;
  const jobs = readBindings().filter(
    (job) => !normalizedWorkspace || job.workspacePath === normalizedWorkspace
  );
  const refreshed = await Promise.all(
    jobs.map(async (job) => {
      try {
        return (await getRemoteJob(job.jobId, { offset: job.lastOutputOffset, limit: 1 }))
          .job;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return updateBinding(job.jobId, { lastError: message }) ?? job;
      }
    })
  );
  return refreshed.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

export const cancelRemoteJob = async (jobId: string): Promise<RemoteJobBinding> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    if (TERMINAL_STATUSES.has(state.status)) {
      const unchanged = {
        ...binding,
        status: state.status,
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
      upsertBinding(unchanged);
      return unchanged;
    }
    await writeSshFile(sessionId, `${jobDirectory}/cancel.request`, "");
    await remoteBackends[state.backend ?? binding.backend].cancel({
      sessionId,
      jobDirectory,
      jobId,
      timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
      capabilities,
    });
    const cancelled = await writeRemoteState(sessionId, jobDirectory, state, {
      status: "cancelled",
      reason: "cancelled by user",
    });
    const updated = {
      ...binding,
      status: cancelled.status,
      revision: cancelled.revision,
      updatedAt: cancelled.updatedAt,
    };
    upsertBinding(updated);
    return updated;
  });
};

export const getRemoteJobAttachSpec = async (
  jobId: string
): Promise<RemoteJobAttachSpec> => {
  if (!isJobId(jobId)) {
    throw new Error("Remote Job jobId must be a UUID");
  }
  const binding = getBinding(jobId);
  if (!binding) {
    throw new Error("Remote Job binding was not found");
  }
  return withSshSession(binding.workspacePath, async (sessionId) => {
    const capabilities = await probeSshCapabilities(sessionId);
    const root = await getRemoteJobRoot(sessionId, capabilities);
    const jobDirectory = pathForJob(root, jobId);
    const state = await readRemoteState(sessionId, jobDirectory, jobId);
    const backendKind = state.backend ?? binding.backend;
    const backend = remoteBackends[backendKind];
    if (!backend.supportsInteractiveAttach) {
      throw new Error(`Remote Job backend ${backendKind} does not support interactive attach`);
    }
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new Error("Cannot attach to a completed Remote Job");
    }
    if (backendKind === "tmux") {
      return {
        jobId,
        workspacePath: binding.workspacePath,
        backend: backendKind,
        remoteCommand: `tmux -L snow-app -f /dev/null attach-session -t ${shellQuote(
          getTmuxSessionName(jobId)
        )}`,
      };
    }
    if (backendKind === "snow-agent") {
      const agent = await negotiateSnowAgent(sessionId, capabilities);
      if (!agent.capabilities.interactiveAttach) {
        throw new Error("The negotiated snow-agent release does not support interactive attach");
      }
      const remoteCommand =
        capabilities.platform === "windows"
          ? `snow-agent.exe job attach --job-directory \"${jobDirectory.replace(
              /\"/g,
              '\\\"'
            )}\"`
          : `snow-agent job attach --job-directory ${shellQuote(jobDirectory)}`;
      return {
        jobId,
        workspacePath: binding.workspacePath,
        backend: backendKind,
        remoteCommand,
      };
    }
    throw new Error(`Remote Job backend ${backendKind} has no attach command`);
  });
};

export const getRemoteJobAnalysisContext = async (
  jobId: string,
  options?: { offset?: number; limit?: number }
): Promise<string> => {
  const result = await getRemoteJob(jobId, options);
  return JSON.stringify(
    {
      jobId: result.job.jobId,
      workspacePath: result.job.workspacePath,
      command: result.job.displayCommand,
      backend: result.job.backend,
      state: result.state,
      offset: result.offset,
      nextOffset: result.nextOffset,
      output: result.output,
    },
    null,
    2
  );
};

export const cleanupRemoteJobs = async (): Promise<{ removed: string[] }> => {
  const now = Date.now();
  const jobs = readBindings();
  const retained: RemoteJobBinding[] = [];
  const removed: string[] = [];
  for (const job of jobs) {
    const retention =
      job.status === "succeeded" ? SUCCESS_RETENTION_MS : FAILURE_RETENTION_MS;
    const age = now - Date.parse(job.updatedAt);
    if (!TERMINAL_STATUSES.has(job.status) || !Number.isFinite(age) || age < retention) {
      retained.push(job);
      continue;
    }
    try {
      await withSshSession(job.workspacePath, async (sessionId) => {
        const capabilities = await probeSshCapabilities(sessionId);
        const root = await getRemoteJobRoot(sessionId, capabilities);
        const jobDirectory = pathForJob(root, job.jobId);
        const manifest = await readRemoteJson<Record<string, unknown>>(
          sessionId,
          `${jobDirectory}/manifest.json`,
          "manifest"
        );
        if (
          manifest.jobId !== job.jobId ||
          manifest.jobTokenHash !== job.jobTokenHash
        ) {
          throw new Error("Remote Job cleanup token mismatch");
        }
        await removeRemoteJobPath(sessionId, capabilities, jobDirectory);
      });
      removed.push(job.jobId);
    } catch {
      retained.push(job);
    }
  }
  writeBindings(retained);
  return { removed };
};

export const getRemoteJobBackendsForTesting = (): Record<
  RemoteJobBackendKind,
  RemoteJobBackend
> => remoteBackends;
