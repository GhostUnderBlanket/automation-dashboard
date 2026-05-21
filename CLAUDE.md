# Autoflow

A lightweight desktop app for building and running visual automation flows — no backend required.

## What It Does

- **Visual flow editor**: drag-and-drop node graph to wire up automation steps
- **Node types**: Trigger (manual / cron), REST API, Script (cmd/PowerShell/bash), Condition, Loop, File, Open URL, Launch App
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
      LaunchAppNode.tsx # Launch executable; focus existing window if already running
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
    exampleFlows.ts     # 16 example flow templates; imported via welcome screen or Settings
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

## Releasing

Push a `v*` tag — GitHub Actions builds, signs, and publishes automatically:

```bash
# 1. Bump version in package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# 2. Commit, tag, push:
git add -A && git commit -m "Release v0.x.0"
git tag v0.x.0
git push && git push origin v0.x.0
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
  label:          string;
  program:        string;  // exe path or command name; supports interpolation
  args?:          string;  // space-separated arguments; supports interpolation
  waitForExit?:   boolean; // if true, wait for process to exit and capture stdout
  focusIfRunning?: boolean; // if true, find existing window and bring to foreground instead of spawning
                           // outputs "focused" or "launched" as stdout for downstream Condition branching
};
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

## Key Constraints

- **One trigger per flow** — enforced in the UI; second trigger is disabled in Add Node menu
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
- **Auto-update signing key**: public key in `tauri.conf.json` (safe to commit); private key at `~/.tauri/autoflow.key` and as GitHub Actions secrets
- **`createUpdaterArtifacts: true`** in `tauri.conf.json` — required for updater bundle generation
- **Workspace path** stored in `<appData>/workspace.json` (machine-local); flows in `<workspace>/flows/*.json`
- **Launch App node**: uses a custom `launch_app` Rust command (not the shell plugin); `focusIfRunning` enumerates processes via `CreateToolhelp32Snapshot` and calls `SetForegroundWindow`; outputs `"focused"` or `"launched"` as stdout so a downstream Condition can branch on the result
- **Launch at login**: custom `autostart_enable/disable/is_enabled` Rust commands write to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` with a properly quoted path (bypasses `tauri-plugin-autostart` which omits quotes, breaking paths with spaces)
- **Condition node pass-through**: condition nodes store the upstream parent's stdout (not the branch string) so a Loop immediately downstream receives the correct data
- **Welcome screen** shown on first launch (no workspace set); picks workspace directory; 19 example flows importable any time via Settings → Workspace
- **Example flows** live in `src/lib/exampleFlows.ts`; also importable any time via Settings → Workspace
- Tailwind v4 via `@tailwindcss/vite` (no `tailwind.config.js`)
- `@xyflow/react` requires: `import "@xyflow/react/dist/style.css"` in `main.tsx`
- App identifier: `io.github.ghostunderblanket.autoflow` — changing resets user app data
