#!/usr/bin/env node
/**
 * doctor — verify rea-mcp-lite end to end.
 *
 * Checks, in order:
 *   1. this node version
 *   2. how the REA backend is resolved (cached install, explicit path, or npx)
 *   3. the backend answers tools/list and how big its catalogue is
 *   4. the proxy answers tools/list and how big ITS surface is
 *
 * Run with: node scripts/doctor.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = resolve(HERE, '..', 'rea-proxy.mjs');
const SPEC = process.env.REA_MCP_SPEC ?? 'rea-agents@6.7.0';

let failures = 0;
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { failures++; console.log('  \u2717 ' + m); };
const info = (k, v) => console.log('  ' + k.padEnd(16) + v);

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function cachedRea() {
  const root = join(homedir(), '.npm', '_npx');
  let best = null;
  let entries = [];
  try { entries = readdirSync(root); } catch { return null; }
  for (const entry of entries) {
    const bin = join(root, entry, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    try {
      if (!statSync(bin).isFile()) continue;
      const version = JSON.parse(readFileSync(join(dirname(dirname(bin)), 'package.json'), 'utf8')).version ?? '0.0.0';
      if (!best || newerVersion(version, best.version) > 0) best = { bin, version };
    } catch { /* skip */ }
  }
  return best;
}

function resolveBackend() {
  if (process.env.REA_REA_JS) return { cmd: process.execPath, args: [process.env.REA_REA_JS, 'mcp'], label: 'REA_REA_JS=' + process.env.REA_REA_JS };
  const cached = cachedRea();
  if (cached) return { cmd: process.execPath, args: [cached.bin, 'mcp'], label: `cached rea-agents ${cached.version} (${cached.bin})` };
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npx, args: ['-y', SPEC, 'mcp'], label: `npx -y ${SPEC} (no cached install found)` };
}

/** Spawn a stdio MCP server, initialize, and return its tools. */
function listTools({ cmd, args, env }, timeoutMs = 240000) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish({ error: `timeout after ${timeoutMs}ms`, stderr }), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); finish({ error: e.message, stderr }); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          finish({ tools: msg.result?.tools ?? [], stderr });
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } },
    }) + '\n');
  });
}

console.log('\nrea-mcp-lite doctor\n');
info('node', process.version + '  (' + process.execPath + ')');
info('proxy', PROXY);

const backend = resolveBackend();
info('backend', backend.label);

const be = await listTools(backend);
if (be.error) {
  bad('backend did not answer tools/list: ' + be.error);
  if (be.stderr) console.log('\n  backend stderr:\n' + be.stderr.split('\n').slice(-8).map((l) => '    ' + l).join('\n'));
} else {
  const raw = JSON.stringify(be.tools).length;
  const inputOnly = JSON.stringify(be.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length;
  ok(`backend answered: ${be.tools.length} tools`);
  info('catalogue', `${be.tools.length} tools`);
  info('schemas', `${(raw / 1024).toFixed(0)} KB raw / ${(inputOnly / 1024).toFixed(0)} KB model-facing`);
  info('if mounted', `~${Math.ceil(inputOnly / 4).toLocaleString()} tokens of every request`);
}

const px = await listTools({ cmd: process.execPath, args: [PROXY], env: {} });
if (px.error) {
  bad('proxy did not answer tools/list: ' + px.error);
} else {
  const bytes = JSON.stringify(px.tools).length;
  ok(`proxy answered: ${px.tools.length} tools`);
  info('tool surface', px.tools.map((t) => t.name).join(', '));
  info('wire size', `${bytes.toLocaleString()} bytes (~${Math.ceil(bytes / 4)} tokens)`);
}

console.log('');
if (failures === 0) {
  console.log('PASS \u2014 ready to mount. See examples/dsh-cordis.patch.yml\n');
  process.exit(0);
}
console.log(`FAIL \u2014 ${failures} check(s) failed. See Troubleshooting in README.md\n`);
process.exit(1);
