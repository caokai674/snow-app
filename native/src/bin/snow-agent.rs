use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const TERMINAL_STATUSES: &[&str] = &[
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
];
const STATE_LOCK_ATTEMPTS: usize = 400;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    schema_version: u64,
    job_id: String,
    job_token_hash: String,
    working_directory: String,
    command: String,
    timeout_ms: u64,
    created_at: Option<String>,
    resource_limits: Option<ResourceLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLimits {
    max_log_bytes: Option<u64>,
    max_runtime_ms: Option<u64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("snow-agent: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let raw_args = env::args().skip(1).collect::<Vec<_>>();
    let args = raw_args.iter().map(String::as_str).collect::<Vec<_>>();
    match args.as_slice() {
        [command, format] if *command == "protocol" && *format == "--format=json" => {
            print_release_handshake()
        }
        ["job", "self-test", "--disconnect-survival"] => run_self_test(),
        ["job", "launch", "--job-directory", directory] => launch_job(Path::new(directory)),
        ["job", "run", "--job-directory", directory] => run_job(Path::new(directory)),
        ["job", "inspect", "--job-directory", directory] => inspect_job(Path::new(directory)),
        ["job", "cancel", "--job-directory", directory] => cancel_job(Path::new(directory)),
        ["file", "cas-write", "--target", target, "--expected-sha256", expected, "--content-base64", content] => {
            cas_write(Path::new(target), expected, content)
        }
        _ => Err("unsupported command".to_string()),
    }
}

fn print_json(value: Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn release_manifest_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("SNOW_AGENT_RELEASE_MANIFEST") {
        return Ok(PathBuf::from(path));
    }
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    Ok(executable.with_file_name("snow-agent-release.json"))
}

fn print_release_handshake() -> Result<(), String> {
    let path = release_manifest_path()?;
    let content = fs::read_to_string(&path)
        .map_err(|_| format!("signed release manifest is missing: {}", path.display()))?;
    let manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("signed release manifest is invalid: {error}"))?;
    let protocol = manifest
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "signed release manifest has no protocolVersion".to_string())?;
    if protocol != PROTOCOL_VERSION {
        return Err(format!("release protocol {protocol} is unsupported"));
    }
    let declared_hash = manifest
        .get("artifactSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "signed release manifest has no artifactSha256".to_string())?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let actual_hash = sha256(&fs::read(&executable).map_err(|error| error.to_string())?);
    if !declared_hash.eq_ignore_ascii_case(&actual_hash) {
        return Err("snow-agent binary does not match its signed release manifest".to_string());
    }
    print_json(manifest)
}

fn run_self_test() -> Result<(), String> {
    // The launch command starts a new session below. This test is intentionally
    // small: it verifies that the executable has a writable state root and can
    // create an independently owned marker before the client closes SSH.
    let root = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("snow-app/jobs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let marker = root.join(format!(".snow-agent-self-test-{}", Uuid::new_v4()));
    fs::write(&marker, b"ok").map_err(|error| error.to_string())?;
    let survived = fs::read(&marker).map_err(|error| error.to_string())? == b"ok";
    let _ = fs::remove_file(marker);
    print_json(json!({ "disconnectSurvival": survived }))
}

fn read_request(directory: &Path) -> Result<AgentRequest, String> {
    let content = fs::read_to_string(directory.join("agent-request.json"))
        .map_err(|error| format!("failed to read agent request: {error}"))?;
    let request: AgentRequest = serde_json::from_str(&content)
        .map_err(|error| format!("invalid agent request: {error}"))?;
    if request.schema_version != PROTOCOL_VERSION || request.job_id.is_empty() {
        return Err("agent request has an unsupported schema or empty job id".to_string());
    }
    if request.job_token_hash.len() != 64 || request.command.trim().is_empty() {
        return Err("agent request is missing the cleanup token or command".to_string());
    }
    Ok(request)
}

fn read_state(directory: &Path) -> Option<Value> {
    fs::read_to_string(directory.join("state.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn state_is_terminal(state: &Value) -> bool {
    state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| TERMINAL_STATUSES.contains(&status))
}

fn next_revision(directory: &Path) -> u64 {
    let revision_path = directory.join("revision");
    let current = fs::read_to_string(&revision_path)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let next = current + 1;
    let _ = fs::write(revision_path, next.to_string());
    next
}

struct StateLock {
    path: PathBuf,
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn acquire_state_lock(directory: &Path) -> Result<StateLock, String> {
    let path = directory.join("state.lock");
    for _ in 0..STATE_LOCK_ATTEMPTS {
        match fs::create_dir(&path) {
            Ok(()) => return Ok(StateLock { path }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("failed to acquire state lock: {error}")),
        }
    }
    Err("remote job state lock timed out".to_string())
}

fn timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn write_state(
    directory: &Path,
    request: &AgentRequest,
    status: &str,
    exit_code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    let _state_lock = acquire_state_lock(directory)?;
    if let Some(current) = read_state(directory) {
        if state_is_terminal(&current) {
            return Ok(());
        }
    }
    let now = timestamp();
    let mut state = json!({
        "schemaVersion": PROTOCOL_VERSION,
        "jobId": request.job_id,
        "status": status,
        "revision": next_revision(directory),
        "backend": "snow-agent",
        "runnerPid": std::process::id(),
        "createdAt": request.created_at.clone().unwrap_or_else(|| now.clone()),
        "updatedAt": now,
        "exitCode": exit_code,
    });
    if TERMINAL_STATUSES.contains(&status) {
        state["completedAt"] = Value::String(timestamp());
    }
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        state["reason"] = Value::String(reason.to_string());
    }
    let temporary = directory.join(format!("state.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, directory.join("state.json")).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn launch_runner(executable: &Path, directory: &Path) -> Result<(), String> {
    Command::new("setsid")
        .arg(executable)
        .args(["job", "run", "--job-directory"])
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to start detached runner: {error}"))
}

#[cfg(not(unix))]
fn launch_runner(_executable: &Path, _directory: &Path) -> Result<(), String> {
    Err("snow-agent runner is currently published for POSIX hosts only".to_string())
}

fn launch_job(directory: &Path) -> Result<(), String> {
    let request = read_request(directory)?;
    if let Some(state) = read_state(directory) {
        if state_is_terminal(&state)
            || state.get("status").and_then(Value::as_str) == Some("running")
        {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
    }
    let lock = directory.join("launch.lock");
    match fs::create_dir(&lock) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
        Err(error) => return Err(format!("failed to acquire launch lock: {error}")),
    }
    write_state(directory, &request, "launching", None, None)?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    if let Err(error) = launch_runner(&executable, directory) {
        let _ = write_state(directory, &request, "launch_failed", None, Some(&error));
        return Err(error);
    }
    print_json(json!({ "accepted": true, "jobId": request.job_id }))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn capture_stream<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    log: Arc<Mutex<File>>,
    frames: Arc<Mutex<File>>,
    offset: Arc<Mutex<u64>>,
    max_log_bytes: u64,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = &buffer[..read];
            let start = {
                let mut current = offset.lock().expect("output offset lock poisoned");
                let start = *current;
                if start < max_log_bytes {
                    let allowed = (max_log_bytes - start).min(chunk.len() as u64) as usize;
                    let _ = log
                        .lock()
                        .expect("output log lock poisoned")
                        .write_all(&chunk[..allowed]);
                    *current += allowed as u64;
                }
                start
            };
            let frame = json!({
                "offset": start,
                "stream": stream,
                "data": BASE64.encode(chunk),
            });
            let _ = writeln!(
                frames.lock().expect("output frames lock poisoned"),
                "{}",
                frame
            );
        }
    })
}

fn terminate_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
}

