# zsh-opencode-mini

A small, self-contained layer that makes `opencode` aware of your shell:
every command is recorded to a local store, and opencode gets a lazy,
structured way to consult it. The terminal stays yours.

> **i18n**: `README.md` (English) is the source of truth. [`README.zh-CN.md`](README.zh-CN.md)
> follows it and may lag. When in doubt, read the English version.

Part of the [wez-ai](../IMPLEMENTATION_ROUTES.md) route map — this is the
"small" route (shell hooks + opencode mini). The data layer designed here
(history store, OSC frame format, failure signal) is terminal-side final:
the wezterm fork can adopt it as-is.

## Principle

**Zero intrusion into zsh.** Registers only via `add-zsh-hook` (the same
convention as direnv / python-autoenv), never overwrites widgets, never
touches the prompt. Uninstall = delete the source line.

## Architecture: two hook surfaces, one config file

```text
  config: ~/.config/zsh-opencode-mini/config.jsonc
          "shell" section -> plugin.zsh (jq)   |   "companion"+"recipes" sections -> zom-companion.js

┌─ zsh side (plugin.zsh) ─────────────┐     ┌─ opencode side (zom-companion.js) ──┐
│                                     │     │                                     │
│  preexec ─┐                         │     │  setup(): contract check — loud     │
│           ├─► history-YYYY-MM.jsonl │◄────┤  fail on plugin-API mismatch        │
│  precmd ──┤        (read)           │     │  (major ≠ 2 / missing ctx surfaces) │
│           ├─► last-failure.json     │◄────┤                                     │
│           │   (on ≠0, atomic)       │     │  custom tool zom_context:           │
│           │                         │     │   last_failure / recent — the lazy  │
│           └─► OSC 7777;zom;v1;<b64>─┼─► wezterm fork, hole 1 (future)         │
│                                     │     │                                     │
│  precmd ◄─── outbox.jsonl ──────────┼─────┤  recipes fire on failure /          │
│  (byte cursor; one `zom: <text>`    │◄────┤  bg-done / manual; the outbox is    │
│   hint line before next prompt)     │     │  the plugin→shell return channel    │
│                                     │     │                                     │
│  C-x ─► opencode mini ─────────────────────► inject ONE line; else silence     │
│           --agent zsh-companion ──────────► agent/zsh-companion.md (behavior)  │
└─────────────────────────────────────┘     └─────────────────────────────────────┘
```

- **zsh hooks** produce data (record, signal, OSC frame). One-way writes.
- **opencode hooks** consume data (contract-anchored custom tool + context
  injection). The strategy lives here, mechanically: nothing enters context
  unless the freshness rule fires or the agent chooses to look.
- **outbox.jsonl is the only plugin→shell return channel.** The opencode side
  is its sole writer (append-only); the shell drains new bytes once per
  prompt from a byte cursor it alone owns, printing one `zom: <text>` line
  before your prompt. Recipe results and background-session completion
  notices share this one pipe — no second channel exists.
- **agent definition** carries only behavior rules, not strategy — strategy
  moved from prompt conventions into code.
- **One config file, two consumers.** The plugin runs in two runtimes (a zsh
  process and the opencode server), so there are two readers — but exactly
  one config file, each side reading its own section. No env-var surface.

## Context strategy

Lazy loading by default. The AI answers ordinary questions from the scene
(git, files, cwd) with zero injected context. History and failure signals are
opt-in, through two paths:

1. **Heuristic signal** — on non-zero exit, the zsh hook refreshes
   `last-failure.json`. The `zom_context` tool reports it only while fresh
   (TTL). So "刚才那个命令不对" costs the agent one tool call, and quiet
   sessions cost nothing.
2. **On-demand query** — the agent widens the window itself via the
   `zom_context` tool's query modes. Full history is never loaded.
3. **Recipes** — declarative model calls declared in config, fired by the
   opencode plugin on shell events; results reach you through the outbox
   (below) or the next session's context, each tagged `[zom:<name>]`.

### Recipes

A recipe is a named entry under the config's `recipes` section. When its
event fires, the plugin fills the prompt template, calls the configured
model, and delivers the result:

