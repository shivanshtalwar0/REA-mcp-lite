#!/usr/bin/env node
/**
 * rea-proxy — on-demand MCP facade over the REA MCP server.
 *
 * WHY THIS EXISTS
 * ---------------
 * The REA MCP server exposes 207 tools whose input schemas total 757 KB. The
 * DeepSeek Harness prices tool schemas into every request, so mounting REA
 * directly costs ~194K tokens before a single message is sent — 2-3x a 90K-110K
 * local context window. Every turn failed with CONTEXT_WINDOW_EXCEEDED.
 *
 * This proxy exposes exactly three tiny tools to the model and keeps the full
 * 757 KB catalogue OUT of band, in this process's memory. The model discovers
 * tools and pulls individual schemas only when it needs them.
 *
 * Steady-state context cost: ~1 KB (~250 tokens) instead of 757 KB (~194K).
 *
 * PROTOCOL (what the model sees)
 * ------------------------------
 *   1. rea_find_tools { query }        -> compact "name — description" matches
 *   2. rea_tool_schema { name }        -> that one tool's JSON input schema
 *   3. rea_call { name, arguments }    -> forwards to the real REA tool
 *
 * The backend is spoken to over the same newline-delimited JSON-RPC that the
 * harness uses. No npm dependencies, no SDK version drift.
 *
 * CONFIGURATION (all optional)
 * ----------------------------
 *   REA_MCP_SPEC                npm spec of the backend      (rea-agents@6.7.0)
 *   REA_REA_JS                  direct path to scripts/rea.mjs — bypasses npx,
 *                               which matters because ~/.npm has root-owned
 *                               cache files that break `npx -y` on cache miss.
 *   REA_MCP_INPUT_SCHEMA_PROFILE  full (default) | compact. Keep `full`: the
 *                               schemas never reach the model until asked for,
 *                               and slim() trims them on delivery.
 *   REA_MCP_OUTPUT_SCHEMA_PROFILE full | off (default off). Output schemas are
 *                               only used for validation; they add nothing.
 *   REA_PROXY_MAX_SCHEMA_BYTES  per-schema delivery cap          (24000)
 *   REA_PROXY_TIMEOUT_MS        backend request timeout         (240000)
 *   HOPPER_LAUNCHER_PATH        passed through to REA (Hopper adapter)
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CFG = {
  spec: process.env.REA_MCP_SPEC ?? 'rea-agents@6.7.0',
  direct: process.env.REA_REA_JS ?? '',
  maxSchemaBytes: Number(process.env.REA_PROXY_MAX_SCHEMA_BYTES ?? 24000),
  timeoutMs: Number(process.env.REA_PROXY_TIMEOUT_MS ?? 240000),
  descChars: 110,
};

const log = (...a) => process.stderr.write('[rea-proxy] ' + a.join(' ') + '\n');

// ---------------------------------------------------------------------------
// Backend: one long-lived REA MCP child process, lazily started.
// ---------------------------------------------------------------------------

let child = null;
let booting = null;          // Promise<catalogue> while starting
let closing = false;
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject, timer }
let catalogue = null;        // Array<tool> once queried
let directPath;              // resolved once: node <directPath> mcp

/** Compare dotted versions; enough for picking the newest cached install. */
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Find an already-installed rea-agents in the npx cache.
 *
 * `npx -y <spec>` is unusable on machines where ~/.npm contains root-owned
 * files (a known npm bug): every cache miss dies with EPERM and the MCP server
 * never starts. Resolving the cached tree directly removes npm from the
 * startup path entirely.
 */
function discoverCachedRea() {
  if (CFG.direct) return CFG.direct;
  const root = join(homedir(), '.npm', '_npx');
  let best = null;
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const bin = join(root, entry, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    try {
      if (!statSync(bin).isFile()) continue;
      const manifest = join(dirname(dirname(bin)), 'package.json');
      const version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0';
      if (!best || newerVersion(version, best.version) > 0) best = { bin, version };
    } catch {
      // unreadable or half-installed cache entry — try the next one
    }
  }
  if (best) log(`using cached rea-agents ${best.version} (npm bypassed)`);
  return best?.bin ?? null;
}

function resolveDirect() {
  if (directPath === undefined) directPath = discoverCachedRea();
  return directPath;
}

function backendCommand() {
  return resolveDirect() ? process.execPath : 'npx';
}

function backendArgv() {
  const direct = resolveDirect();
  return direct ? [direct, 'mcp'] : ['-y', CFG.spec, 'mcp'];
}

