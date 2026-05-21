# Autoflow

A lightweight desktop app for building and running visual automation flows — no backend, no accounts, no cloud.

![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue)
![React 19](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

## What It Does

- **Visual flow editor** — drag-and-drop node graph to wire up automation steps
- **Node types** — Trigger, REST API, Script, Condition, Loop, File, Open URL, Launch App
- **Flow variables** — define key-value pairs on the flow and reference them with `${var:NAME}` in any node field
- **Flow tags** — tag flows for filtering and organisation
- **Flow runner** — executes nodes in topological order, streams output in a live log panel
- **Cron scheduler** — Rust-side `tokio-cron-scheduler` fires flows on schedule even when the window is hidden
- **Arm / disarm** — enable or disable a scheduled flow directly from the home page card
- **Run health** — weather icon on each card shows success rate of the last 5 runs
- **In-app toasts** — completion notifications for all run types with one-click log navigation
- **System tray** — minimize to tray, OS desktop notifications for background runs
- **Run Log** — full execution history, filterable and exportable
- **Launch at login** — optional autostart via OS login entry
- **Light / dark theme** — toggle in Settings → Window & Tray
- **Auto-update** — checks GitHub Releases on startup; one-click install from Settings → About

## Tech Stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 |
| UI | React 19 + TypeScript + Vite 7 |
| Styling | Tailwind CSS v4 |
| Flow graph | @xyflow/react v12 |
| State | Zustand v5 |
| HTTP | tauri-plugin-http |
| Scheduler | tokio-cron-scheduler (Rust) |
| Updates | tauri-plugin-updater |
| Autostart | tauri-plugin-autostart |

## Development

```bash
npm install
npm run tauri dev      # dev window with HMR
npx tsc --noEmit       # type check
npm run tauri build    # production build + installer
```

## Releasing

Push a `v*` tag — GitHub Actions builds, signs, and publishes the release automatically:

```bash
# Bump version in package.json + src-tauri/Cargo.toml + src-tauri/tauri.conf.json
git add -A && git commit -m "Release v0.x.0"
git tag v0.x.0
git push && git push origin v0.x.0
```

## Node Types

| Node | Purpose |
|---|---|
| **Trigger** | Starts the flow — manually or on a cron schedule (one per flow) |
| **REST API** | HTTP request with form-row or raw-JSON body; per-node URL and token override |
| **Script** | Inline cmd / PowerShell / bash script |
| **Condition** | Branches flow on a condition; true/false edges route downstream nodes |
| **Loop** | Repeats a node N times, retries until exit 0, or iterates over a list (forEach) |
| **File** | Read / write / append / check-exists on a local file |
| **Open URL** | Opens a URL in the default browser or a path with the default system app |
| **Launch App** | Launches an executable with optional arguments; fire-and-forget (default) or wait-for-exit to capture stdout and exit code downstream |

### Interpolation

| Syntax | Resolves to |
|---|---|
| `${prev}` | stdout of the immediate upstream node |
| `${node-id}` | stdout of a named node |
| `${node-id.field}` | JSON field extracted from a node's stdout |
| `${var:NAME}` | flow-level variable |
| `${loop.item}` | current forEach loop item |
| `${loop.item.field}` | JSON field extracted from the current forEach loop item |

## License

MIT
