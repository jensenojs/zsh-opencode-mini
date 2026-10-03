# zsh-opencode-mini

Press `C-x` in your shell to summon an [opencode](https://opencode.ai) mini
assistant. The plugin quietly records your commands (text, exit code, cwd)
and gives the AI a lazy, structured way to consult them — so it knows your
scene without any context pasting.

Interaction shape credited to [zsh-kimi-cli](https://github.com/teddy0207/zsh-kimi-cli).

> 中文说明见 [`README.zh-CN.md`](README.zh-CN.md)。Design notes:
> [`docs/DESIGN.md`](docs/DESIGN.md) · Tutorial: [`docs/TUTORIAL.zh-CN.md`](docs/TUTORIAL.zh-CN.md)

## Install

```zsh
git clone https://github.com/jensenojs/zsh-opencode-mini
cd zsh-opencode-mini

# 1+2. opencode side: the agent and its plugin (what makes the AI aware)
mkdir -p ~/.config/opencode/agent ~/.config/opencode/plugins
ln -sf "$PWD/agent/zsh-companion.md" ~/.config/opencode/agent/zsh-companion.md
ln -sf "$PWD/opencode-plugin/zom-companion.js" ~/.config/opencode/plugins/zom-companion.js

# 3. zsh side: recording + keybind
echo "source $PWD/zsh-opencode-mini.plugin.zsh" >> ~/.zshrc
```

Any zsh plugin manager works too (`<name>.plugin.zsh` convention) — with
[sheldon](https://github.com/rossmacarthur/sheldon):

```toml
[plugins.zsh-opencode-mini]
github = "jensenojs/zsh-opencode-mini"
use = ["zsh-opencode-mini.plugin.zsh"]
```

**Uninstall**: remove the source line and the two symlinks; optionally
`rm -rf ~/.local/share/zsh-opencode-mini ~/.config/zsh-opencode-mini`.
Nothing else is touched: no widget overwrite, no prompt change.

Requires: `opencode` (latest v2), `jq`, `base64`.

## Usage

| Key / command | What it does |
|---|---|
| `C-x` | open/close the AI mini session (`ses_zom-main`, cwd-aware with the companion binary) |
| `ctrl+z` (in mini) | suspend back to the shell; resume later with `C-x` |
| other unbound keys (in mini) | handed back to the shell — e.g. `ctrl+o` runs at the zsh prompt |
| `zom [args]` | scriptable launcher |
| `zom-last` | send the last failed command to `opencode run` |
| `zom-bg <prompt>` | long-running background session; completion notice arrives as a `zom:` line |
| `zom: <text>` | delivery lines (recipes / bg notices) printed before your prompt |

After a failed command, the composer comes pre-filled with an analysis
prompt (you review, then enter). The AI can also pull history itself via the
`zom_context` tool — nothing is injected unless it is fresh or asked for.

## Configuration

Optional. Copy [`config.example.jsonc`](config.example.jsonc) to
`~/.config/zsh-opencode-mini/config.jsonc`; defaults work with no file.

| Key | Default | Meaning |
|---|---|---|
| `shell.keybind` | `"^X"` | summon key; `"off"` disables |
| `shell.resume` | `"main"` | `"main"` = one dedicated session; `"off"` = fresh each time |
| `shell.replay` / `replayLimit` | `"on"` / `50` | messages redrawn on reopen (`"off"` = none) |
| `shell.binary` | `"opencode"` | pin a specific opencode build |
| `shell.passthrough` | `"on"` | unbound keys go back to the shell instead of being swallowed |
| `shell.failurePrefill` | built-in | template pre-filled after a failure (`{cmd}` `{exit}` `{cwd}`; `"off"` disables) |
| `companion.failureTtlSeconds` | `600` | how long a failure stays "fresh" for the AI |
| `recipes.<name>` | — | declarative model calls on events (`failure` / `bg-done` / `manual`); see the example config |

## How it works

- zsh `preexec`/`precmd` hooks append command metadata to a local JSONL
  store; non-zero exits also refresh a failure signal. Metadata only — no
  output capture.
- the opencode plugin exposes that store as the `zom_context` tool and a
  freshness-gated context hook; results and notices return through a single
  `outbox.jsonl` that the shell drains before each prompt.
- the opencode plugin refuses to load loudly if the plugin API drifts
  (anchored to latest v2).

## Known limits

- commands run inside TUIs never pass through zsh hooks (no self-pollution)
- concurrent shells overwrite `last-failure.json` (last writer wins)
- failed background sessions are reported only when their session id is
  readable; the paired failure event shape is unverified upstream