| Field | Meaning |
|---|---|
| `on` | event source: `failure` (failed shell command), `bg-done` (background session finished), or `manual` (agent gets a `zom_recipe_<name>` tool) |
| `model` | `provider/model-id` that runs the prompt |
| `prompt` | template; `{cmd}` `{exit}` `{cwd}` (`failure`), `{sid}` `{cwd}` (`bg-done`) are filled from the event |
| `deliver` | `outbox` (one `zom:` hint line before your next prompt) or `next-session` (injected into the next mini session, expires after `ttlSeconds`) |
| `exitFilter` | optional array of exit codes to fire on (omit = all) |
| `ratePerHour` | optional cap on model calls per hour (omit = unlimited) |
| `ttlSeconds` | lifetime of `next-session` injections (default 900) |

Failures are visible: an invalid recipe field is a loud load-time error, a
model-call failure lands in the outbox as a `recipe-error` line, and the
per-hour cap is a hard gate. A worked example (`failure-hint`) ships in
[`config.example.jsonc`](config.example.jsonc).

### Configuration system

One source of truth: **`~/.config/zsh-opencode-mini/config.jsonc`** (see
[`config.example.jsonc`](config.example.jsonc)). Copy it there to customize;
without it everything runs on defaults — the plugin works with zero
configuration.

Two sections, each read by the runtime that owns that concern:

