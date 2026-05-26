// v0.6.1
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Command as Proc, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
};
use serde::Deserialize;
use tauri::{
    command, AppHandle, Emitter, Manager, State,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
};
use tokio_cron_scheduler::{Job, JobScheduler};
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

// ── State ──────────────────────────────────────────────────────────────────

type PidMap = Arc<Mutex<HashMap<String, u32>>>;

#[derive(Deserialize)]
struct ExecOpts {
    id:      String,
    program: String,
    args:    Vec<String>,
    cwd:     Option<String>,
}

// ── exec_node ──────────────────────────────────────────────────────────────

#[command]
async fn exec_node(
    app:  AppHandle,
    pids: State<'_, PidMap>,
    opts: ExecOpts,
) -> Result<i32, String> {
    let mut cmd = Proc::new(&opts.program);
    cmd.args(&opts.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if let Some(ref cwd) = opts.cwd {
        if !cwd.trim().is_empty() { cmd.current_dir(cwd); }
    }

    // Hide the console window on Windows so child processes don't pop up.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("failed to start '{}': {}", opts.program, e))?;

    pids.inner().clone().lock().unwrap().insert(opts.id.clone(), child.id());

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone(); let id2 = opts.id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let _ = app2.emit(&format!("exec-out-{id2}"), line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app2 = app.clone(); let id2 = opts.id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                let _ = app2.emit(&format!("exec-err-{id2}"), line);
            }
        });
    }

    let run_id   = opts.id.clone();
    let pids_arc = pids.inner().clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        child.wait().map(|s| s.code().unwrap_or(-1)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    pids_arc.lock().unwrap().remove(&run_id);
    Ok(code)
}

// ── kill_exec ──────────────────────────────────────────────────────────────

#[command]
fn kill_exec(pids: State<'_, PidMap>, id: String) {
    if let Some(pid) = pids.inner().clone().lock().unwrap().remove(&id) {
        #[cfg(windows)]
        let _ = Proc::new("taskkill").args(["/PID", &pid.to_string(), "/F", "/T"]).spawn();
        #[cfg(not(windows))]
        let _ = Proc::new("kill").arg(pid.to_string()).spawn();
    }
}

// ── get_cwd ────────────────────────────────────────────────────────────────
//
// Returns the process working directory.  Used to seed the default work
// directory on first launch.

#[command]
fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

// ── Windows autostart (bypasses tauri-plugin-autostart to ensure quoted path) ─

#[cfg(target_os = "windows")]
const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_NAME: &str = "Autoflow";

#[command]
fn autostart_enable(minimized: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = exe.to_string_lossy().to_string();
        // Always quote the path so spaces in "Program Files" don't break startup.
        // Append --minimized when the user wants the app to start hidden in the tray.
        let value = if minimized {
            format!("\"{}\" --minimized", path)
        } else {
            format!("\"{}\"", path)
        };
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey_with_flags(AUTOSTART_KEY, KEY_SET_VALUE)
            .map_err(|e| e.to_string())?;
        key.set_value(AUTOSTART_NAME, &value).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
fn autostart_is_minimized() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(AUTOSTART_KEY) {
            if let Ok(val) = key.get_value::<String, _>(AUTOSTART_NAME) {
                return val.contains("--minimized");
            }
        }
        return false;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[command]
fn autostart_disable() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok((key, _)) = hkcu.create_subkey_with_flags(AUTOSTART_KEY, KEY_SET_VALUE) {
            let _ = key.delete_value(AUTOSTART_NAME); // ignore "not found"
        }
    }
    Ok(())
}

#[command]
fn autostart_is_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(AUTOSTART_KEY) {
            return key.get_value::<String, _>(AUTOSTART_NAME).is_ok();
        }
        return false;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

// ── Launch App node (fire-and-forget process spawn + focus) ──────────────

#[command]
fn launch_app(program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let mut cmd = Proc::new(&program);
    cmd.args(&args);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
    }
    cmd.spawn().map_err(|e| format!("failed to launch '{}': {}", program, e))?;
    Ok(())
}