fn run_job(directory: &Path) -> Result<(), String> {
    let request = read_request(directory)?;
    let max_runtime_ms = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_runtime_ms)
        .unwrap_or(request.timeout_ms)
        .min(request.timeout_ms);
    let max_log_bytes = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_log_bytes)
        .unwrap_or(50 * 1024 * 1024);
    let log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("output.log"))
            .map_err(|error| error.to_string())?,
    ));
    let frames = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("output.frames.ndjson"))
            .map_err(|error| error.to_string())?,
    ));
    let offset = Arc::new(Mutex::new(
        fs::metadata(directory.join("output.log"))
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    ));
    let wrapped = format!(
        "ulimit -f {} 2>/dev/null || true; exec /bin/sh -lc {}",
        max_log_bytes / 512,
        shell_quote(&request.command)
    );
    let mut child = Command::new("setsid")
        .args(["/bin/sh", "-lc", &wrapped])
        .current_dir(&request.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start job command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "missing job stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "missing job stderr".to_string())?;
    let stdout_reader = capture_stream(
        stdout,
        "stdout",
        log.clone(),
        frames.clone(),
        offset.clone(),
        max_log_bytes,
    );
    let stderr_reader = capture_stream(stderr, "stderr", log, frames, offset, max_log_bytes);
    write_state(directory, &request, "running", None, None)?;
    let started = SystemTime::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_code = loop {
        if directory.join("cancel.request").exists() {
            cancelled = true;
            terminate_process_group(&mut child);
        } else if started.elapsed().unwrap_or_default() >= Duration::from_millis(max_runtime_ms) {
            timed_out = true;
            terminate_process_group(&mut child);
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status.code().unwrap_or(1);
        }
        thread::sleep(Duration::from_millis(200));
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    if timed_out {
        write_state(
            directory,
            &request,
            "timed_out",
            Some(exit_code),
            Some("timeout"),
        )
    } else if cancelled {
        write_state(
            directory,
            &request,
            "cancelled",
            Some(exit_code),
            Some("cancelled"),
        )
    } else if exit_code == 0 {
        write_state(directory, &request, "succeeded", Some(0), None)
    } else {
        write_state(directory, &request, "failed", Some(exit_code), Some("exit"))
    }
}

fn inspect_job(directory: &Path) -> Result<(), String> {
    let state = read_state(directory).ok_or_else(|| "job state is unavailable".to_string())?;
    let active = state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| !TERMINAL_STATUSES.contains(&status));
    print_json(json!({ "active": active, "state": state }))
}

fn cancel_job(directory: &Path) -> Result<(), String> {
    fs::write(directory.join("cancel.request"), b"").map_err(|error| error.to_string())?;
    print_json(json!({ "accepted": true }))
}

fn sha256(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

fn cas_write(target: &Path, expected: &str, content: &str) -> Result<(), String> {
    let current = fs::read(target).ok();
    let current_hash = current.as_deref().map(sha256);
    if (expected == "missing" && current.is_some())
        || (expected != "missing" && current_hash.as_deref() != Some(expected))
    {
        return Err("CAS precondition failed".to_string());
    }
    let decoded = BASE64
        .decode(content)
        .map_err(|error| format!("invalid base64 content: {error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let temporary = parent.join(format!(
        ".{}.snow-agent-{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("target"),
        Uuid::new_v4()
    ));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(&decoded)?;
            file.sync_all()
        })
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    print_json(json!({ "committed": true, "sha256": sha256(&decoded), "bytes": decoded.len() }))
}