| Section | Key | Default | Meaning |
|---|---|---|---|
| `shell` | `dataDir` | `~/.local/share/zsh-opencode-mini` | data directory (XDG_DATA_HOME respected) |
| `shell` | `keybind` | `^X` | summon key; `"off"` disables the binding |
| `shell` | `resume` | `"main"` | which session C-x reopens: `"main"` = the dedicated `ses_zom-main` (isolated from your other opencode sessions); `"off"` = fresh every time |
| `shell` | `replay` | `"on"` | what mini redraws when the main session reopens: `"on"` = newest `replayLimit` messages; `"off"` = `--no-replay`, straight to the input line (full history stays in the session) |
| `shell` | `replayLimit` | `50` | newest-N cap for replay (upstream default 200 — the screen flooding) |
| `companion` | `failureTtlSeconds` | `600` | failure freshness window (s) |
| `companion` | `recentDefaultN` | `20` | lines for `zom_context` `query=recent` |
| `recipes` | *(named objects)* | *(none)* | declarative model calls; see [Recipes](#recipes) |

Parsing convention, same on both sides: **whole-line comments only**, and no
`//` inside string values (the zsh side strips comments with `sed` before
`jq`; the js side strips with a regex before `JSON.parse` — deliberately not
a full jsonc parser). Internal constants that are *not* configuration (agent
name, mini flags, OSC code) live in the plugin source as read-only globals.

The two runtimes also share one data directory. `zom-companion.js` resolves
`dataDir` the same way `plugin.zsh` does (config value, else XDG), so the
opencode side reads the store the zsh side writes regardless of how opencode
was launched.

**API contract exposure.** `zom-companion.js` is platform-coupled — it runs
on OpenCode's plugin API. At `setup()` it asserts the running major version
and probes every ctx surface it uses; any mismatch throws an explicit error
pointing at the docs page and the date this file was last verified against
it. A breaking upstream change refuses to load loudly instead of failing
silently halfway (the same discipline as opencode.nvim's contract check).

**Capture scope** (what lands in history): command text, exit code, elapsed
ms, cwd. Command **output** (stdout/stderr) is not captured — metadata only.
Output capture would be its own opt-in group (repository size, secret
redaction) — not built.

**Strategy dimensions** (how signals turn into context) live on the opencode
side, mechanically in `zom-companion.js`: today two built-in signals (fresh
failure, recent window) plus declarative `recipes` for new ones. Heuristic
tool selection — e.g. wrapping large-output
commands with [rtk](https://github.com/) — is the same kind of dimension; in
an environment that already runs a global opencode rtk plugin it applies
automatically, so this repo neither duplicates nor configures it. Promote it
into a `tools` group here only if a standalone install needs it.

The strategy stays deliberately thin: two built-in signals, and recipes only
when you declare them. A rule table
(input keywords → context actions) is the natural next step once a third
real signal appears — not before.

## Components

```text
zsh-opencode-mini/
├── README.md                       # this file (source of truth)
├── README.zh-CN.md                 # Chinese translation (follows English)
├── config.example.jsonc            # annotated config template (copy to ~/.config/zsh-opencode-mini/)
├── zsh-opencode-mini.plugin.zsh    # zsh side: record + signal + OSC + outbox drain + zom-bg + launcher
├── agent/
│   └── zsh-companion.md            # opencode agent: behavior rules only
├── opencode-plugin/
│   └── zom-companion.js            # opencode side: contract check + zom_context + context hook + recipes + outbox
└── tests/
    ├── run.zsh                     # integration suite S1-S17 (sandboxed zsh + mock opencode)
    ├── companion.test.mjs          # unit test for zom-companion.js (mock V2/V3 ctx)
    └── bin/opencode                # mock opencode binary
```

Runtime data (separate from code):

```text
~/.local/share/zsh-opencode-mini/
├── history-YYYY-MM.jsonl        # monthly command history, append-only
├── last-failure.json            # most recent non-zero-exit command (atomically replaced)
├── outbox.jsonl                 # plugin→shell messages (opencode side appends)
├── outbox.cursor                # shell's byte cursor into outbox.jsonl (zsh side only)
└── bg.jsonl                     # background sessions launched by zom-bg
```

## Install

Three steps, two ecosystems. Steps 1–2 are **opencode-side assets** (the
agent definition and the companion plugin — this is where the AI gets its
abilities: the history tool, failure awareness, recipes). Step 3 is the
**zsh side** (recording, keybind, outbox consumer). The zsh plugin manager
(section below) only covers step 3; steps 1–2 are just two symlinks because
that is opencode's plugin mechanism — new files in `plugins/`, nothing
existing is modified. Skipping steps 1–2 leaves the zsh plugin working but
the AI blind: no history tool, no failure signal, no recipes.

```zsh
git clone <this-repo> ~/Projects/zsh-opencode-mini

# 1. agent -> opencode config
mkdir -p ~/.config/opencode/agent
ln -sf ~/Projects/zsh-opencode-mini/agent/zsh-companion.md \
       ~/.config/opencode/agent/zsh-companion.md

# 2. companion plugin -> opencode plugins
ln -sf ~/Projects/zsh-opencode-mini/opencode-plugin/zom-companion.js \
       ~/.config/opencode/plugins/zom-companion.js

# 3. zshrc.d entry
echo 'source ~/Projects/zsh-opencode-mini/zsh-opencode-mini.plugin.zsh' \
  > ~/.config/zsh/zshrc.d/35-zsh-opencode-mini.zsh
```

### zsh plugin managers

The repo follows the `<name>.plugin.zsh` convention, so managers need no
wrapper — point them at the repo root:

**sheldon** (`~/.config/sheldon/plugins.toml`):

```toml
# local checkout (before the repo is published)
[plugins.zsh-opencode-mini]
local = "~/Projects/wez-ai/zsh-opencode-mini"
use = ["{name}.plugin.zsh"]

# or, once published to GitHub
# [plugins.zsh-opencode-mini]
# github = "<you>/zsh-opencode-mini"
# use = ["{name}.plugin.zsh"]
```

**oh-my-zsh**: clone (or symlink) the repo as
`$ZSH_CUSTOM/plugins/zsh-opencode-mini` and add `zsh-opencode-mini` to
`plugins=(...)`.

**zsh-defer**: safe but pointless here — the plugin's top level is config
reading + two hook registrations + one bindkey, all sub-millisecond; deferring
only widens the window where the keybind is not yet bound and the first
command is not yet recorded.

The two opencode-side links above are independent of the zsh manager — they
are opencode assets, not zsh code.

### Uninstall

Remove the three things install created, in any order:

```zsh
# 1. the zsh side: your manager's entry, or the zshrc.d line
rm ~/.config/zsh/zshrc.d/35-zsh-opencode-mini.zsh

# 2. the opencode side: plugin + agent links
rm ~/.config/opencode/plugins/zom-companion.js
rm ~/.config/opencode/agent/zsh-companion.md

# 3. optional: recorded data (history, failure signal, outbox, bg ledger)
rm -rf ~/.local/share/zsh-opencode-mini ~/.config/zsh-opencode-mini
```

Nothing else is left behind: no widgets are overwritten (the keybind conflict
check keeps yours), and the plugin only ever writes inside its own data dir.

Dependencies: `opencode`, `jq`, `base64`.

**Version support**: opencode **latest v2 only**. `zom-companion.js` anchors
its contract at load time (major version + ctx surface probes) and refuses to
load loudly on mismatch — the plugin API it was verified against is
documented in the file header (last: 2026-10-02, official `Plugin.define` /
`ctx.*` shape).

**Keybind conflicts**: the plugin binds at source time as best effort, then
re-verifies on each prompt until the bind sticks — so a zshrc that switches
keymap after plugins load (`bindkey -e` / `-v`) doesn't silently lose the
key. If the key is owned by you, the existing binding is kept and a warning
is printed once (the `zom` function still works) — rebind via
`shell.keybind` in the config, or `"off"` to skip entirely. zsh's own unused
`^X-prefix` default is safe to take over.

## Usage

- `C-x` — summon `opencode mini` (fullscreen TUI inside a paused ZLE). With
  the default `resume: "main"` this reopens one dedicated assistant session
  (`ses_zom-main`), isolated from your other opencode sessions; `resume: "off"`
  starts a fresh one. On reopen mini replays only the newest `replayLimit`
  messages (default 50, upstream default 200) — or none at all with
  `replay: "off"` (`--no-replay`); the session itself keeps its full history
- `zom` — scriptable launcher, forwards extra args to mini
- `zom-last` — hand the last failed command to `opencode run`, no TUI
- `zom-bg <prompt>` — spawn a long-running `opencode run` in the background;
  prints the session id and an attach command. When the session goes idle,
  the companion plugin drops a `zom: background session <sid> finished`
  notice into the outbox, so you see it before your next prompt
- `zom: <text>` lines before your prompt — outbox deliveries from recipes
  and `zom-bg` (each tagged with its provenance; the agent treats them as
  plugin suggestions, not your words)
- in any opencode session with this plugin: ask the agent `zom_context`
  things — "why did that fail", "what did I run earlier today"

## OSC frame format (reserved for wezterm fork, hole 1)

```
ESC ] <code> ; zom ; v1 ; <base64(json)> BEL
```

- base64 payload: arbitrary bytes in command text cannot corrupt the frame
  (warp uses hex for the same reason); encoding costs one `base64` process
  per command
- `v1` is a protocol version slot; a future `v2` runs in parallel, old
  parsers keep working
- no receiver exists today (the frame is written and ignored); the fork's
  termwiz OSC extension parses this exact format

## vs zsh-kimi-cli

| | zsh-kimi-cli | zsh-opencode-mini |
|---|---|---|
| Interaction | C-x fullscreen switch to kimi CLI | same shape (C-x → mini) + `zom-last` |
| Scene awareness | none | cwd/git via tools, zero injection |
| History awareness | none | lazy: `zom_context` + freshness heuristics |
| Runtime | kimi CLI, locked | opencode (sessions, model choice, custom agents/tools, MCP) |
| Memory | none | cross-session history store |
| Fork readiness | none | OSC frame = hole-1 wire format, day one |

The honest part: the interaction shape is not an improvement (both are
"keybind summons fullscreen TUI"). Everything gained lives on the AI side —
scene, memory, extensibility. That is the point of the small route: make the
data layer final, leave the rendering layer to the fork.

## Known limits

- `zom-last` needs `jq`
- commands run inside opencode/TUIs do not pass through zsh hooks — they never
  enter the store (no self-referential pollution)
- the failure-signal heuristic is per-host and per-user; concurrent shells
  overwrite `last-failure.json` (last writer wins) — fine for a single
  developer, revisit if you fan out
- background sessions are never reaped: `zom-bg` only appends to `bg.jsonl`,
  and session cleanup is left to the platform (not yet verified) — the ledger
  grows unbounded for now
- `zom-bg` completion notices fire on `session.execution.succeeded` (verified
  against a real runtime, opencode 2.0.21, 2026-10-01); the paired
  `session.execution.failed` event's data shape is unverified — a failed
  background session is reported with `ok:false` only when its `sessionID`
  is readable, otherwise it stays silent
- an unparsable line in `outbox.jsonl` is skipped with a warning and the
  cursor advances past it — one bad line never blocks the drain, but its
  content is lost