// ── Generic text file IO (used by flow import/export) ─────────────────────

#[command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

#[derive(Deserialize)]
struct WriteTextFileOpts {
    path:    String,
    content: String,
}

#[command]
fn write_text_file(opts: WriteTextFileOpts) -> Result<(), String> {
    use std::path::Path;
    let p = Path::new(opts.path.trim());
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
        }
    }
    std::fs::write(p, &opts.content).map_err(|e| format!("write {}: {e}", p.display()))
}

// ── Workspace + persistence ────────────────────────────────────────────────
//
// User-owned content (flows) lives in a **workspace** directory chosen on
// first run, defaulting to `<Documents>/Autoflow`. The path is recorded in
// `<appData>/workspace.json` — machine-local, not synced.
//
// Layout inside the workspace:
//   <workspace>/flows/<id>.json   — one file per flow
//   <workspace>/flows/.seeded     — marker; demo flows are written once
//
// Anything else stays in appData (window state, scheduler state, etc.).

#[derive(serde::Serialize, serde::Deserialize)]
struct WorkspaceMarker { path: String }

fn workspace_marker_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("workspace.json"))
}

fn read_workspace_path(app: &AppHandle) -> Result<Option<String>, String> {
    let marker = workspace_marker_path(app)?;
    if !marker.exists() { return Ok(None); }
    let text = std::fs::read_to_string(&marker).map_err(|e| format!("read marker: {e}"))?;
    let m: WorkspaceMarker = serde_json::from_str(&text).map_err(|e| format!("parse marker: {e}"))?;
    Ok(Some(m.path))
}

fn workspace_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let path = read_workspace_path(app)?
        .ok_or_else(|| "Workspace not configured (run the welcome screen first).".to_string())?;
    let p = std::path::PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("Workspace path no longer exists: {path}"));
    }
    Ok(p)
}

#[command]
fn get_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let path = match read_workspace_path(&app)? { Some(p) => p, None => return Ok(None) };
    // If the user moved/deleted the folder, treat the workspace as unset so
    // the welcome screen re-prompts instead of erroring forever.
    if !std::path::Path::new(&path).is_dir() { return Ok(None); }
    Ok(Some(path))
}

#[command]
fn set_workspace(app: AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() { return Err("Workspace path is empty".into()); }
    let root = std::path::PathBuf::from(trimmed);
    std::fs::create_dir_all(root.join("flows"))
        .map_err(|e| format!("mkdir flows: {e}"))?;

    let appdata = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&appdata).map_err(|e| format!("mkdir appData: {e}"))?;
    let marker  = appdata.join("workspace.json");
    let payload = serde_json::to_string_pretty(&WorkspaceMarker { path: trimmed.to_string() })
        .map_err(|e| format!("serialize marker: {e}"))?;
    std::fs::write(&marker, payload).map_err(|e| format!("write marker: {e}"))?;
    Ok(root.to_string_lossy().into_owned())
}

#[command]
fn suggested_workspace_path(app: AppHandle) -> Result<String, String> {
    let base = app.path().document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("default workspace base: {e}"))?;
    Ok(base.join("Autoflow").to_string_lossy().into_owned())
}

/* ── Legacy migration (one-shot) ────────────────────────────────────────── */

#[derive(serde::Serialize)]
struct LegacySummary { flows: usize, root: String }

fn legacy_subdir(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join(name))
}

#[command]
fn legacy_appdata_summary(app: AppHandle) -> Result<LegacySummary, String> {
    let root = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    let flows = legacy_subdir(&app, "flows")?;
    let count_ext = |dir: &std::path::Path, ext: &str| -> usize {
        std::fs::read_dir(dir).ok().map(|it| {
            it.filter_map(|e| e.ok())
              .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some(ext))
              .count()
        }).unwrap_or(0)
    };
    Ok(LegacySummary {
        flows: count_ext(&flows, "json"),
        root:  root.to_string_lossy().into_owned(),
    })
}