function write(msg) {
  if (!child || child.killed) throw new Error('backend not running');
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`backend ${method} timed out after ${CFG.timeoutMs}ms`));
    }, CFG.timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      write({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function settleAll(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

async function boot() {
  child = spawn(backendCommand(), backendArgv(), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      REA_MCP_INPUT_SCHEMA_PROFILE: process.env.REA_MCP_INPUT_SCHEMA_PROFILE ?? 'full',
      REA_MCP_OUTPUT_SCHEMA_PROFILE: process.env.REA_MCP_OUTPUT_SCHEMA_PROFILE ?? 'off',
    },
  });

  child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('error', (error) => {
    log('backend spawn failed:', error.message);
    settleAll(error);
  });

  child.on('exit', (code, signal) => {
    const why = `backend exited (code=${code} signal=${signal})`;
    if (!closing) log(why);
    settleAll(new Error(why));
    child = null;
    booting = null;
    catalogue = null;
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-protocol noise on stdout
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new Error(msg.error.message ?? 'backend error'));
    else slot.resolve(msg.result);
  });

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rea-proxy', version: '1.0.0' },
  });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  const tools = Array.isArray(list?.tools) ? list.tools : [];
  log(`backend ready: ${tools.length} REA tools (out of band)`);
  return tools;
}

async function catalogueOf() {
  if (catalogue) return catalogue;
  if (!booting) {
    booting = boot().then(
      (tools) => {
        catalogue = tools;
        return tools;
      },
      (error) => {
        booting = null;
        throw error;
      },
    );
  }
  return await booting;
}

// ---------------------------------------------------------------------------
// Schema delivery: keep structure, trim prose, hard-cap bytes.
// ---------------------------------------------------------------------------

/**
 * Recursively drop bulky, model-useless fields while preserving the structural
 * contract (type / properties / required / enum / items / oneOf).
 */
function slim(node, descCap) {
  if (Array.isArray(node)) return node.map((n) => slim(n, descCap));
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'examples' || key === 'default' || key === '$comment' || key === '$schema') continue;
    if (key === 'description' && typeof value === 'string') {
      out[key] = value.length > descCap ? value.slice(0, descCap) + '…' : value;
      continue;
    }
    out[key] = slim(value, descCap);
  }
  return out;
}

function renderSchema(tool, budget) {
  const schema = tool.inputSchema ?? { type: 'object', properties: {} };
  let text = JSON.stringify(schema, null, 2);
  let note = '';
  for (const [cap, label] of [[400, 'long descriptions trimmed'], [120, 'descriptions trimmed'], [50, 'descriptions heavily trimmed']]) {
    if (text.length <= budget) break;
    text = JSON.stringify(slim(schema, cap), null, 2);
    note = `\n\n(note: ${label} to fit the context budget; structure is intact)`;
  }
  if (text.length > budget) {
    text = text.slice(0, budget) + '\n… [truncated]';
    note = '\n\n(note: schema truncated. Prefer a narrower tool; if you must use this one, call it and read the validation error.)';
  }
  return text + note;
}

// ---------------------------------------------------------------------------
// Discovery: rank by name match, then description match.
// ---------------------------------------------------------------------------

function score(tool, q) {
  const name = tool.name.toLowerCase();
  const desc = (tool.description ?? '').toLowerCase();
  let s = 0;
  if (name === q) s += 1000;
  if (name.startsWith(q)) s += 400;
  if (name.includes(q)) s += 200;
  if (desc.includes(q)) s += 60;
  // reward word-boundary matches in the name
  for (const word of q.split(/[\s_-]+/).filter(Boolean)) {
    if (name.split(/[_]/).includes(word)) s += 80;
    else if (name.includes(word)) s += 25;
    if (desc.includes(word)) s += 12;
  }
  return s;
}

