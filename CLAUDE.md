# Autoflow

A lightweight desktop app for building and running visual automation flows — no backend required.

## What It Does

- **Visual flow editor**: drag-and-drop node graph to wire up automation steps
- **Node types**: Trigger (manual / cron / watch / webhook), REST API, Script (cmd/PowerShell/bash), Condition, Loop, File, Open URL, Launch App, Delay, Sub-flow, Notify, Env Var, Group (visual container)
- **Delay node**: pauses the flow for N ms; accepts `${var:NAME}`; passes upstream stdout through unchanged
- **Sub-flow node**: runs another flow inline; upstream stdout passed as `${var:INPUT}`; leaf output becomes stdout
- **Notify node**: sends an OS desktop notification mid-flow; `title` + `body` fields; both support interpolation; stdout = title; color `#eab308`
- **Env Var node**: `get` reads a process env var → stdout; `set` writes a process env var so child processes inherit it; name + value support interpolation; color `#22d3ee`
- **Node search palette**: `Ctrl+K` opens a floating search palette to add nodes by name; keyboard navigation with ↑↓ and Enter
- **Watch trigger**: Rust `notify` crate watches a file/directory; fires `file-watch-fire` event on **create/modify only** (delete is ignored so downstream File nodes can read safely); changed file path available as `${prev}`
- **Webhook trigger**: Rust `tokio` TCP listener on a local port; fires `webhook-fire` event; request body available as `${prev}` downstream
- **Secret store**: global key-value pairs in `secretsStore` (localStorage `autoflow-secrets`); referenced with `${secret:NAME}`; masked to `***` in run logs; never included in flow exports; managed in Settings → Secrets
- **Group collapse**: click `⌄` in group label (or double-click when collapsed) to fold a group to a 180×32 chip; children are hidden; size restores on expand
- **Node grouping**: select 2+ nodes → Group button creates a resizable container; children move with the group; `parentId`/`extent: 'parent'`/`style.width/height` stored on FlowNode
- **Snap to grid**: 20 px grid for node drag and group resize; toggle with `G` key or toolbar magnet button; default ON; persisted in `settingsStore` as `snapEnabled`
- **Box-select**: drag on empty canvas selects multiple nodes; middle/right-click drag pans
- **Flow variables**: key-value pairs defined on each flow, referenced with `${var:NAME}` in any field
- **Flow tags**: tag flows for filtering on the home page
- **Flow runner**: executes nodes in topological order, streams output in a live log panel
- **Persistence**: flows saved as JSON in the workspace directory via `tauri-plugin-fs`
- **Run Log**: execution history persisted to localStorage, grouped by date, configurable limit
- **Cron scheduler**: `tokio-cron-scheduler` in Rust fires `flow-fire` events; frontend runs flows in background
- **System tray**: minimize-to-tray, OS desktop notifications for background runs
- **In-app toasts**: completion toasts for all run types with direct log navigation
- **Light / dark theme**: CSS-variable–based theme switching, stored in settings
- **Auto-update**: `tauri-plugin-updater` checks GitHub Releases; manual check in Settings → About
- **Launch at login**: `tauri-plugin-autostart` registers OS login entry (Windows registry)

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri v2** | Native window, no Node server, ~5 MB binary |
| UI framework | **React 19 + TypeScript** | Ecosystem, hooks, strict mode |
| Bundler | **Vite 7** | Fast HMR, ESM-native |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`) | Utility-first, CSS-variable themes |
| Flow graph | **@xyflow/react v12** | The standard React flow/graph library |
| State | **Zustand v5** | Minimal, no boilerplate |
| Icons | **lucide-react** | Clean, consistent icon set |
| HTTP client | **tauri-plugin-http** | REST API calls from the frontend |
| Shell execution | **tauri-plugin-shell** | Runs cmd / powershell / bash script nodes |
| File I/O | **tauri-plugin-fs** | Read/write flow JSON |
| Scheduler | **tokio-cron-scheduler** (Rust) | Cron-based flow triggers |
| Notifications | **tauri-plugin-notification** | Desktop alerts for background runs |
| Updates | **tauri-plugin-updater** | Auto-update from GitHub Releases |
| Autostart | **tauri-plugin-autostart** | Launch at login |

## Project Structure

```
src/
  main.tsx              # React entry
  App.tsx               # Root layout + theme class application + startup update check
  index.css             # Tailwind base + light/dark CSS variable overrides + animations
  components/
    Sidebar.tsx         # Nav sidebar
    HomePage.tsx        # Flow cards, weather icon, arm/disarm, tags, multi-select, filters
    FlowEditor.tsx      # @xyflow/react canvas + undo/redo + panel controls + log panel
    FlowVarsPanel.tsx   # Right panel: flow variable editor
    InfoPanel.tsx       # Right panel: flow description + tags editor
    NodePanel.tsx       # Right panel: selected node config (with REST API test button)
    LogPanel.tsx        # Bottom panel: live execution output
    RunLogPage.tsx      # Run history, grouped by date, filterable, exportable
    SettingsPage.tsx    # Settings: Workspace / Window & Tray / REST API / Shell / Run Log / About
    ToastContainer.tsx  # Fixed bottom-right toast notifications
    WelcomeScreen.tsx   # First-run onboarding: workspace picker + example flow import
    nodes/
      TriggerNode.tsx   # Schedule / manual trigger
      RestNode.tsx      # REST API node
      ScriptNode.tsx    # cmd / PowerShell / bash script
      ConditionNode.tsx # Branch on condition
      LoopNode.tsx      # Repeat / retry / forEach loop controller
      FileNode.tsx      # Read / write / append / exists on a local file
      OpenUrlNode.tsx   # Opens URL in browser or path with default app
      LaunchAppNode.tsx # Launch executable with optional arguments (fire-and-forget or wait)
      BaseNode.tsx      # Shared node chrome + run-status ring
    ui/
      Select.tsx        # Dropdown select component
      RefField.tsx      # Text field with upstream ref + flow variable picker
  store/
    flowStore.ts        # Zustand: flows, active flow, view, targetSessionId, duplicateFlow
    settingsStore.ts    # Persisted settings (localStorage)
    runLogStore.ts      # Run history (localStorage), configurable limit
    workspaceStore.ts   # Workspace path
    toastStore.ts       # In-memory toast queue
  lib/
    executor.ts         # Topological sort + node execution (all node types)
    backgroundRunner.ts # Wraps runFlow for cron/catch-up/manual background runs + toasts
    cronService.ts      # Listens for flow-fire Tauri events, drives scheduler
    flowPersistence.ts  # Save/load flow JSON via tauri-plugin-fs
    flowIO.ts           # Import/export bundles (single + multi-flow JSON)
    graphRefs.ts        # Upstream node resolution for ${node-id} refs
    interpolate.ts      # Interpolation engine (node refs, var:, loop.item, loop.item.field)
    exampleFlows.ts     # 19 example flow templates; importable via Settings → Workspace
    tagColor.ts         # Hash-based tag colour palette (shared across HomePage + InfoPanel)
  types/
    flow.ts             # Flow, Node, Edge TypeScript types (includes variables, tags)
    settings.ts         # AppSettings type + defaults