#[derive(serde::Serialize)]
struct MigrationResult { moved_flows: usize }

/// Move `<appData>/flows/*.json` into the workspace's `flows/` folder.
/// Also moves the `.seeded` marker so we don't re-seed.
#[command]
fn migrate_legacy_to_workspace(app: AppHandle) -> Result<MigrationResult, String> {
    let ws = workspace_dir(&app)?;
    let mut moved_flows = 0usize;

    let src_flows = legacy_subdir(&app, "flows")?;
    let dst_flows = ws.join("flows");
    std::fs::create_dir_all(&dst_flows).map_err(|e| format!("mkdir target: {e}"))?;
    if src_flows.is_dir() {
        for entry in std::fs::read_dir(&src_flows).map_err(|e| format!("read {}: {e}", src_flows.display()))? {
            let entry = match entry { Ok(e) => e, Err(_) => continue };
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) { Some(s) => s.to_string(), None => continue };
            let is_flow_file = p.extension().and_then(|s| s.to_str()) == Some("json");
            let is_marker    = name == ".seeded";
            if !(is_flow_file || is_marker) { continue; }
            let target = dst_flows.join(&name);
            if target.exists() { continue; }
            if std::fs::rename(&p, &target).is_err() {
                std::fs::copy(&p, &target).map_err(|e| format!("copy {name}: {e}"))?;
                let _ = std::fs::remove_file(&p);
            }
            if is_flow_file { moved_flows += 1; }
        }
    }

    Ok(MigrationResult { moved_flows })
}

fn flows_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = workspace_dir(app)?.join("flows");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir)
}

#[command]
fn flows_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(flows_dir(&app)?.to_string_lossy().into_owned())
}

#[command]
fn flows_seeded(app: AppHandle) -> Result<bool, String> {
    let dir = flows_dir(&app)?;
    Ok(dir.join(".seeded").exists())
}

#[command]
fn mark_flows_seeded(app: AppHandle) -> Result<(), String> {
    let dir = flows_dir(&app)?;
    std::fs::write(dir.join(".seeded"), b"1")
        .map_err(|e| format!("write marker: {e}"))
}

#[command]
fn list_flow_files(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = flows_dir(&app)?;
    let mut out: Vec<String> = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = match entry { Ok(e) => e, Err(_) => continue };
        let path  = entry.path();
        if !path.is_file() { continue; }
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        match std::fs::read_to_string(&path) {
            Ok(text) => out.push(text),
            Err(e)   => eprintln!("skip {}: {e}", path.display()),
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFlowOpts {
    id:      String,
    content: String,
}

fn safe_flow_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() { return Err("flow id is empty".into()); }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("flow id contains illegal characters".into());
    }
    Ok(id.to_string())
}

#[command]
fn save_flow_file(app: AppHandle, opts: SaveFlowOpts) -> Result<(), String> {
    let id   = safe_flow_id(&opts.id)?;
    let dir  = flows_dir(&app)?;
    let path = dir.join(format!("{id}.json"));
    // Atomic write: temp file then rename so a crash mid-write can't corrupt
    // the on-disk flow.
    let tmp = dir.join(format!(".{id}.json.tmp"));
    std::fs::write(&tmp, &opts.content).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[command]
fn delete_flow_file(app: AppHandle, id: String) -> Result<(), String> {
    let id   = safe_flow_id(&id)?;
    let path = flows_dir(&app)?.join(format!("{id}.json"));
    if !path.exists() { return Ok(()); }
    std::fs::remove_file(&path).map_err(|e| format!("delete: {e}"))
}

// ── Scheduler ──────────────────────────────────────────────────────────────
//
// The cron scheduler runs in the Rust backend so that schedules survive the
// window being hidden to the tray (Step 3). On each fire we emit a
// `flow-fire` event with the flow id; the frontend's `cronService` listens
// and invokes the regular flow runner.
//
// `last_fired` is persisted to `<appData>/scheduler-state.json` (machine
// state — not workspace — so syncing across machines doesn't double-fire).
// On reload we honor the per-flow catch-up policy ('skip' | 'run-once' |
// 'run-all') by emitting up to N immediate `flow-fire` events for ticks
// that elapsed while the app was closed.

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledFlow {
    pub flow_id:   String,
    pub cron:      String,
    /// "skip" | "run-once" | "run-all"
    #[serde(default)]
    pub catch_up:  String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowJobState {
    pub flow_id:    String,
    pub cron:       String,
    pub next_fire:  Option<i64>,
    pub last_fired: Option<i64>,
}

pub struct SchedulerState {
    scheduler:  TokioMutex<Option<JobScheduler>>,
    jobs:       TokioMutex<HashMap<String, (Uuid, String, String)>>, // flow_id -> (uuid, cron, catchUp)
    last_fired: Mutex<HashMap<String, i64>>,
}

impl SchedulerState {
    fn new() -> Self {
        Self {
            scheduler:  TokioMutex::new(None),
            jobs:       TokioMutex::new(HashMap::new()),
            last_fired: Mutex::new(HashMap::new()),
        }
    }
}

fn scheduler_state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("scheduler-state.json"))
}