function findTools(tools, query, limit) {
  const q = (query ?? '').trim().toLowerCase();

  if (!q) {
    const names = tools.map((t) => t.name).slice(0, 200);
    const extra = tools.length - names.length;
    return `${tools.length} REA tools available. Call rea_find_tools with a query to filter, `
      + `then rea_tool_schema(name) for the input contract, then rea_call(name, arguments).\n\n`
      + names.join(', ') + (extra > 0 ? `, …(+${extra} more)` : '');
  }

  const ranked = tools
    .map((t) => ({ tool: t, s: score(t, q) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);

  if (ranked.length === 0) {
    return `No REA tool matched "${query}". Try a broader term (e.g. "binary", "decompile", "browser", "capture", "compare", "extract"), or call rea_find_tools with no query to list all names.`;
  }

  const shown = ranked.slice(0, limit);
  const lines = shown.map(({ tool }) => {
    const desc = (tool.description ?? '').replace(/\s+/g, ' ').trim();
    const short = desc.length > CFG.descChars ? desc.slice(0, CFG.descChars) + '…' : desc;
    return `${tool.name} — ${short}`;
  });

  const more = ranked.length - shown.length;
  return `${ranked.length} match(es) for "${query}"${more > 0 ? `, top ${shown.length}` : ''}:\n`
    + lines.join('\n')
    + `\n\nNext: rea_tool_schema(name) for the input contract, then rea_call(name, arguments).`;
}

// ---------------------------------------------------------------------------
// Frontend: the three-tool MCP surface.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'rea_find_tools',
    description:
      'Search the REA reverse-engineering toolset (207 tools: native binaries, Electron apps, '
      + 'browser pages, APK/adb, electron fuses, JS bundles, managed code, WASM, SQLite, artifacts, '
      + 'memory captures, version diffs). Returns matching tool names with one-line descriptions. '
      + 'Call this first; an empty query lists every tool name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to match against tool names/descriptions, e.g. "electron", "decompile", "compare versions". Empty string lists all tool names.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return (default 15, max 40).',
          minimum: 1,
          maximum: 40,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rea_tool_schema',
    description:
      'Return the full JSON input schema for exactly one REA tool. Call this after rea_find_tools '
      + 'and before rea_call, so the arguments you pass are valid. Oversized schemas are trimmed '
      + 'in prose but keep their structure.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact REA tool name, e.g. "capture_browser_scenario".' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'rea_call',
    description:
      'Invoke one REA tool by name with JSON arguments, matching the schema from rea_tool_schema. '
      + 'Returns the tool result verbatim (text and structured content).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact REA tool name.' },
        arguments: { type: 'object', description: 'Arguments object for that tool. Omit for tools with no required input.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

async function handleCall(name, args) {
  const tools = await catalogueOf();

  if (name === 'rea_find_tools') {
    const rawLimit = args.limit;
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 40) : 15;
    return { content: [{ type: 'text', text: findTools(tools, args.query, limit) }] };
  }

  if (name === 'rea_tool_schema') {
    const wanted = args.name;
    const tool = tools.find((t) => t.name === wanted);
    if (!tool) {
      const near = tools.filter((t) => t.name.includes(String(wanted ?? '').toLowerCase())).slice(0, 8).map((t) => t.name);
      return {
        content: [{
          type: 'text',
          text: `Unknown REA tool "${wanted}".`
            + (near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use rea_find_tools to search.'),
        }],
        isError: true,
      };
    }
    const rawDesc = (tool.description ?? '').trim();
    const desc = rawDesc.length > 1500 ? rawDesc.slice(0, 1500) + ' … (description truncated)' : rawDesc;
    // One budget for the whole delivery, so a 20 KB description cannot smuggle
    // an oversized payload past the schema cap.
    const budget = Math.max(4000, CFG.maxSchemaBytes - Buffer.byteLength(desc));
    const text = `# ${tool.name}\n\n${desc}\n\n## Input schema (JSON)\n\n${renderSchema(tool, budget)}`;
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'rea_call') {
    const wanted = args.name;
    const tool = tools.find((t) => t.name === wanted);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown REA tool "${wanted}". Use rea_find_tools first.` }],
        isError: true,
      };
    }
    const callArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
    const result = await request('tools/call', { name: wanted, arguments: callArgs });
    return result ?? { content: [{ type: 'text', text: '(no result returned)' }] };
  }

  return {
    content: [{ type: 'text', text: `Unknown proxy tool "${name}". Available: rea_find_tools, rea_tool_schema, rea_call.` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC loop
// ---------------------------------------------------------------------------

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function dispatch(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        respond(id, {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'rea-proxy', version: '1.0.0' },
        });
        return;
      }
      case 'ping':
        respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        try {
          respond(id, await handleCall(name, args));
        } catch (error) {
          respond(id, {
            content: [{
              type: 'text',
              text: `REA proxy error: ${error?.message ?? String(error)}\n\n`
                + `If this is a backend startup failure, check that "${CFG.spec}" is resolvable `
                + `(or set REA_REA_JS to a direct scripts/rea.mjs path).`,
            }],
            isError: true,
          });
        }
        return;
      }
      default:
        respondError(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    respondError(id, -32603, error?.message ?? String(error));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void dispatch(msg);
});

function shutdown() {
  closing = true;
  try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);

// Warm the backend in the background so the first rea_find_tools is fast, but
// never block tools/list on it — the harness must always be able to register.
catalogueOf().catch((error) => log('warm-up failed:', error.message));
