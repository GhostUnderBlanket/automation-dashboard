import type { Flow } from '../types/flow';

type FlowTemplate = Omit<Flow, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

/** Returns fresh Flow objects (new IDs + timestamps) each call — safe to import multiple times. */
export function getExampleFlows(): Flow[] {
  const now = Date.now();
  return EXAMPLES.map((t, i) => ({
    ...t,
    id:        `example-${now}-${i}`,
    status:    'idle' as const,
    createdAt: now + i,
    updatedAt: now + i,
  }));
}

const EXAMPLES: FlowTemplate[] = [

  /* ── 1. Hello World ───────────────────────────── */
  {
    name:        'Hello World',
    description: 'The simplest flow. Manual trigger runs a script that prints "Hello, Autoflow!" — a good starting point to verify your setup.',
    tags:        ['example'],
    variables:   {},
    nodes: [
      { id: 'hw-trig',   type: 'trigger', label: 'Run',            position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'hw-script', type: 'script',  label: 'Hello, Autoflow!', position: { x: 240, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "Hello, Autoflow!"' } },
    ],
    edges: [{ id: 'hw-e1', source: 'hw-trig', target: 'hw-script' }],
  },

  /* ── 2. Cron: Print timestamp every minute ────── */
  {
    name:        'Cron Trigger — Every Minute',
    description: 'Fires on a cron schedule (every minute) and prints the current timestamp. Open the Run Log and wait 60–90 s to see a new entry appear automatically.',
    tags:        ['example', 'cron'],
    variables:   {},
    nodes: [
      { id: 'ct-trig',   type: 'trigger', label: 'Every minute',   position: { x: 0,   y: 0 }, data: { mode: 'cron', cron: '*/1 * * * *', catchUp: 'skip', enabled: true } },
      { id: 'ct-stamp',  type: 'script',  label: 'Print timestamp', position: { x: 260, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "Fired at $(Get-Date -Format \'yyyy-MM-dd HH:mm:ss\')"' } },
    ],
    edges: [{ id: 'ct-e1', source: 'ct-trig', target: 'ct-stamp' }],
  },

  /* ── 3. REST API — GET request ────────────────── */
  {
    name:        'REST API — GET Request',
    description: 'Fetches a post from the free JSONPlaceholder API (no auth or setup needed). The URL override bypasses the global base URL so this works out of the box. Try changing the post ID at the end of the URL.',
    tags:        ['example', 'rest'],
    variables:   {},
    nodes: [
      { id: 'rg-trig', type: 'trigger', label: 'Run',           position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'rg-rest', type: 'rest',    label: 'GET post',       position: { x: 260, y: 0 }, data: { method: 'GET', endpoint: '', urlOverride: 'https://jsonplaceholder.typicode.com/posts/1', bodyMode: 'form', bodyRows: [] } },
    ],
    edges: [{ id: 'rg-e1', source: 'rg-trig', target: 'rg-rest' }],
  },

  /* ── 4. REST API — POST with JSON body ────────── */
  {
    name:        'REST API — POST JSON Body',
    description: 'Posts a new resource to the free JSONPlaceholder API. The URL override bypasses the global base URL so this works out of the box. The response echoes back the created object with a generated ID.',
    tags:        ['example', 'rest'],
    variables:   {},
    nodes: [
      { id: 'rp-trig', type: 'trigger', label: 'Run',        position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'rp-rest', type: 'rest',    label: 'POST post',   position: { x: 260, y: 0 }, data: {
        method: 'POST',
        endpoint: '',
        urlOverride: 'https://jsonplaceholder.typicode.com/posts',
        bodyMode: 'form',
        bodyRows: [
          { key: 'title',  value: 'Hello from Autoflow' },
          { key: 'body',   value: 'Sent via the REST API node' },
          { key: 'userId', value: '1' },
        ],
      }},
    ],
    edges: [{ id: 'rp-e1', source: 'rp-trig', target: 'rp-rest' }],
  },

  /* ── 5. Condition Branch ──────────────────────── */
  {
    name:        'Condition Branch',
    description: 'A script outputs a value and a Condition node routes the flow. The true branch runs when the condition matches; the false branch is skipped. Try changing the script output to see both paths.',
    tags:        ['example', 'condition'],
    variables:   {},
    nodes: [
      { id: 'cb-trig',  type: 'trigger',   label: 'Run',          position: { x: 0,   y: 0   }, data: { mode: 'manual' } },
      { id: 'cb-val',   type: 'script',    label: 'Output value', position: { x: 220, y: 0   }, data: { shell: 'powershell', script: 'Write-Output "ready"' } },
      { id: 'cb-cond',  type: 'condition', label: 'Equals "ready"?', position: { x: 460, y: 0   }, data: { source: '${cb-val}', op: 'equals', value: 'ready' } },
      { id: 'cb-true',  type: 'script',    label: 'TRUE path',    position: { x: 700, y: -60 }, data: { shell: 'powershell', script: 'Write-Output "✓ Condition matched — taking TRUE branch"' } },
      { id: 'cb-false', type: 'script',    label: 'FALSE path',   position: { x: 700, y: 80  }, data: { shell: 'powershell', script: 'Write-Output "✗ Condition did not match — FALSE branch"' } },
    ],
    edges: [
      { id: 'cb-e1', source: 'cb-trig', target: 'cb-val'  },
      { id: 'cb-e2', source: 'cb-val',  target: 'cb-cond' },
      { id: 'cb-e3', source: 'cb-cond', target: 'cb-true',  sourceHandle: 'true'  },
      { id: 'cb-e4', source: 'cb-cond', target: 'cb-false', sourceHandle: 'false' },
    ],
  },

  /* ── 6. Flow Variables ────────────────────────── */
  {
    name:        'Flow Variables',
    description: 'Demonstrates ${var:NAME} interpolation. Edit the GREETING and TARGET variables in the Info panel, then run to see them substituted into the script output.',
    tags:        ['example', 'variables'],
    variables:   { GREETING: 'Hello', TARGET: 'World' },
    nodes: [
      { id: 'fv-trig',   type: 'trigger', label: 'Run',          position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'fv-script', type: 'script',  label: 'Use variables', position: { x: 260, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "${var:GREETING}, ${var:TARGET}!"' } },
    ],
    edges: [{ id: 'fv-e1', source: 'fv-trig', target: 'fv-script' }],
  },

  /* ── 7. Node References (${prev} and ${node-id}) */
  {
    name:        'Node References — Pass Data Between Nodes',
    description: 'Script A outputs a value. Script B reads it via ${prev} (shorthand for the previous node). Script C uses the explicit ${ref-a} ID. All three syntaxes resolve to the same stdout.',
    tags:        ['example', 'refs'],
    variables:   {},
    nodes: [
      { id: 'nr-trig', type: 'trigger', label: 'Run',            position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'ref-a',   type: 'script',  label: 'Produce value',   position: { x: 240, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "VALUE_FROM_A"' } },
      { id: 'nr-b',    type: 'script',  label: 'Read via ${prev}', position: { x: 490, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "prev said: ${prev}"' } },
      { id: 'nr-c',    type: 'script',  label: 'Read via node ID', position: { x: 740, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "ref-a said: ${ref-a}"' } },
    ],
    edges: [
      { id: 'nr-e1', source: 'nr-trig', target: 'ref-a' },
      { id: 'nr-e2', source: 'ref-a',   target: 'nr-b'  },
      { id: 'nr-e3', source: 'nr-b',    target: 'nr-c'  },
    ],
  },

  /* ── 8. JSON Field Extraction ─────────────────── */
  {
    name:        'JSON Field Extraction',
    description: 'Script A emits a JSON string. Script B reads individual fields using ${json-src.fieldName} dot notation — no manual JSON parsing needed.',
    tags:        ['example', 'refs'],
    variables:   {},
    nodes: [
      { id: 'jx-trig',   type: 'trigger', label: 'Run',           position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'json-src',  type: 'script',  label: 'Emit JSON',      position: { x: 240, y: 0 }, data: { shell: 'powershell', script: 'Write-Output \'{"name":"Autoflow","version":"1.0","ready":true}\'' } },
      { id: 'jx-read',   type: 'script',  label: 'Extract fields', position: { x: 490, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "name=${json-src.name}  version=${json-src.version}  ready=${json-src.ready}"' } },
    ],
    edges: [
      { id: 'jx-e1', source: 'jx-trig',  target: 'json-src' },
      { id: 'jx-e2', source: 'json-src', target: 'jx-read'  },
    ],
  },

  /* ── 9. File: Write, Check & Read ─────────────── */
  {
    name:        'File — Write, Check & Read',
    description: 'Gets a timestamp, writes it to a file, checks the file exists, then reads it back. The FILE_PATH variable controls the target — change it to any path you have write access to.',
    tags:        ['example', 'file'],
    variables:   { FILE_PATH: 'C:\\Users\\Public\\autoflow-demo.txt' },
    nodes: [
      { id: 'fw-trig',   type: 'trigger', label: 'Run',         position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'fw-stamp',  type: 'script',  label: 'Timestamp',   position: { x: 240, y: 0 }, data: { shell: 'powershell', script: 'Get-Date -Format "yyyy-MM-dd HH:mm:ss"' } },
      { id: 'fw-write',  type: 'file',    label: 'Write',        position: { x: 480, y: 0 }, data: { operation: 'write',  path: '${var:FILE_PATH}', content: 'Written by Autoflow at ${fw-stamp}\n' } },
      { id: 'fw-exists', type: 'file',    label: 'Exists?',      position: { x: 720, y: 0 }, data: { operation: 'exists', path: '${var:FILE_PATH}' } },
      { id: 'fw-read',   type: 'file',    label: 'Read back',    position: { x: 960, y: 0 }, data: { operation: 'read',   path: '${var:FILE_PATH}' } },
    ],
    edges: [
      { id: 'fw-e1', source: 'fw-trig',   target: 'fw-stamp'  },
      { id: 'fw-e2', source: 'fw-stamp',  target: 'fw-write'  },
      { id: 'fw-e3', source: 'fw-write',  target: 'fw-exists' },
      { id: 'fw-e4', source: 'fw-exists', target: 'fw-read'   },
    ],
  },

  /* ── 10. File: Append ─────────────────────────── */
  {
    name:        'File — Append Lines',
    description: 'Writes a header then appends two lines. The final Read node shows all three lines in order. Demonstrates the append operation for growing log files.',
    tags:        ['example', 'file'],
    variables:   { LOG_FILE: 'C:\\Users\\Public\\autoflow-append.txt' },
    nodes: [
      { id: 'fa-trig',  type: 'trigger', label: 'Run',          position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'fa-write', type: 'file',    label: 'Write header', position: { x: 240, y: 0 }, data: { operation: 'write',  path: '${var:LOG_FILE}', content: '=== Autoflow log ===\n' } },
      { id: 'fa-app1',  type: 'file',    label: 'Append line 1', position: { x: 480, y: 0 }, data: { operation: 'append', path: '${var:LOG_FILE}', content: 'Line 1 — first entry\n' } },
      { id: 'fa-app2',  type: 'file',    label: 'Append line 2', position: { x: 720, y: 0 }, data: { operation: 'append', path: '${var:LOG_FILE}', content: 'Line 2 — second entry\n' } },
      { id: 'fa-read',  type: 'file',    label: 'Read result',  position: { x: 960, y: 0 }, data: { operation: 'read',   path: '${var:LOG_FILE}' } },
    ],
    edges: [
      { id: 'fa-e1', source: 'fa-trig',  target: 'fa-write' },
      { id: 'fa-e2', source: 'fa-write', target: 'fa-app1'  },
      { id: 'fa-e3', source: 'fa-app1',  target: 'fa-app2'  },
      { id: 'fa-e4', source: 'fa-app2',  target: 'fa-read'  },
    ],
  },

  /* ── 11. Open URL ─────────────────────────────── */
  {
    name:        'Open URL',
    description: 'Opens a URL in your default browser when the flow runs. Swap the URL for any https:// address or a local file path to open it with the system default app.',
    tags:        ['example', 'openurl'],
    variables:   {},
    nodes: [
      { id: 'ou-trig', type: 'trigger', label: 'Run',              position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'ou-url',  type: 'openurl', label: 'Open GitHub page', position: { x: 260, y: 0 }, data: { url: 'https://github.com/GhostUnderBlanket/autoflow/releases' } },
    ],
    edges: [{ id: 'ou-e1', source: 'ou-trig', target: 'ou-url' }],
  },

  /* ── 12. Loop: Repeat N times ─────────────────── */
  {
    name:        'Loop — Repeat N Times',
    description: 'Runs the body script exactly 3 times. Each iteration prints a timestamped line. Change the count in the Loop node to repeat more or fewer times.',
    tags:        ['example', 'loop'],
    variables:   {},
    nodes: [
      { id: 'lr-trig',  type: 'trigger', label: 'Run',        position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'lr-loop',  type: 'loop',    label: 'Repeat × 3', position: { x: 240, y: 0 }, data: { mode: 'repeat', count: 3, delay: 0 } },
      { id: 'lr-stamp', type: 'script',  label: 'Timestamp',  position: { x: 480, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "Run at $(Get-Date -Format \'HH:mm:ss.fff\')"' } },
    ],
    edges: [
      { id: 'lr-e1', source: 'lr-trig', target: 'lr-loop'  },
      { id: 'lr-e2', source: 'lr-loop', target: 'lr-stamp' },
    ],
  },

  /* ── 13. Loop: Retry on Error ─────────────────── */
  {
    name:        'Loop — Retry on Error',
    description: 'Retries the body script until it exits with code 0, up to 5 attempts. The script randomly succeeds ~20% of the time. Demonstrates retry patterns for flaky operations.',
    tags:        ['example', 'loop'],
    variables:   {},
    nodes: [
      { id: 'rr-trig',  type: 'trigger', label: 'Run',       position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'rr-loop',  type: 'loop',    label: 'Retry × 5', position: { x: 240, y: 0 }, data: { mode: 'retry', count: 5, delay: 500 } },
      { id: 'rr-flaky', type: 'script',  label: 'Flaky task', position: { x: 480, y: 0 }, data: {
        shell: 'powershell',
        script: '$r = Get-Random -Max 5\nif ($r -eq 0) {\n  Write-Output "SUCCESS (r=$r)"\n  exit 0\n} else {\n  Write-Output "FAILED (r=$r, need 0)"\n  exit 1\n}',
      }},
    ],
    edges: [
      { id: 'rr-e1', source: 'rr-trig', target: 'rr-loop'  },
      { id: 'rr-e2', source: 'rr-loop', target: 'rr-flaky' },
    ],
  },

  /* ── 14. Loop: forEach (newline list) ─────────── */
  {
    name:        'Loop — forEach (Line-separated List)',
    description: 'A script outputs one item per line. The Loop node iterates over each line and runs the body script with ${loop.item} set to that line. Good for processing lists of strings.',
    tags:        ['example', 'loop'],
    variables:   {},
    nodes: [
      { id: 'fl-trig', type: 'trigger', label: 'Run',          position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'fl-list', type: 'script',  label: 'Generate list', position: { x: 240, y: 0 }, data: { shell: 'powershell', script: '"apple"\n"orange"\n"banana"' } },
      { id: 'fl-loop', type: 'loop',    label: 'For each line', position: { x: 480, y: 0 }, data: { mode: 'forEach', separator: 'newline', delay: 0 } },
      { id: 'fl-proc', type: 'script',  label: 'Process item',  position: { x: 720, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "Processing: ${loop.item}"' } },
    ],
    edges: [
      { id: 'fl-e1', source: 'fl-trig', target: 'fl-list' },
      { id: 'fl-e2', source: 'fl-list', target: 'fl-loop' },
      { id: 'fl-e3', source: 'fl-loop', target: 'fl-proc' },
    ],
  },

  /* ── 15. Loop: forEach (JSON array) ───────────── */
  {
    name:        'Loop — forEach (JSON Array)',
    description: 'A script emits a JSON array of strings. The Loop node parses it and runs the body once per element with ${loop.item} set to each value. For arrays of objects, see the next example.',
    tags:        ['example', 'loop'],
    variables:   {},
    nodes: [
      { id: 'fj-trig',  type: 'trigger', label: 'Run',           position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'fj-emit',  type: 'script',  label: 'Emit JSON array', position: { x: 240, y: 0 }, data: { shell: 'powershell', script: 'Write-Output \'["Apple","Orange","Banana"]\'' } },
      { id: 'fj-loop',  type: 'loop',    label: 'For each item',  position: { x: 480, y: 0 }, data: { mode: 'forEach', separator: 'json-array', delay: 0 } },
      { id: 'fj-print', type: 'script',  label: 'Print item',     position: { x: 720, y: 0 }, data: { shell: 'powershell', script: 'Write-Output "Item: ${loop.item}"' } },
    ],
    edges: [
      { id: 'fj-e1', source: 'fj-trig', target: 'fj-emit'  },
      { id: 'fj-e2', source: 'fj-emit', target: 'fj-loop'  },
      { id: 'fj-e3', source: 'fj-loop', target: 'fj-print' },
    ],
  },

  /* ── 17. Launch App — Basic ──────────────────────── */
  {
    name:        'Launch App — Open Notepad',
    description: 'Opens Notepad when the flow runs. The Launch App node launches any executable on PATH or by full path — no shell script needed. Change the program path to open any app.',
    tags:        ['example', 'launchapp'],
    variables:   {},
    nodes: [
      { id: 'la-trig',   type: 'trigger',   label: 'Run',         position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'la-launch', type: 'launchapp', label: 'Open Notepad', position: { x: 260, y: 0 }, data: { program: 'notepad.exe', args: '', waitForExit: false, focusIfRunning: false } },
    ],
    edges: [{ id: 'la-e1', source: 'la-trig', target: 'la-launch' }],
  },

  /* ── 18. Launch App — Focus if Running + Condition ── */
  {
    name:        'Launch App — Focus or Launch',
    description: 'Opens Notepad — but if it\'s already running, brings its window to the foreground instead of opening a second instance. A Condition node downstream branches on "focused" vs "launched" so you can take different actions in each case.',
    tags:        ['example', 'launchapp', 'condition'],
    variables:   {},
    nodes: [
      { id: 'fl-trig',    type: 'trigger',   label: 'Run',                   position: { x: 0,   y: 0   }, data: { mode: 'manual' } },
      { id: 'fl-launch',  type: 'launchapp', label: 'Focus or Open Notepad', position: { x: 260, y: 0   }, data: { program: 'notepad.exe', args: '', waitForExit: false, focusIfRunning: true } },
      { id: 'fl-cond',    type: 'condition', label: 'Already running?',      position: { x: 520, y: 0   }, data: { source: '${fl-launch}', op: 'equals', value: 'focused' } },
      { id: 'fl-focused', type: 'script',    label: 'Was focused',           position: { x: 760, y: -60 }, data: { shell: 'powershell', script: 'Write-Output "Notepad was already open — brought to focus"' } },
      { id: 'fl-new',     type: 'script',    label: 'Was launched',          position: { x: 760, y: 80  }, data: { shell: 'powershell', script: 'Write-Output "Notepad was not running — launched a new instance"' } },
    ],
    edges: [
      { id: 'fl-e1', source: 'fl-trig',   target: 'fl-launch'  },
      { id: 'fl-e2', source: 'fl-launch', target: 'fl-cond'    },
      { id: 'fl-e3', source: 'fl-cond',   target: 'fl-focused', sourceHandle: 'true'  },
      { id: 'fl-e4', source: 'fl-cond',   target: 'fl-new',     sourceHandle: 'false' },
    ],
  },

  /* ── 19 (was 16). Loop: forEach JSON objects + field extraction ── */
  {
    name:        'Loop — forEach JSON Objects (${loop.item.field})',
    description: 'A script emits a JSON array of objects. The Loop iterates and the REST body uses ${loop.item.title} and ${loop.item.userId} to extract individual fields — no manual JSON parsing needed. Uses the free JSONPlaceholder API.',
    tags:        ['example', 'loop', 'rest'],
    variables:   {},
    nodes: [
      { id: 'jo-trig', type: 'trigger', label: 'Run',              position: { x: 0,   y: 0 }, data: { mode: 'manual' } },
      { id: 'jo-emit', type: 'script',  label: 'Emit objects',      position: { x: 240, y: 0 }, data: {
        shell: 'powershell',
        script: 'Write-Output \'[{"title":"First post","userId":1},{"title":"Second post","userId":2}]\'',
      }},
      { id: 'jo-loop', type: 'loop',    label: 'For each object',   position: { x: 500, y: 0 }, data: { mode: 'forEach', separator: 'json-array', delay: 0 } },
      { id: 'jo-rest', type: 'rest',    label: 'POST post',          position: { x: 760, y: 0 }, data: {
        method:      'POST',
        endpoint:    '',
        urlOverride: 'https://jsonplaceholder.typicode.com/posts',
        bodyMode:    'form',
        bodyRows: [
          { key: 'title',  value: '${loop.item.title}'  },
          { key: 'userId', value: '${loop.item.userId}' },
        ],
      }},
    ],
    edges: [
      { id: 'jo-e1', source: 'jo-trig', target: 'jo-emit' },
      { id: 'jo-e2', source: 'jo-emit', target: 'jo-loop' },
      { id: 'jo-e3', source: 'jo-loop', target: 'jo-rest' },
    ],
  },

];