fn load_last_fired(app: &AppHandle) -> HashMap<String, i64> {
    let Ok(path) = scheduler_state_path(app) else { return HashMap::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return HashMap::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_last_fired(app: &AppHandle, map: &HashMap<String, i64>) {
    let Ok(path) = scheduler_state_path(app) else { return };
    if let Ok(text) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(&path, text);
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Promote a 5-field UNIX cron (min hour dom month dow) to the 6-field form
/// (sec min hour dom month dow) that tokio-cron-scheduler and the `cron` crate
/// both require. If the expression already has 6 or more fields, it is returned
/// unchanged so existing 6-field expressions still work.
fn normalize_cron(expr: &str) -> String {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() == 5 {
        format!("0 {}", expr)   // prepend "second 0"
    } else {
        expr.to_string()
    }
}

/// Compute the most recent past tick for a cron expression, or None if
/// the expression is unparseable / has no past occurrence. Uses the system
/// local timezone so it agrees with the live scheduler.
fn previous_tick(expr: &str) -> Option<chrono::DateTime<chrono::Local>> {
    use std::str::FromStr;
    let normalized = normalize_cron(expr);
    let schedule = cron::Schedule::from_str(&normalized).ok()?;
    let now = chrono::Local::now();
    let mut last: Option<chrono::DateTime<chrono::Local>> = None;
    for t in schedule.after(&(now - chrono::Duration::days(7))) {
        if t > now { break; }
        last = Some(t);
    }
    last
}

#[command]
async fn scheduler_reload(
    app:    AppHandle,
    state:  State<'_, Arc<SchedulerState>>,
    flows:  Vec<ScheduledFlow>,
) -> Result<(), String> {
    let state: Arc<SchedulerState> = (*state).clone();
    eprintln!("[scheduler_reload] called with {} flow(s)", flows.len());
    for f in &flows {
        eprintln!("[scheduler_reload]   - flow={} cron={:?} catch_up={:?}", f.flow_id, f.cron, f.catch_up);
    }
    // Lazy-init scheduler on first call.
    let mut sched_guard = state.scheduler.lock().await;
    if sched_guard.is_none() {
        eprintln!("[scheduler_reload] lazy-init JobScheduler");
        let s = JobScheduler::new().await.map_err(|e| format!("scheduler init: {e}"))?;
        s.start().await.map_err(|e| format!("scheduler start: {e}"))?;
        eprintln!("[scheduler_reload] JobScheduler started");
        *sched_guard = Some(s);
        // Load persisted last_fired on first init.
        let loaded = load_last_fired(&app);
        eprintln!("[scheduler_reload] loaded {} last_fired entries from disk", loaded.len());
        *state.last_fired.lock().unwrap() = loaded;
    }
    let scheduler = sched_guard.as_ref().unwrap().clone();
    drop(sched_guard);

    // Remove all existing jobs.
    let mut jobs = state.jobs.lock().await;
    for (_flow_id, (uuid, _, _)) in jobs.drain() {
        let _ = scheduler.remove(&uuid).await;
    }

    // Snapshot last_fired for catch-up evaluation.
    let last_fired_snapshot = state.last_fired.lock().unwrap().clone();

    for f in flows {
        let flow_id  = f.flow_id.clone();
        let cron_raw = f.cron.trim().to_string();
        let cron     = normalize_cron(&cron_raw); // always 6-field for tokio-cron-scheduler
        let catch_up = if f.catch_up.is_empty() { "skip".to_string() } else { f.catch_up.clone() };
        if cron_raw.is_empty() { continue; }

        // Catch-up evaluation: if the most recent past tick is newer than
        // last_fired (and last_fired exists), emit one immediate fire.
        if catch_up != "skip" {
            let last = last_fired_snapshot.get(&flow_id).copied();
            if let (Some(prev), Some(last_ms)) = (previous_tick(&cron_raw), last) {
                if prev.timestamp_millis() > last_ms {
                    let ts = now_ms();
                    state.last_fired.lock().unwrap().insert(flow_id.clone(), ts);
                    save_last_fired(&app, &state.last_fired.lock().unwrap());
                    let _ = app.emit("flow-fire", serde_json::json!({
                        "flowId":      flow_id,
                        "scheduledAt": ts,
                        "catchUp":     true,
                    }));
                }
            }
        }

        let app_for_job = app.clone();
        let state_for_job = Arc::clone(&state);
        let flow_id_for_job = flow_id.clone();

        let job = Job::new_async_tz(cron.as_str(), chrono::Local, move |_uuid, _l| {
            let app = app_for_job.clone();
            let state = Arc::clone(&state_for_job);
            let fid = flow_id_for_job.clone();
            Box::pin(async move {
                eprintln!("[scheduler] FIRE flow={}", fid);
                let ts = now_ms();
                {
                    let mut lf = state.last_fired.lock().unwrap();
                    lf.insert(fid.clone(), ts);
                    save_last_fired(&app, &lf);
                }
                let r = app.emit("flow-fire", serde_json::json!({
                    "flowId":      fid,
                    "scheduledAt": ts,
                    "catchUp":     false,
                }));
                eprintln!("[scheduler] emitted flow-fire for {} → {:?}", fid, r);
            })
        }).map_err(|e| {
            eprintln!("[scheduler_reload] Job::new_async FAILED for cron={:?}: {e}", cron);
            format!("invalid cron '{cron}': {e}")
        })?;

        let uuid = scheduler.add(job).await.map_err(|e| format!("add job: {e}"))?;
        eprintln!("[scheduler_reload] added job uuid={} for flow={} normalized_cron={:?}", uuid, flow_id, cron);
        jobs.insert(flow_id, (uuid, cron_raw, catch_up)); // store original for display
    }

    eprintln!("[scheduler_reload] done. {} job(s) installed.", jobs.len());
    Ok(())
}

#[command]
async fn scheduler_get_state(
    state: State<'_, Arc<SchedulerState>>,
) -> Result<Vec<FlowJobState>, String> {
    use std::str::FromStr;
    let state: Arc<SchedulerState> = (*state).clone();
    let jobs = state.jobs.lock().await;
    let lf   = state.last_fired.lock().unwrap().clone();
    let mut out = Vec::with_capacity(jobs.len());
    for (flow_id, (_uuid, cron, _catch_up)) in jobs.iter() {
        let next_fire = cron::Schedule::from_str(&normalize_cron(cron))
            .ok()
            .and_then(|s| s.upcoming(chrono::Local).next())
            .map(|d| d.timestamp_millis());
        out.push(FlowJobState {
            flow_id:    flow_id.clone(),
            cron:       cron.clone(),
            next_fire,
            last_fired: lf.get(flow_id).copied(),
        });
    }
    Ok(out)
}

// ── File-watch trigger ────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WatchedFlow {
    flow_id: String,
    path:    String,
}

// Holds live notify::RecommendedWatcher instances; dropping them stops watching.
type WatcherMap = Arc<Mutex<HashMap<String, Box<dyn notify::Watcher + Send>>>>;

#[command]
fn watch_reload(
    app:   AppHandle,
    state: State<'_, WatcherMap>,
    flows: Vec<WatchedFlow>,
) -> Result<(), String> {
    use notify::{Watcher, RecursiveMode};

    eprintln!("[watch_reload] called with {} flow(s)", flows.len());

    // Build new watchers WITHOUT holding the state lock (watcher creation can block briefly)
    let mut new_entries: Vec<(String, Box<dyn Watcher + Send>)> = Vec::new();

    for flow in &flows {
        let app2 = app.clone();
        let fid  = flow.flow_id.clone();
        // Strip surrounding quotes that users sometimes paste with paths
        let clean = flow.path.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        let path  = std::path::PathBuf::from(clean);
        eprintln!("[watch_reload]   flow={} path={:?}", fid, path);

        let mut watcher = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
            let ev = match ev {
                Ok(e) => e,
                Err(e) => { eprintln!("[watch] error for flow={}: {e}", fid); return; }
            };
            eprintln!("[watch] event for flow={}: {:?}", fid, ev.kind);
            // Only fire on Create / Modify — not Remove, so downstream nodes can
            // safely read the file without racing a deletion.
            let kind = match &ev.kind {
                notify::EventKind::Create(_) => "create",
                notify::EventKind::Modify(_) => "modify",
                _ => return,
            };
            let paths: Vec<String> = ev.paths.iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            eprintln!("[watch] emitting file-watch-fire kind={kind} paths={paths:?}");
            let _ = app2.emit("file-watch-fire", serde_json::json!({
                "flowId": fid,
                "kind":   kind,
                "paths":  paths,
            }));
        }).map_err(|e| e.to_string())?;

        // Watch the directory (more reliable on Windows than watching a single file).
        // For a file path, watch its parent directory; the specific file path is
        // reported back in the event so the frontend knows what changed.
        let watch_target = if path.is_dir() {
            path.clone()
        } else {
            path.parent().map(|p| p.to_path_buf()).unwrap_or(path.clone())
        };
        let mode = if path.is_dir() { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };

        // Ensure the watch target directory exists — create it if needed so the
        // watcher can register even before the watched file has been created.
        if !watch_target.exists() {
            match std::fs::create_dir_all(&watch_target) {
                Ok(()) => eprintln!("[watch_reload]   created directory {:?}", watch_target),
                Err(e) => {
                    eprintln!("[watch_reload]   FAIL: cannot create watch dir {:?}: {e} — skipping flow={}", watch_target, flow.flow_id);
                    let _ = app.emit("watch-setup-error", serde_json::json!({
                        "flowId": flow.flow_id,
                        "error":  format!("Cannot create directory {:?}: {e}", watch_target),
                    }));
                    continue;
                }
            }
        }

        eprintln!("[watch_reload]   watching target={:?} mode={mode:?}", watch_target);
        match watcher.watch(&watch_target, mode) {
            Ok(()) => {
                eprintln!("[watch_reload]   OK: watcher active for flow={}", flow.flow_id);
                new_entries.push((flow.flow_id.clone(), Box::new(watcher)));
            }
            Err(e) => {
                eprintln!("[watch_reload]   FAIL: {e} — skipping flow={}", flow.flow_id);
                let _ = app.emit("watch-setup-error", serde_json::json!({
                    "flowId": flow.flow_id,
                    "error":  format!("Cannot watch {:?}: {e}", watch_target),
                }));
            }
        }
    }

    // Swap: drop old watchers, insert new ones
    let mut map = state.lock().unwrap();
    map.clear();
    for (id, w) in new_entries {
        map.insert(id, w);
    }
    eprintln!("[watch_reload] done: {} watcher(s) active", map.len());
    Ok(())
}

