# zsh-opencode-mini

Press `C-x` in your shell to summon an [opencode](https://opencode.ai) mini
assistant. The plugin quietly records your commands (text, exit code, cwd)
and gives the AI a lazy, structured way to consult them, so it knows your
scene without any context pasting.

Interaction shape credited to [zsh-kimi-cli](https://github.com/teddy0207/zsh-kimi-cli).

> 中文说明见 [`README.zh-CN.md`](README.zh-CN.md)。Design notes:
> [`docs/DESIGN.md`](docs/DESIGN.md) · Tutorial: [`docs/TUTORIAL.zh-CN.md`](docs/TUTORIAL.zh-CN.md)

## Install

Two halves: the opencode side (the agent and companion plugin that let the
AI read your shell history) and the zsh side (recording + keybind).

```zsh
git clone https://github.com/jensenojs/zsh-opencode-mini
cd zsh-opencode-mini

# opencode side: symlinks, so updates follow the repo
mkdir -p ~/.config/opencode/agent ~/.config/opencode/plugins
ln -sf "$PWD/agent/zsh-companion.md" ~/.config/opencode/agent/zsh-companion.md
ln -sf "$PWD/opencode-plugin/zom-companion.js" ~/.config/opencode/plugins/zom-companion.js

# the mini binary (zom fork of opencode, from GitHub Releases)
bash scripts/install-zom-binary.sh

# zsh side
echo "source $PWD/zsh-opencode-mini.plugin.zsh" >> ~/.zshrc
```

With a plugin manager, the manager owns the clone: run the same two symlinks
against wherever it put the repo, then load the plugin its way.

[sheldon](https://github.com/rossmacarthur/sheldon):

```toml
[plugins.zsh-opencode-mini]
github = "jensenojs/zsh-opencode-mini"
use = ["zsh-opencode-mini.plugin.zsh"]
```

oh-my-zsh:

```zsh
git clone https://github.com/jensenojs/zsh-opencode-mini \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-opencode-mini
# add zsh-opencode-mini to plugins=(...) in ~/.zshrc
```

zinit: `zinit light jensenojs/zsh-opencode-mini`
antidote: add `jensenojs/zsh-opencode-mini` to your plugins file.

**Uninstall**: remove the source line (or the manager entry) and the two
symlinks; optionally
`rm -rf ~/.local/share/zsh-opencode-mini ~/.config/zsh-opencode-mini`.
Nothing else is touched: no widget overwrite, no prompt change.

Requires: `opencode` (latest v2), `jq`, `base64`.

## Usage

| Key / command | What it does |
|---|---|
| `C-x` | open/close the AI mini session (`ses_zom-main`, cwd-aware with the companion binary) |
| `ctrl+z` (in mini) | quit mini cleanly, same as hiding with `C-x`; summon again with `C-x` |
| other unbound keys (in mini) | handed back to the shell, e.g. `ctrl+o` runs at the zsh prompt |
| `zom [args]` | scriptable launcher |
| `zom-last` | send the last failed command to `opencode run` |
| `zom-bg <prompt>` | long-running background session; completion notice arrives as a `zom:` line |
| `zom: <text>` | delivery lines (recipes / bg notices) printed before your prompt |
| `zom-config` | print every knob with its effective value and origin (read-only) |

After a failed command, the composer comes pre-filled with an analysis
prompt (you review, then enter). The AI can also pull history itself via the
`zom_context` tool; nothing is injected unless it is fresh or asked for.

## Configuration

Optional. Copy [`config.example.jsonc`](config.example.jsonc) to
`~/.config/zsh-opencode-mini/config.jsonc`; defaults work with no file.

| Key | Default | Meaning |
|---|---|---|
| `shell.keybind` | `"^X"` | summon key; `"off"` disables |
| `shell.keybindConflict` | `"notify"` | other sequences sharing the summon-key prefix (zsh's emacs map ships a `"^X…"` family under the default `"^X"` summon key) cost one KEYTIMEOUT on every bare press. `"notify"` warns once naming the shadowed sequences and the removal for your own zshrc (`bindkey -rp "<summon key>"`); `"off"` stays silent. The plugin reports only, it never edits your keymap |
| `shell.dataDir` | `~/.local/share/zsh-opencode-mini` | history / failure signal / outbox store (`~` allowed) |
| `shell.resume` | `"main"` | `"main"` = one dedicated session; `"off"` = fresh each time |
| `shell.replay` / `replayLimit` | `"on"` / `50` | messages redrawn on reopen (`"off"` = none) |
| `shell.binary` | `"opencode-zom"` | mini launcher binary; default is the zom fork installed by `scripts/install-zom-binary.sh` (official builds lack inline resume / passthrough and are not fallen back to silently) |
| `shell.passthrough` | `"on"` | unbound keys are logged to `passthrough.<pid>.keys.log` instead of killing mini; `"off"` swallows them |
| `shell.passthroughKeys` | `""` | comma-separated strokes (e.g. `"ctrl+r"`) that exit mini and replay into the shell |
| `shell.historyRetainMonths` | `6` | monthly history files older than this are deleted at shell start; `"off"` keeps everything |
| `shell.osc` | `"on"` | per-command OSC 7777 report frame (a private protocol for terminal-side receivers); `"off"` also saves one base64 fork per command |
| `shell.failurePrefill` | built-in | template pre-filled after a failure (`{cmd}` `{exit}` `{cwd}`; `"off"` disables) |
| `shell.model` | `""` | pin a model for mini sessions (`provider/model#variant`); empty follows your global default |
| `companion.failureTtlSeconds` | `600` | how long a failure stays "fresh" for the AI |
| `companion.recentDefaultN` | `20` | lines `zom_context` returns for `query=recent` |
| `companion.repeatFailureThreshold` | `3` | identical failures of one command within a day that trigger one outbox hint (`0` disables) |
| `recipes.<name>` (top level) | (none) | declarative model calls on events (`failure` / `bg-done` / `manual`); the name must match `^[A-Za-z0-9_-]+$`; see the example config |

Config is read once when the plugin loads; open a new shell after editing.
Run `zom-config` to see everything in effect (including the parts installed
under `~/.config/opencode/`); the plugin never writes configuration.

## How it works

- zsh `preexec`/`precmd` hooks append command metadata to a local JSONL
  store; non-zero exits also refresh a failure signal. Metadata only, no
  output capture.
- the opencode plugin exposes that store as the `zom_context` tool and a
  freshness-gated context hook; results and notices return through a single
  `outbox.jsonl` that the shell drains before each prompt.
- shell-side degraded states (a failing spawn hook, an oversized history
  file) append to `notices.jsonl`; the companion drains it into the context
  injection on the next session, so states the user cannot see in daily use
  get surfaced by the model instead of going unnoticed.
- the companion also counts identical command failures within a day and
  drops one hint into the outbox at the threshold: each failure is visible
  to you, the count is not.
- the opencode plugin refuses to load loudly if the plugin API drifts
  (anchored to latest v2).

### Spawn hooks

Functions or executables registered in `ZOM_SPAWN_HOOKS+=(fn)` run before
every opencode spawn (`zom` widget / `zom-bg` / `zom-last`). The plugin owns
the spawn facts; the hook decides what to do with them. Each call receives
exported env vars (external executables inherit them, zsh functions see them
for the duration of the call):

- `ZOM_HOOK_KIND`: `mini`, `bg`, or `last`
- `ZOM_HOOK_SID`: session id when known at hook time (always for `bg`;
  for `mini` only with `resume: "main"`; empty otherwise)
- `ZOM_HOOK_CWD`: the directory the spawn happens in

Hooks inherit the real terminal on stdin (the summon widget's stdin is not
a tty, and terminal-probing hooks would misfire without this). A failing
hook never blocks the spawn, but the failure appends a notice that the next
session surfaces (see above). zom core ships no terminal-state integration;
consumers such as wezterm-attention live in your own zsh config.

## Known limits

- commands run inside TUIs never pass through zsh hooks (no self-pollution)
- concurrent shells overwrite `last-failure.json` (last writer wins)
- failed background sessions are reported only when their session id is
  readable; the paired failure event shape is unverified upstream
