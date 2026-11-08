# REA MCP Lite

An on-demand MCP proxy for [REA](https://github.com/morluto/rea) that keeps **all 207 reverse-engineering tools** available while cutting their context cost from **~193,000 tokens to ~415**.

If you have ever mounted REA's MCP server and watched every turn fail with `CONTEXT_WINDOW_EXCEEDED` before you typed anything — this is the fix.

---

## The problem

MCP clients inline **every tool's input schema into every request**. REA's catalogue is enormous:

| | Direct mount | rea-mcp-lite |
|---|---:|---:|
| Tools advertised | 207 | **3** |
| Schema bytes per request | 755 KB | **1,657 B** |
| Tokens per request (~4 chars/token) | ~193,000 | **~415** |
| Fits a 90K-token window? | ❌ no | ✅ yes |
| Reduction | — | **~465x** |

Measured on a real session against a 90,112-token local model:

```
direct mount : 243 tools, 787.6 KB header, ~201,638 tok  ->  hard failure
               "Message too long: 266784 tokens exceeds the 90112-token context window"
with proxy   :  39 tools,  32.4 KB header,   ~8,305 tok  ->  works
```

Two things make this unrecoverable without a proxy:

1. **Auto-compaction cannot help.** Compaction prunes *messages*; the bloat is 96% *tool schemas*, which it never touches. Compaction ran and also blew the window.
2. **Only one tool needs to kill you.** `compare_web_captures` alone is 162.7 KB (~41,000 tokens). Its schema is bigger than most context windows' entire working budget.

---

## How it works

The proxy exposes three tiny tools and holds the full 207-tool catalogue out of band, in its own process memory.

```
agent ──rea_find_tools{query}────▶ proxy ──▶ matching names + one-line summaries
      ──rea_tool_schema{name}────▶ proxy ──▶ that ONE tool's schema (≤24 KB)
      ──rea_call{name,arguments}─▶ proxy ──▶ REA backend ──▶ result verbatim
```

Nothing about REA is removed or reimplemented. Every tool stays callable; the schemas are simply fetched on demand instead of paid for up front.

### Cost per call

| Call | Typical cost |
|---|---|
| steady state (no REA calls) | **~415 tokens** |
| `rea_find_tools{query}` | ~1–2 KB (~250–500 tokens) |
| `rea_find_tools{}` (full list, names only) | ~4.5 KB (~1,100 tokens) |
| `rea_tool_schema{name}` | 20 B – 23.6 KB (capped) |
| `rea_call` | whatever that tool returns |

Worst-case single schema is ~6,000 tokens — versus 41,000 for the same tool mounted directly.

---

## Requirements

- **Node.js 18+**
- **REA** — `rea-agents` ≥ 6.7.0, either already installed or resolvable by `npx`
- macOS or Linux (Windows untested)

---

## Install

```bash
git clone https://github.com/shivanshtalwar0/REA-mcp-lite.git
cd REA-mcp-lite
node scripts/doctor.mjs
```

`doctor` verifies the backend resolves, counts the catalogue, and confirms the proxy surface. Expected output:

```
rea-mcp-lite doctor

  node            v24.15.0  (/path/to/node)
  proxy           /path/to/rea-proxy.mjs
  backend         cached rea-agents 6.7.0 (/path/.npm/_npx/.../scripts/rea.mjs)
  ✓ backend answered: 207 tools
  catalogue       207 tools
  schemas         3084 KB raw / 755 KB model-facing
  if mounted      ~193,289 tokens of every request
  ✓ proxy answered: 3 tools
  tool surface    rea_find_tools, rea_tool_schema, rea_call
  wire size       1,657 bytes (~415 tokens)

PASS — ready to mount.
```

---

## Quickstart — DeepSeek Harness (DSH)

This is the client it was built for. DSH prices tool schemas into every request via
`dsh-token-meter`:

```js
Math.ceil(JSON.stringify(header.tools).length / 4) + 4
```

A 755 KB catalogue therefore costs ~193K tokens *per turn, forever*.

### 1. Add the mount

Edit `~/.dsh/cordis.patch.yml` (the home-level user layer, applied to every profile):

```yaml
- insert:
    - id: rea-proxy
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /Users/you/.nvm/versions/node/v22.14.0/bin/node
        args:
          - /Users/you/REA-mcp-lite/rea-proxy.mjs
        env:
          HOPPER_LAUNCHER_PATH: /Applications/Hopper Disassembler.app/Contents/MacOS/hopper
```

### 2. The two things people get wrong

**`command` must be an absolute node path.** DSH is a desktop app; launched from Finder it
inherits a minimal `PATH` that does not include nvm or Homebrew bins. `command: node` fails
with `ENOENT`. Do not use the app's bundled `runtime/bin/node` either — that is a wrapper
script requiring `$DSH_DESKTOP_NODE_EXECUTABLE`, which env scrubbing strips.

**The file must stay a YAML array.** A patch file with only comments parses as `null`
and DSH fails to boot it. Keep at least `[]` or a real entry.

### 3. Restart and confirm

Restart DSH, then check the context meter in the composer. *Tool definitions* should read
**~400–500 tokens**, not ~194,000. Your REA tools appear as:

```
mcp__rea__rea_find_tools
mcp__rea__rea_tool_schema
mcp__rea__rea_call
```

### 4. Verify against the real payload (optional)

DSH logs each request envelope. This prints the tool count and size per request:

```bash
S=~/.dsh/sessions/$(ls ~/.dsh/sessions | head -1)
zstd -d -c "$S"/session*.zstd | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
for(const l of d.split("\n")){if(!l)continue;let o;try{o=JSON.parse(l)}catch{continue}
if(o.type==="request/header"&&o.data?.header?.tools){const t=o.data.header.tools;
console.log(o.seq, t.length, "tools", (JSON.stringify(t).length/1024).toFixed(1)+"KB");}}})'
```

---

## Quickstart — other MCP clients

Any stdio MCP client works. The proxy speaks plain newline-delimited JSON-RPC.

**Claude Code**

```bash
claude mcp add rea-lite -- node /absolute/path/to/rea-proxy.mjs
```

**Generic JSON config (Cursor, VS Code, Windsurf, …)**

```json
{
  "mcpServers": {
    "rea": {
      "command": "node",
      "args": ["/absolute/path/to/rea-proxy.mjs"],
      "env": {
        "HOPPER_LAUNCHER_PATH": "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper"
      }
    }
  }
}
```

> These clients launch from a normal shell, so plain `node` is fine. Only the
> Finder-launched DSH app needs the absolute path.

---

## Agent workflow

The three tools are designed to be used in order. Prompts that work well:

```
"Find REA tools for inspecting Electron fuses"
"Get the schema for inspect_binary_layout"
"Call inspect_binary_layout on /path/to/binary with detail=summary"
```

The intended loop is **search → schema → call**. `rea_tool_schema` exists because
guessing REA's argument shapes wastes turns; the schema is the contract, and REA
validates strictly:

```
Input validation error: Invalid arguments for tool inspect_binary_layout:
  path: Invalid input: expected string, received undefined, Unrecognized key: "target"
```

That error is the feedback signal — read it, correct the arguments, retry.

---

## Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `REA_MCP_SPEC` | `rea-agents@6.7.0` | npm spec used when no cached install is found |
| `REA_REA_JS` | — | Absolute path to `scripts/rea.mjs`; bypasses both discovery and npx |
| `REA_MCP_INPUT_SCHEMA_PROFILE` | `full` | `full` or `compact`. Keep `full` — the proxy trims on delivery |
| `REA_MCP_OUTPUT_SCHEMA_PROFILE` | `off` | Output schemas only validate results; they add nothing to the model |
| `REA_PROXY_MAX_SCHEMA_BYTES` | `24000` | Per-schema delivery cap |
| `REA_PROXY_TIMEOUT_MS` | `240000` | Backend request timeout |
| `HOPPER_LAUNCHER_PATH` | — | Passed through to REA's Hopper adapter |

---

## Troubleshooting

### Backend exits with code 1 and an npm EPERM

```
npm error code EPERM
npm error Your cache folder contains root-owned files
```

`npx -y` fails on **every cache miss** when `~/.npm` contains root-owned files (a known npm bug). The proxy sidesteps this two ways, in order:

1. It **discovers** an existing install under `~/.npm/_npx/*/node_modules/rea-agents/scripts/rea.mjs` and spawns it directly with the same node binary — npm never runs.
2. If nothing is cached, it falls back to `npx -y <spec>`.

If you hit EPERM anyway, either repair the cache or point the proxy at REA explicitly:

```bash
sudo chown -R 501:20 ~/.npm
# or
REA_REA_JS=/path/to/real-rea/scripts/rea.mjs  node rea-proxy.mjs
```

### `spawn node ENOENT`

The client launches without your shell's `PATH`. Use an absolute path to the node binary in the client config.

### `Unknown REA tool "foo"`

Call `rea_find_tools` first — tool names must be exact. The error response includes near-miss suggestions.

### `schema truncated`

The tool's real schema exceeds `REA_PROXY_MAX_SCHEMA_BYTES` (24 KB default). The note tells you so. Either raise the cap (at a token cost) or prefer a narrower tool — the fat ones are usually orchestration wrappers around smaller primitives.

### First REA call is slow

Expected. The backend boots in ~0.7–2 s on first use, then stays warm for the life of the process. `rea_find_tools` and `rea_tool_schema` then answer in single-digit milliseconds.

### Tools disappeared / went stale after upgrading REA

The catalogue is cached per process. Restart the client (or kill the proxy) to re-read it.

---

## Limitations

- **Descriptions are truncated** at 1,500 characters in `rea_tool_schema` responses. For REA, descriptions are long design documents; the schema is what you actually need.
- **Schemas are capped** at 24 KB, trimmed prose-first, structure preserved.
- **No forwarding** of MCP resources, prompts, or `list_changed` notifications. Tools only.
- **One backend per proxy.** Calls share it; REA handles its own concurrency.
- **No streaming.** `rea_call` returns when the tool completes.

---

## Security

The proxy gives the agent whatever REA can do — and REA reads local files, binaries, app bundles, databases, and browser profiles. Anything that can talk to this proxy can read your filesystem.

- stdio only; **no network listener**
- no credentials, no telemetry, no outbound traffic
- run it only in sessions you would trust with full local file access

---

## Files

```
rea-proxy.mjs              the proxy (dependency-free, ~530 lines)
scripts/doctor.mjs         end-to-end setup verification
examples/dsh-cordis.patch.yml   ready-to-adapt DSH mount
package.json               npm metadata (bin: rea-mcp-lite)
```

No dependencies. No build step. One file to audit.

---

## Why not just use REA's CLI?

You can, and it costs zero schema tokens:

```bash
npx -y rea-agents@6.7.0 <command>
```

The tradeoff is ergonomics. The CLI gives the model no discoverable contract — it must
guess subcommands and flags, then parse `--help` output. Small local models are bad at
this. The proxy gives the same tools with an explicit, verifiable schema per call while
keeping the context cost near zero.

Use the CLI for scripted work; use the proxy when an agent needs to choose tools itself.

---

## License

MIT — see [LICENSE](LICENSE).

REA itself is a separate project by [morluto](https://github.com/morluto/rea) and is not
included or modified here.