// ── Webhook helpers ───────────────────────────────────────────────────────

/// Find the byte position of `needle` in `haystack`.
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Parse the Content-Length header value from the raw header bytes.
fn parse_content_length(headers: &[u8]) -> usize {
    let text = String::from_utf8_lossy(headers);
    text.lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.splitn(2, ':').nth(1)?.trim().parse().ok())
        .unwrap_or(0)
}

// ── Webhook trigger ───────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebhookFlow {
    flow_id:      String,
    port:         u16,
    #[serde(default = "default_webhook_path")]
    path:         String,
}
fn default_webhook_path() -> String { "/".to_string() }

// Holds abort handles for per-flow HTTP listener tasks.
type WebhookMap = Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>;

#[command]
async fn webhook_reload(
    app:   AppHandle,
    state: State<'_, WebhookMap>,
    flows: Vec<WebhookFlow>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Abort all existing listener tasks.
    {
        let mut map = state.lock().unwrap();
        for (_, handle) in map.drain() { handle.abort(); }
    }

    for flow in flows {
        let app2  = app.clone();
        let fid   = flow.flow_id.clone();
        let port  = flow.port;
        let fpath = flow.path.clone();

        let handle = tokio::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await else {
                eprintln!("[webhook] bind port {port} failed for flow {fid}");
                return;
            };
            eprintln!("[webhook] listening on 127.0.0.1:{port} for flow {fid}");
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { continue };
                let app3   = app2.clone();
                let fid2   = fid.clone();
                let fpath2 = fpath.clone();
                tokio::spawn(async move {
                    // Read until we have the full HTTP request (headers + body).
                    // A single read() often returns only the headers; loop until
                    // we've received Content-Length bytes of body too.
                    let mut raw: Vec<u8> = Vec::with_capacity(4096);
                    let mut tmp = vec![0u8; 4096];
                    loop {
                        let n = stream.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 { break; }
                        raw.extend_from_slice(&tmp[..n]);
                        if let Some(sep) = find_bytes(&raw, b"\r\n\r\n") {
                            let content_length = parse_content_length(&raw[..sep]);
                            if raw.len() >= sep + 4 + content_length { break; }
                        }
                        if raw.len() > 1_048_576 { break; } // 1 MB cap
                    }
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let first  = text.lines().next().unwrap_or("");
                    let method = first.split_whitespace().next().unwrap_or("").to_uppercase();

                    // CORS headers included on every response so browser fetch works
                    let cors = concat!(
                        "Access-Control-Allow-Origin: *\r\n",
                        "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n",
                        "Access-Control-Allow-Headers: Content-Type, Authorization\r\n",
                    );

                    // OPTIONS preflight — respond 204 and stop; do NOT fire the flow
                    if method == "OPTIONS" {
                        let resp = format!("HTTP/1.1 204 No Content\r\n{cors}\r\n");
                        let _ = stream.write_all(resp.as_bytes()).await;
                        return;
                    }

                    // Check path match
                    let req_path = first.split_whitespace().nth(1).unwrap_or("/");
                    let path_matches = fpath2 == "/"
                        || req_path == fpath2
                        || req_path.starts_with(&format!("{}/", fpath2));

                    // Only POST (or GET for simple pings) fires the flow
                    if (method == "POST" || method == "GET") && path_matches {
                        let body = text.find("\r\n\r\n")
                            .map(|i| text[i+4..].trim_end_matches('\0').to_string())
                            .unwrap_or_default();
                        let _ = app3.emit("webhook-fire", serde_json::json!({
                            "flowId": fid2,
                            "body":   body,
                        }));
                    }

                    let ok_body = b"{\"ok\":true}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\n{cors}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        ok_body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(ok_body).await;
                });
            }
        });

        state.lock().unwrap().insert(flow.flow_id.clone(), handle);
    }
    Ok(())
}

