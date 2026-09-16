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
├── bin/                         companion CLI (symlink or copy the repo's bin/ here)
├── secrets.files                optional: extra files to harvest secret values from
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

## Companion CLI

The panel shows real data only if something fills the store. That is what `bin/` does:

```bash
# point it at your DSH home and memory root, then do a first full backfill
python3 bin/memory-scan.py --full --root ~/agent-memory --dsh-home ~/.dsh

# record one durable preference right now (also refreshes digest.md)
python3 bin/memory-note.py "prefers terse, evidence-backed answers" --section "沟通"

# after distilling candidates, clear the pending counter
python3 bin/memory-scan.py --mark-distilled
```

Path resolution — first match wins:

| value | order |
|---|---|
| store root | `--root` → `$AGENT_MEMORY_ROOT` → the store the script itself sits in (`<store>/bin/…`) → `$DSH_HOME/agent-memory` |
| DSH home | `--dsh-home` → `$DSH_HOME` → `~/.dsh` |
| session logs | `--sessions` → `$DSH_HOME/sessions/<derived from cwd>` |

The easiest wiring is to **symlink or copy `bin/` into your store** (`<store>/bin/`): the scripts
then auto-detect the store, and the panel's copy-ready commands work as-is.

Run it on a timer (5 minutes is plenty — an idle incremental scan costs ~0.2 s):

```ini
# /etc/systemd/system/agent-memory.service
[Service]
Type=oneshot
User=<your-user>
Environment=DSH_HOME=/var/lib/dsh
WorkingDirectory=/path/to/your/project   # used to pick the right session directory
ExecStart=/usr/bin/python3 /path/to/agent-memory/bin/memory-scan.py --quiet
```

### What the CLI does with secrets

Everything written into the store passes through `bin/redact.py` first: known secret *values*
harvested from configured files, plus structural patterns (bearer/basic headers, `token=`, cookie
records and cookie headers, JWTs, `sk-…`, `ghp_…`, bcrypt hashes, private keys, literal
`password=…` assignments). List extra sources in `<store>/secrets.files` (one path per line);
each is auto-detected as a Netscape cookie jar, a `KEY=VALUE` file, or a single-token file.
`$DSH_HOME/.credentials.yaml` is read when present. Run `python3 bin/redact.py` for its self-test.

### Storage model

Raw messages are a **working set**: after each run the oldest records beyond `EVIDENCE_KEEP` (120)
are compacted away and a line is appended to `evidence/archive.jsonl`. Nothing is lost — the
authoritative copy is DSH's own session log, and `--rebuild` regenerates the store from it.

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