src-tauri/
  src/lib.rs            # Tauri app setup, scheduler, tray, Rust commands
  tauri.conf.json       # App config, shell scope, updater endpoint, createUpdaterArtifacts
  capabilities/
    default.json        # Tauri permissions
  Cargo.toml            # Rust deps
  icons/                # App icons generated from app-icon.svg via `npx tauri icon`
.github/workflows/
  release.yml           # Build + sign + publish on v* tag push
```

## Design Principles

- **Minimal & clean**: neutral palette (dark default, light optional), generous whitespace
- **One mental model**: everything is a flow made of nodes connected by edges
- **No backend**: HTTP calls go directly via tauri-plugin-http; shell via tauri-plugin-shell
- **No accounts, no cloud**: flows live in local workspace as plain JSON; settings in localStorage

## Development Commands

```bash
# Install JS deps
npm install

# Start dev (opens window with HMR)
npm run tauri dev

# Type check
npx tsc --noEmit

# Production build
npm run tauri build

# Regenerate app icons from app-icon.svg
npx tauri icon app-icon.svg
```

## Flow Data Shape

```ts
interface Flow {
  id:          string;
  name:        string;
  description: string;
  variables?:  Record<string, string>;  // ${var:NAME} interpolation
  tags?:       string[];                // for filtering on home page
  nodes:       FlowNode[];
  edges:       FlowEdge[];
  status:      'idle' | 'running' | 'success' | 'error';
  lastRun?:    number;
  createdAt:   number;
  updatedAt:   number;
}
```

## Node Configuration Shape

```ts
type TriggerNodeData = {
  label:    string;
  mode:     'manual' | 'cron';
  cron?:    string;     // 5-field; Rust normalises to 6-field for tokio-cron-scheduler
  catchUp?: 'skip' | 'run-once' | 'run-all';
  enabled?: boolean;    // arm/disarm — false means scheduler skips this flow
};

