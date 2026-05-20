# Skill: Create Custom Flow

A guide for generating importable Autoflow `.flow.json` files.

---

## Flow File Format

Every importable file is a JSON envelope:

```json
{
  "$schema": "autoflow.flow",
  "version": 1,
  "exportedAt": 1748000000000,
  "flow": { ...flow object... }
}
```

The `flow` object shape:

```json
{
  "id":          "unique-id",
  "name":        "Flow Name",
  "description": "What this flow does.",
  "tags":        ["tag1", "tag2"],
  "variables":   { "VAR_NAME": "default value" },
  "nodes":       [...],
  "edges":       [...],
  "status":      "idle"
}
```

- `id` — arbitrary string; the importer replaces it with a fresh one, so any unique value works
- `tags` — used for filtering on the home page
- `variables` — referenced in any field with `${var:VAR_NAME}`; shown in the Info panel for easy editing

---

## Node Shape

Every node follows this structure:

```json
{
  "id":       "node-id",
  "type":     "trigger|rest|script|condition|loop|file|openurl",
  "label":    "Human label",
  "position": { "x": 0, "y": 0 },
  "data":     { ...type-specific fields... }
}
```

**Position tips**
- Lay nodes out left-to-right with `x` incrementing by ~240–280 px per step
- Branch nodes (Condition true/false) offset `y` by ±60–80 px

---

## Node Types

### Trigger
Starts the flow. One per flow.

```json
{
  "id": "t1", "type": "trigger", "label": "Run", "position": { "x": 0, "y": 0 },
  "data": { "label": "Run", "mode": "manual" }
}
```

Scheduled (cron):

```json
"data": {
  "label":   "Weekdays 09:00",
  "mode":    "cron",
  "cron":    "0 9 * * 1-5",
  "catchUp": "skip",
  "enabled": true
}
```

- `cron` — 5-field POSIX format (`min hour dom month dow`)
- `catchUp` — `"skip"` | `"run-once"` | `"run-all"` (what to do for missed ticks)
- `enabled` — `false` disarms the scheduler without deleting the node

---

### REST API

```json
{
  "id": "r1", "type": "rest", "label": "POST data", "position": { "x": 260, "y": 0 },
  "data": {
    "label":      "POST data",
    "method":     "POST",
    "endpoint":   "api/v1/resource",
    "urlOverride": "",
    "bodyMode":   "form",
    "bodyRows":   [
      { "key": "field1", "value": "value1" },
      { "key": "field2", "value": "${prev}" }
    ],
    "body":          "",
    "tokenOverride": ""
  }
}
```

- `urlOverride` — full URL; when set, `endpoint` and the global base URL are ignored. Use for public APIs or nodes that call a different server
- `bodyMode` — `"form"` (key-value rows coerced to JSON types) or `"json"` (raw JSON string)
- `tokenOverride` — overrides the global bearer token for this node only
- Use `${loop.item.field}` in body rows when this node is inside a Loop's forEach body

Raw JSON body:

```json
"bodyMode": "json",
"body": "{\n  \"key\": \"${prev}\"\n}",
"bodyRows": []
```

---

### Script

```json
{
  "id": "s1", "type": "script", "label": "Get date", "position": { "x": 260, "y": 0 },
  "data": {
    "label":   "Get date",
    "shell":   "powershell",
    "script":  "Get-Date -Format \"yyyy-MM-dd\"",
    "workDir": "${var:DIRECTORY}"
  }
}
```

- `shell` — `"powershell"` | `"cmd"` | `"bash"`
- `workDir` — working directory for the process; leave empty for the Autoflow workspace default
- stdout becomes the node's output, referenceable downstream as `${node-id}` or `${prev}`
- Use PowerShell when the script contains double-quoted strings passed to external CLIs (avoids Windows/Rust quoting issues with cmd)

**PowerShell quoting note**: When calling external programs that need quoted strings (e.g. `cm find attributes "where ..."`), use PowerShell — cmd quoting via Autoflow's executor causes the double quotes to be passed literally.

---

### Condition

Routes flow down the `true` or `false` edge based on a test.

```json
{
  "id": "c1", "type": "condition", "label": "Check result", "position": { "x": 500, "y": 0 },
  "data": {
    "label":  "Check result",
    "source": "${prev}",
    "op":     "equals",
    "value":  "ready"
  }
}
```

| `op` | Tests |
|---|---|
| `equals` | exact string match |
| `notEquals` | string not equal |
| `contains` | substring |
| `matches` | JS regex |
| `nonempty` | non-empty string |
| `empty` | empty / whitespace |
| `exitZero` | previous node exited with code 0 |

Edges from a Condition node must set `sourceHandle`:

```json
{ "id": "e-true",  "source": "c1", "target": "true-node",  "sourceHandle": "true"  },
{ "id": "e-false", "source": "c1", "target": "false-node", "sourceHandle": "false" }
```

---

### Loop

Runs the directly-connected node multiple times. Only one node can be the loop body.

```json
{
  "id": "l1", "type": "loop", "label": "For each ticket", "position": { "x": 500, "y": 0 },
  "data": {
    "label":     "For each ticket",
    "mode":      "forEach",
    "separator": "json-array",
    "delay":     0
  }
}
```

| `mode` | Behaviour |
|---|---|
| `repeat` | Run body exactly `count` times |
| `retry` | Run body until exit 0, up to `count` attempts |
| `forEach` | Run body once per item from upstream output |

`separator` (forEach only):
- `"newline"` — split upstream stdout by line
- `"json-array"` — parse upstream stdout as a JSON array; each element is one item

`delay` — milliseconds to wait between iterations.

**forEach with JSON objects**: if the upstream script outputs a JSON array of objects, use `${loop.item.field}` in the body node to extract individual fields:

```powershell
# Script node output:
Write-Output '[{"taskId":"PLR-37","hours":4},{"taskId":"PLR-38","hours":4}]'
```

```json
// REST body rows in the loop body:
{ "key": "taskId", "value": "${loop.item.taskId}" },
{ "key": "hours",  "value": "${loop.item.hours}"  }
```

---

### File

```json
{
  "id": "f1", "type": "file", "label": "Write log", "position": { "x": 260, "y": 0 },
  "data": {
    "label":     "Write log",
    "operation": "write",
    "path":      "${var:LOG_FILE}",
    "content":   "Run at ${prev}\n"
  }
}
```

| `operation` | Behaviour |
|---|---|
| `read` | Read file → stdout |
| `write` | Overwrite file with `content` |
| `append` | Append `content` to file |
| `exists` | Output `true`/`false`; exit 0 if exists |

---

### Open URL

```json
{
  "id": "ou1", "type": "openurl", "label": "Open dashboard", "position": { "x": 260, "y": 0 },
  "data": {
    "label": "Open dashboard",
    "url":   "https://example.com/dashboard"
  }
}
```

- `https://` / `http://` → default browser
- Any other path → default system app (e.g. opens a file in Explorer)

---

## Edges

```json
{ "id": "e1", "source": "node-a", "target": "node-b" }
```

- `id` — any unique string
- Condition edges add `"sourceHandle": "true"` or `"sourceHandle": "false"`
- Loop → body edges are plain edges (no sourceHandle)

---

## Interpolation Reference

| Syntax | Resolves to |
|---|---|
| `${prev}` | stdout of the immediate upstream parent |
| `${prev.exit}` | exit code of the immediate upstream parent |
| `${node-id}` | stdout of a named node (by id or label) |
| `${node-id.exit}` | exit code of a named node |
| `${node-id.field}` | JSON field extracted from a node's stdout |
| `${var:NAME}` | flow-level variable (resolved first, before node refs) |
| `${loop.item}` | current forEach loop item (whole value) |
| `${loop.item.field}` | JSON field extracted from a JSON object loop item |
| `${env.NAME}` | process environment variable |

---

## Variables Best Practices

Expose anything the user is likely to change as a flow variable:

```json
"variables": {
  "OWNER":     "user@example.com",
  "HOURS":     "8",
  "DIRECTORY": "D:\\Workspaces\\MyProject",
  "LOG_FILE":  "C:\\Users\\Public\\autoflow.log"
}
```

- Use ALL_CAPS names by convention
- Windows paths in JSON need double backslashes: `"D:\\Workspaces\\Project"`
- Numeric variables (like `HOURS`) are stored as strings but work fine in PowerShell arithmetic after interpolation

---

## Common Patterns

### Cron → Script → REST
```
Trigger (cron) → Script (build payload) → REST (POST)
```

### Fetch → Parse → Loop → REST
```
Trigger → Script (output JSON array) → Loop (forEach json-array) → REST (${loop.item.field})
```

### Condition branch
```
Trigger → Script → Condition → [true] Script A
                             → [false] Script B
```

### File pipeline
```
Trigger → Script (produce content) → File (write) → File (read back)
```

### Retry on failure
```
Trigger → Loop (retry ×5, delay 2000ms) → Script (flaky operation)
```

---

## Output File

Save as `<flow-name>.flow.json` — the user imports it via:
**Home page** → flow card menu → Import, or **Settings → Workspace → Import flow**

After import the user can edit variables from the Info panel (the `ⓘ` button top-right of the canvas) without touching the script.
