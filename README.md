# dsh-agent-memory

A long-term memory plugin for DeepSeek Harness (DSH): real-time capture of conversation evidence,
a read-only data browser, and a status panel inside the Web UI.

**Built to survive DSH upgrades**: zero runtime dependencies, every capability feature-detected,
every callback wrapped — and it deliberately stays out of the prompt-injection path.

| | |
|---|---|
| ✅ Real-time capture | Hooks `session/event` and appends human user messages to `evidence/live-messages.jsonl` |
| ✅ Status panel | `/dsh-agent-memory/panel`, surfaced as a `记忆` tab inside the conversation view |
| ✅ Read-only data browser | 10 whitelisted endpoints under `/dsh-agent-memory/data/<kind>` |
| ✅ Self-check & circuit breaker | Capabilities are probed at load; a failing one trips after N errors without affecting DSH |
| ❌ No prompt injection | Injection stays with the official `@deepseek-ai/dsh-agent-instructions` + `$DSH_HOME/AGENTS.md`. This plugin never touches `agent/pre-step` / `agent.inbox` — internal APIs and the most upgrade-fragile layer |

## Install

```bash
# from a local checkout
dsh plugin --profile web add link:/path/to/dsh-agent-memory

# from GitHub
dsh plugin --profile web add github:<owner>/dsh-agent-memory

# restart the instance the profile serves
systemctl restart dsh-web-<your-instance>
```

Verify what actually got composed — run it as the DSH user **with** `DSH_HOME` set, because running
it as root reads a different profile:

```bash
sudo -u <dsh-user> env DSH_HOME=/var/lib/dsh dsh --profile web --dump-config \
  | grep -A8 dsh-agent-memory
```

Uninstall / roll back:

```bash
dsh plugin --profile web remove dsh-agent-memory
```

## Configuration

Set in the entry's `config` (see `cordis.patch.yml`), or override from your own profile patch.
The shipped defaults are machine-independent: the store lands under `$DSH_HOME`.

| key | default | meaning |
|---|---|---|
| `storeRoot` | `$DSH_HOME/agent-memory` | memory store root |
| `dshHome` | `$DSH_HOME` (or `~/.dsh`) | used to locate `AGENTS.md` |
| `routePrefix` | `/dsh-agent-memory` | prefix for the panel and data routes |
| `breakerThreshold` | `5` | consecutive failures before a capability trips |
| `allowUnfencedPanel` | `false` | serve the panel when the browser-trust fence is unavailable (**fail-closed by default**) |

## Memory store layout

The plugin only reads this layout; the companion CLI writes it:

```
<storeRoot>/
├── preferences/merlin.md        the preference set (this is what gets injected)
├── preferences/evidence.md      per-item provenance (not injected)
├── skills/index.md, *.md        reusable playbooks
├── evidence/user-messages.jsonl rolling working set of human messages
├── evidence/live-messages.jsonl written by this plugin, merged by the CLI
├── evidence/signals.jsonl       candidate preferences awaiting distillation
├── evidence/archive.jsonl       ledger of compacted raw messages
├── digest.md                    session-start brief
└── bin/memory-scan.py, memory-note.py
```

Raw messages are a **working set, not an archive**: the authoritative copy is DSH's own session
log, so older records are compacted away and can be rebuilt from `$DSH_HOME/sessions`.

## Endpoints

| route | purpose |
|---|---|
| `/dsh-agent-memory/panel` | self-contained HTML panel, auto-refreshing |
| `/dsh-agent-memory/status.json` | machine-readable status |
| `/dsh-agent-memory/data/<kind>` | `human` `live` `signals` `preferences` `digest` `agents` `skills` `journal` `archive` `prefEvidence` |

Every route passes DSH's browser-trust fence (`connection.requestRejection`); when the fence is
unavailable the panel is **fail-closed**. The data endpoints are a fixed whitelist, so there is no
arbitrary-path entry point.

## Compatibility rules

1. **Zero runtime dependencies** — only `node:fs`, `node:path`, `node:os`, `node:module`.
2. **No hard dependencies** — `inject: []`; `webServer`/`connection` are awaited optionally through `ctx.inject([...], cb)` and degrade to `unavailable`.
3. **All callbacks wrapped** — nothing propagates into DSH.
4. **Circuit breaker** — a failing capability disables only itself, and the reason shows up in the panel.
5. **Writes only under `storeRoot`** — never edits DSH config or other plugins.
6. **Degradation chain** — plugin down ⇒ the CLI timer still collects; panel down ⇒ journal/digest still work; plugin gone ⇒ injection and the store are unaffected.

`package.json` carries `dsh.compatibility.dshReleases`, and the panel displays the detected DSH
version, so a version mismatch after an upgrade is visible at a glance.

## Development

```bash
node test/selftest.mjs
```

Eight checks: message filtering/dedupe, the panel, the trust fence (fail-closed), the circuit
breaker, loading with no services present, a guard asserting every value path used by the panel
script exists in the payload, and the data-endpoint whitelist.

## License

MIT