type RestNodeData = {
  label:          string;
  method:         'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  urlOverride?:   string;   // full URL; bypasses global base URL + endpoint when set
  endpoint:       string;
  bodyMode:       'form' | 'json';
  bodyRows:       { key: string; value: string }[];
  body:           string;
  tokenOverride?: string;
};

type ScriptNodeData = {
  label:    string;
  shell:    'cmd' | 'powershell' | 'bash';
  script:   string;
  workDir?: string;
};

type ConditionNodeData = {
  label:   string;
  source:  string;
  op:      'equals' | 'notEquals' | 'contains' | 'matches' | 'nonempty' | 'empty' | 'exitZero';
  value?:  string;
};

type LoopNodeData = {
  label:      string;
  mode:       'repeat' | 'retry' | 'forEach';
  count?:     number;     // repeat / retry iterations (default 3)
  delay?:     number;     // ms between iterations
  separator?: 'newline' | 'json-array';  // forEach item split mode
};

type FileNodeData = {
  label:      string;
  operation:  'read' | 'write' | 'append' | 'exists';
  path:       string;
  content?:   string;   // write / append only
};

type OpenUrlNodeData = {
  label: string;
  url:   string;   // https:// → browser; anything else → default system app
};

type LaunchAppNodeData = {
  label:        string;
  program:      string;  // exe path or command name; supports interpolation
  args?:        string;  // space-separated arguments; supports interpolation
  waitForExit?: boolean; // if true, wait for process to exit and capture stdout/exit code
};

type DelayNodeData = {
  label: string;
  ms:    number;  // milliseconds; accepts ${var:NAME} interpolation
};

type SubflowNodeData = {
  label:     string;
  flowId:    string;  // id of the target flow
  flowName?: string;  // display name (cosmetic, copied at config time)
};