// ── Environment variable access ────────────────────────────────────────────

#[command]
fn get_env_var(name: String) -> String {
    std::env::var(&name).unwrap_or_default()
}

/// Sets an environment variable on the Autoflow process so child processes
/// spawned after this call will inherit the new value.
#[command]
fn set_env_var(name: String, value: String) {
    // Safety: single-threaded Tauri command context; child processes
    // are spawned after this returns so they see the updated env.
    #[allow(deprecated)]
    unsafe { std::env::set_var(&name, &value); }
}

// ── Tray + close-to-tray ──────────────────────────────────────────────────

pub struct CloseToTray(pub AtomicBool);

#[command]
fn set_close_to_tray(state: State<'_, Arc<CloseToTray>>, on: bool) {
    state.0.store(on, Ordering::SeqCst);
}

#[command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

/// Returns true if the app was launched with --minimized (autostart hidden in tray).
/// The frontend calls this once on mount and skips show_main_window when true.
#[command]
fn was_launched_minimized() -> bool {
    std::env::args().any(|a| a == "--minimized")
}

// ── App entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pid_map: PidMap = Arc::new(Mutex::new(HashMap::new()));
    let scheduler_state = Arc::new(SchedulerState::new());
    let close_to_tray   = Arc::new(CloseToTray(AtomicBool::new(true)));
    let watcher_map: WatcherMap  = Arc::new(Mutex::new(HashMap::new()));
    let webhook_map: WebhookMap  = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .manage(pid_map)
        .manage(scheduler_state)
        .manage(Arc::clone(&close_to_tray))
        .manage(watcher_map)
        .manage(webhook_map)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            // ── Fix autostart path quoting on Windows (one-time migration) ─
            #[cfg(target_os = "windows")]
            {
                use winreg::RegKey;
                use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
                if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(AUTOSTART_KEY, KEY_READ | KEY_SET_VALUE) {
                    if let Ok(val) = key.get_value::<String, _>(AUTOSTART_NAME) {
                        // If the value exists but isn't quoted, rewrite it with quotes
                        if !val.starts_with('"') {
                            if let Ok(exe) = std::env::current_exe() {
                                let fixed = format!("\"{}\"", exe.to_string_lossy());
                                let _ = key.set_value(AUTOSTART_NAME, &fixed);
                            }
                        }
                    }
                }
            }
            // ── System tray ──────────────────────────────────────────────
            let handle = app.handle().clone();
            let show_item  = MenuItem::with_id(&handle, "show",  "Show",  true, None::<&str>)?;
            let hide_item  = MenuItem::with_id(&handle, "hide",  "Hide",  true, None::<&str>)?;
            let quit_item  = MenuItem::with_id(&handle, "quit",  "Quit",  true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&show_item, &hide_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("Autoflow")
                .icon(handle.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); } }
                        "hide" => { if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); } }
                        "quit" => { app.exit(0); }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            if visible { let _ = w.hide(); }
                            else       { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); }
                        }
                    }
                })
                .build(&handle)?;

            // Window starts hidden (visible: false in tauri.conf.json).
            // The frontend calls show_main_window after React has rendered so the
            // window never appears blank. For --minimized launches the frontend
            // skips that call and the window stays in the tray.

            Ok(())
        })
        .on_window_event({
            let close_to_tray = Arc::clone(&close_to_tray);
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if close_to_tray.0.load(Ordering::SeqCst) && window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            exec_node,
            kill_exec,
            get_cwd,
            read_text_file,
            write_text_file,
            get_workspace,
            set_workspace,
            suggested_workspace_path,
            legacy_appdata_summary,
            migrate_legacy_to_workspace,
            flows_dir_path,
            flows_seeded,
            mark_flows_seeded,
            list_flow_files,
            save_flow_file,
            delete_flow_file,
            scheduler_reload,
            scheduler_get_state,
            set_close_to_tray,
            show_main_window,
            was_launched_minimized,
            autostart_enable,
            autostart_disable,
            autostart_is_enabled,
            autostart_is_minimized,
            launch_app,
            watch_reload,
            webhook_reload,
            get_env_var,
            set_env_var,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
