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
fn autostart_enable() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = exe.to_string_lossy().to_string();
        // Always quote the path so spaces in "Program Files" don't break startup
        let value = format!("\"{}\"", path);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey_with_flags(AUTOSTART_KEY, KEY_SET_VALUE)
            .map_err(|e| e.to_string())?;
        key.set_value(AUTOSTART_NAME, &value).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// On Windows: find a running process by exe name, locate its visible window,
/// restore + foreground it. Returns true if a window was found and focused.
#[cfg(target_os = "windows")]
fn focus_running_process(exe_name: &str) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, BOOL, HWND, INVALID_HANDLE_VALUE, LPARAM},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
            PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
            SetForegroundWindow, ShowWindow, SW_RESTORE,
        },
    };

    let target = exe_name.to_lowercase();
    let target_stem = target.trim_end_matches(".exe");

    // ── Step 1: find PID matching the exe name ────────────────────────────
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return false; }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    let mut found_pid: u32 = 0;
    unsafe {
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(260);
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                if name.trim_end_matches(".exe") == target_stem {
                    found_pid = entry.th32ProcessID;
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 { break; }
            }
        }
        CloseHandle(snapshot);
    }

    if found_pid == 0 { return false; }

    // ── Step 2: find visible window for that PID and focus it ─────────────
    struct Search { pid: u32, hwnd: HWND }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let s = &mut *(lparam as *mut Search);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == s.pid && IsWindowVisible(hwnd) != 0 {
            s.hwnd = hwnd;
            return 0; // stop enumeration
        }
        1
    }

    let mut search = Search { pid: found_pid, hwnd: 0 };
    unsafe {
        EnumWindows(Some(enum_cb), &mut search as *mut Search as LPARAM);
        if search.hwnd != 0 {
            ShowWindow(search.hwnd, SW_RESTORE);
            SetForegroundWindow(search.hwnd);
            return true;
        }
    }
    false
}

#[command]
fn launch_app(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    focus_if_running: bool,
) -> Result<String, String> {
    // Try to focus an existing instance first
    #[cfg(target_os = "windows")]
    if focus_if_running {
        let exe_name = std::path::Path::new(&program)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| program.clone());
        if focus_running_process(&exe_name) {
            return Ok("focused".to_string());
        }
    }

    // Not running (or focus disabled) — spawn a new instance
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
    Ok("launched".to_string())
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

// ── App entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pid_map: PidMap = Arc::new(Mutex::new(HashMap::new()));
    let scheduler_state = Arc::new(SchedulerState::new());
    let close_to_tray   = Arc::new(CloseToTray(AtomicBool::new(true)));

    tauri::Builder::default()
        .manage(pid_map)
        .manage(scheduler_state)
        .manage(Arc::clone(&close_to_tray))
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
            autostart_enable,
            autostart_disable,
            autostart_is_enabled,
            launch_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