// Watch trigger uses TriggerNodeData with mode:'watch':
//   watchPath?: string  — file or directory; parent dir watched on Windows; surrounding quotes stripped
//   enabled?:   boolean
//
// Webhook trigger uses TriggerNodeData with mode:'webhook':
//   port?:        number  — localhost port (1–65535)
//   webhookPath?: string  — URL path to match (default '/')
//   enabled?:     boolean
```

## Interpolation Reference

| Syntax | Resolves to |
|---|---|
| `${prev}` | stdout of the immediate upstream parent(s) |
| `${prev.exit}` | exit code of the immediate upstream parent |
| `${node-id}` | stdout of the named node (by id or label) |
| `${node-id.exit}` | exit code of the named node |
| `${node-id.field}` | JSON field extracted from a node's stdout |
| `${var:NAME}` | flow-level variable (resolved before node refs) |
| `${loop.item}` | current forEach loop item (whole value) |
| `${loop.item.field}` | JSON field extracted from the current forEach loop item |
| `${env.NAME}` | process environment variable |
| `${secret:NAME}` | app-level secret (Settings → Secrets); masked to `***` in logs |

## Key Constraints

- **One trigger per flow** — enforced in the UI; second trigger is disabled in Add Node menu
- **Delay node** (`type: 'delay'`): single `ms` field (accepts `${var:NAME}`); passes upstream stdout through unchanged; killable mid-sleep; color `#14b8a6`
- **Sub-flow node** (`type: 'subflow'`): `flowId` + `flowName` fields; upstream stdout injected as `${var:INPUT}` in sub-flow; leaf node output becomes this node's stdout; cycle detection via `callStack: Set<string>` threaded through `runFlow`/`execNode`; self-reference filtered from the flow picker in NodePanel
- **Notify node** (`type: 'notify'`): `title` + `body` fields; calls `sendNotification` from `@tauri-apps/plugin-notification`; stdout = title; both fields support full interpolation; color `#eab308`
- **Env Var node** (`type: 'envvar'`): `op: 'get'|'set'`, `name`, `value` fields; `get` invokes `get_env_var` Rust command → stdout; `set` invokes `set_env_var` Rust command (uses `std::env::set_var` so child processes inherit it); color `#22d3ee`
- **Node search palette**: `Ctrl+K` opens `NodePalette.tsx` (floating modal); search filters ADD_ITEMS by label/type; keyboard nav with ↑↓, Enter to add, Esc to close; trigger disabled when one already exists; paletteRef pattern for stale-closure-safe toggle
- **Watch trigger** (`mode: 'watch'`): fires on **create/modify only** — delete events are ignored so downstream File nodes can read safely; watches parent directory (more reliable on Windows); auto-creates parent dir if missing; strips surrounding quotes from the path; changed file path becomes the trigger node's stdout (`${prev}`); `notify = "6"` crate in Cargo.toml
- **Webhook trigger** (`mode: 'webhook'`): Rust `tokio::net::TcpListener` on `127.0.0.1:{port}`; handles OPTIONS preflight with CORS headers so browser `fetch` works; reads full body via Content-Length loop; only fires flow on POST/GET (not OPTIONS); request body becomes trigger stdout; `WebhookMap: Arc<Mutex<HashMap<String, JoinHandle<()>>>>` in Rust state
- **Secret store**: `useSecretsStore` (Zustand, localStorage `autoflow-secrets`); `${secret:NAME}` resolved in `interpolate.ts`; all log output masked via `origOnLog` wrapper in `runFlow`; never included in flow exports; RefField shows secrets section in picker with lock icon chips; Settings → Secrets section
- **Group collapse**: `collapsed: boolean` in node data; when collapsed → style `{width:180, height:32}`, children `hidden:true`, `_expandedWidth/_expandedHeight` saved; chevron `⌄`/`›` buttons toggle; `.react-flow__node-group` CSS resets ReactFlow's default white background/border/padding
- **Background trigger → editor routing**: `registerEditorCallback(flowId, cb)` in `backgroundRunner.ts` (module-level Map); FlowEditor registers via `useEffect([flow?.id])`; callback uses `handleRunRef.current` to avoid stale closures; `runFlowInBackground` calls callback and returns early if registered, otherwise does silent background run
- **Trigger stdout (triggerOutput)**: `runFlow` accepts optional `triggerOutput?: string`; trigger node stdout is set to this value (watch path or webhook body) so `${prev}` works in first downstream node; passed through `runFlowInBackground` and `subflowNode`
- **File/path quote stripping**: `fileNode` and `launchAppNode` in executor strip surrounding `"` or `'` from interpolated paths — prevents errors when RefField inserts in `"text"` mode; same stripping in cronService `watchOf` and Rust `watch_reload`
- **Group nodes** (`type: 'group'`): visual-only containers; executor filters them out before `topSort`; stored with `parentId`, `extent: 'parent'`, `style.width/height` on `FlowNode`; group nodes must appear before children in the nodes array; created via toolbar Group button (2+ top-level non-group nodes selected), not in Add Node menu; resize snaps to 20 px grid when snap is enabled
- **Snap to grid**: `snapEnabled` persisted in `settingsStore` (default `true`); toggleable with `G` key or toolbar magnet button; node drag uses ReactFlow `snapToGrid`/`snapGrid`; group resize uses `onResizeEnd` in `GroupNode` to snap final dimensions
- **Box-select**: `selectionOnDrag={true}` + `panOnDrag={[1, 2]}` on ReactFlow — left drag = box-select, middle/right drag = pan
- **Copy/paste groups**: copying strips group containers; child positions are converted to absolute before going to clipboard; paste always produces free (ungrouped) nodes
- **Shell scope** in `tauri.conf.json` → `plugins.shell.scope` controls which executables can run
- **HTTP scope** in `capabilities/default.json` allows `https://**`
- **Cron field format**: UI accepts 5-field cron; `normalize_cron()` in Rust prepends `0` seconds for 6-field `tokio-cron-scheduler`
- **REST API base URL** configured globally in Settings → REST API; per-node `urlOverride` bypasses it entirely; `tokenOverride` overrides the global token
- **Loop body**: the Loop node runs only the single directly-connected node; it marks that node as `loopManaged` so the main executor skips it
- **forEach JSON array**: upstream stdout is parsed as a JSON array; each element (stringified if object) becomes one `loop.item`; `${loop.item.field}` extracts fields from JSON object items
- **`${var:NAME}` interpolation**: resolved from the flow's `variables` map before node refs
- **Insert ref picker**: `raw` inserts `${var:NAME}` (correct for numbers/booleans/form fields); `"text"` inserts `"${var:NAME}"` (quoted JSON string)
- **Theme**: `.light` class on `<html>` overrides CSS custom properties; applied via `useEffect` in `App.tsx`
- **Run log limit**: configurable in Settings → Run Log (default 100, range 10–500)
- **Auto-update signing key**: public key in `tauri.conf.json` (safe to commit); private key at `~/.tauri/autoflow.key`; password in `~/.tauri/autoflow.key.password`. Releases are built locally via `release.ps1` — GitHub Actions workflow still exists but is no longer the primary release path
- **`createUpdaterArtifacts: true`** in `tauri.conf.json` — required for updater bundle generation
- **Workspace path** stored in `<appData>/workspace.json` (machine-local); flows in `<workspace>/flows/*.json`
- **Launch App node**: uses a custom `launch_app` Rust command (not the shell plugin); always spawns a new detached process (`DETACHED_PROCESS` flag on Windows); fire-and-forget by default, or wait-for-exit to capture stdout/exit code downstream
- **Launch at login**: custom `autostart_enable(minimized)/disable/is_enabled/is_minimized` Rust commands write to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` with a properly quoted path (bypasses `tauri-plugin-autostart` which omits quotes, breaking paths with spaces); `minimized: true` appends `--minimized` to the registry value so the app starts hidden on login
- **Start minimized to tray**: window is `visible: false` in `tauri.conf.json`; setup shows it unless `--minimized` CLI arg is present; prevents window flash when autostart launches minimized
- **Condition node pass-through**: condition nodes store the upstream parent's stdout (not the branch string) so a Loop immediately downstream receives the correct data
- **Welcome screen** shown on first launch (no workspace set); picks workspace directory; example flows importable any time via Settings → Workspace
- **Example flows** (22 total) live in `src/lib/exampleFlows.ts`; count shown in Settings is dynamic (`getExampleFlows().length`), never hardcoded
- **DEV badge** in sidebar footer — rendered only when `import.meta.env.DEV` is true; absent in production builds
- Tailwind v4 via `@tailwindcss/vite` (no `tailwind.config.js`)
- `@xyflow/react` requires: `import "@xyflow/react/dist/style.css"` in `main.tsx`
- App identifier: `io.github.ghostunderblanket.autoflow` — changing resets user app data
