# zsh-opencode-mini.plugin.zsh
# The shell side of zsh-opencode-mini: command recording, the outbox consumer
# (cross-side return channel from the opencode plugin), background-session
# spawning, and the opencode mini launcher.
# Principle: zero intrusion into the user's zsh — registers only via add-zsh-hook
# (same convention as direnv/python-autoenv), never overwrites widgets, never
# touches the prompt. Uninstall = remove the source line.
#
# Configuration is deliberately minimal: only what is genuinely shell-side
# (data path, summon keybind). Strategy knobs live on the opencode side, in
# the jsonc config read by opencode-plugin/zom-companion.js — see README.md.

# ---- Configuration: one jsonc file, two consumers ----
# ~/.config/zsh-opencode-mini/config.jsonc — its "shell" section is read here
# (jq, after stripping whole-line comments), its "companion" and "recipes"
# sections are read by opencode-plugin/zom-companion.js. There is no env-var
# configuration surface. Missing file / missing keys -> defaults; the plugin
# works with zero configuration.
ZOM_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/zsh-opencode-mini/config.jsonc"

# Two-step parse: validate the whole document before extracting a key, so a
# syntax error produces one loud warning instead of silently defaulting every
# key (a silently-wrong dataDir would send the user's history somewhere they
# cannot find).
__zom_cfg() {
  [[ -f "$ZOM_CONFIG" ]] || return 0
  if ! sed 's|^[[:space:]]*//.*||' "$ZOM_CONFIG" | jq -e . >/dev/null 2>&1; then
    print -u2 -- "zsh-opencode-mini: config unparsable, using defaults ($ZOM_CONFIG)"
    return 0
  fi
  sed 's|^[[:space:]]*//.*||' "$ZOM_CONFIG" | jq -r "$1 // empty" 2>/dev/null
}

ZOM_DATA_DIR=$(__zom_cfg '.shell.dataDir')
ZOM_DATA_DIR=${ZOM_DATA_DIR/#\~/$HOME}   # expand leading ~ if the user wrote one
: "${ZOM_DATA_DIR:="${XDG_DATA_HOME:-$HOME/.local/share}/zsh-opencode-mini"}"

ZOM_KEYBIND=$(__zom_cfg '.shell.keybind')
# "" cannot round-trip through $( ), so "off" is the explicit disable token.
case "$ZOM_KEYBIND" in
  "" | null) ZOM_KEYBIND="^X" ;;   # absent from config -> default
  off)       ZOM_KEYBIND=""  ;;   # explicit disable
esac

# Which session C-x resumes. "main" (default): one dedicated assistant session
# (ZOM_MAIN_SESSION), fully isolated from whatever opencode sessions you use
# elsewhere — `-c` here would resume your *globally latest* session (often one
# that is streaming right now), which is never what the keybind means. "off":
# a fresh session every time. Anything else: warn once, fall back to "main".
ZOM_RESUME=$(__zom_cfg '.shell.resume')
case "$ZOM_RESUME" in
  main | "" | null) ZOM_RESUME="main" ;;   # absent -> default
  off)              : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.resume '$ZOM_RESUME' invalid (main|off) — using main."
    ZOM_RESUME="main" ;;
esac

# Which opencode binary mini launches. Defaults to "opencode" from PATH.
# Pin an absolute path to use a specific build — e.g. a self-built one whose
# renderer keeps the inline scrollback when resuming an existing session
# (official v2.0.22 binary redraws from the top on `-s <existing>`).
ZOM_BINARY=$(__zom_cfg '.shell.binary')
ZOM_BINARY=${ZOM_BINARY/#\~/$HOME}   # expand leading ~ (quoted "$ZOM_BINARY" would not)
if [[ "$ZOM_BINARY" == "" || "$ZOM_BINARY" == "null" ]]; then
  ZOM_BINARY="opencode"   # absent -> default
fi
typeset -gr ZOM_BINARY

# ---- Internal defaults (not configuration; edit the source if you must) ----
typeset -gr ZOM_AGENT="zsh-companion"   # agent name, defined in agent/zsh-companion.md
typeset -gr ZOM_MAIN_SESSION="ses_zom-main"  # the dedicated assistant session ("resume": "main")
# Replay behaviour when resuming the main session (v2.0.21 mini source:
# opening prints the newest N messages into the terminal scrollback, N
# defaulting to 200 — that reprint is the screen-flooding you see on C-x):
#   shell.replay       "on" (default) | "off" — off passes --no-replay
#   shell.replayLimit  positive integer (default 50)
# The session itself keeps its full history; these only bound what mini
# redraws on open.
ZOM_REPLAY=$(__zom_cfg '.shell.replay')
case "$ZOM_REPLAY" in
  on | "" | null) ZOM_REPLAY="on" ;;   # absent -> default
  off)            : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.replay '$ZOM_REPLAY' invalid (on|off) — using on."
    ZOM_REPLAY="on" ;;
esac
ZOM_REPLAY_LIMIT=$(__zom_cfg '.shell.replayLimit')
if [[ "$ZOM_REPLAY_LIMIT" == "" || "$ZOM_REPLAY_LIMIT" == "null" ]]; then
  ZOM_REPLAY_LIMIT="50"   # absent -> default
elif [[ "$ZOM_REPLAY_LIMIT" != <-> || "$ZOM_REPLAY_LIMIT" -lt 1 ]]; then
  print -u2 -- "zsh-opencode-mini: shell.replayLimit '$ZOM_REPLAY_LIMIT' invalid (positive integer) — using 50."
  ZOM_REPLAY_LIMIT="50"
fi
typeset -gr ZOM_OSC_CODE="7777"         # private OSC code; may change when the fork lands

# zsh/datetime provides EPOCHREALTIME / EPOCHSECONDS / strftime as builtins;
# zsh/stat (zstat) and zsh/system (sysread/sysseek) power the fork-free outbox
# cursor read below. Recording stays at one external process per command (the
# base64 for the OSC frame). Do not assume the host zshrc loaded these.
(( $+EPOCHREALTIME )) || zmodload zsh/datetime
zmodload zsh/stat zsh/system 2>/dev/null
(( $+builtins[zstat] && $+builtins[sysread] )) || \
  print -u2 -- "zsh-opencode-mini: zsh/stat + zsh/system unavailable — outbox notifications disabled"

autoload -Uz add-zsh-hook

if [[ ! -d "$ZOM_DATA_DIR" ]]; then
  mkdir -p "$ZOM_DATA_DIR" 2>/dev/null || \
    print -u2 -- "zsh-opencode-mini: cannot create data dir $ZOM_DATA_DIR — recording disabled"
fi

# ---- JSON helper ----
# Hand-rolled escaping, zero dependencies. Covers JSON structural chars
# and common control characters.
__zom_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  print -rn -- "$s"
}

# ---- hooks: command recording ----

# preexec: command starts. Store start time and command text
# (precmd does not receive the command line).
__zom_preexec() {
  __ZOM_T0=$EPOCHREALTIME
  __ZOM_CMD=$1
}

# precmd: command finished. Append one JSON line to the monthly history file,
# refresh the failure signal file on non-zero exit, and emit one OSC frame
# (no receiver exists yet; the format is reserved for wezterm fork hole 1).
# Capture scope: command text + exit code + elapsed ms + cwd.
# Command OUTPUT (stdout/stderr) is NOT captured — metadata only.
__zom_precmd() {
  local exit_code=$?                  # first statement: capture $? before anything overwrites it
  [[ -n "${__ZOM_T0:-}" ]] || return 0

  local cmd=${__ZOM_CMD:-}
  local t0=${__ZOM_T0}
  unset __ZOM_T0 __ZOM_CMD
  [[ -n "$cmd" ]] || return 0

  local elapsed_ms=0
  local elapsed_ms=$(( (EPOCHREALTIME - t0) * 1000 ))
  elapsed_ms=${elapsed_ms%%.*}   # truncate to whole ms (zsh printf has no -v)

  local ts
  strftime -s ts '%Y-%m-%dT%H:%M:%S%z' $EPOCHSECONDS

  # 1) Append to the monthly history store (the only fork in this path is the
  #    base64 below; strftime is a builtin)
  local json
  json=$(printf '{"ts":"%s","cwd":"%s","exit":%d,"ms":%s,"cmd":"%s"}' \
    "$ts" "$(__zom_json_escape "$PWD")" "$exit_code" "$elapsed_ms" "$(__zom_json_escape "$cmd")")
  print -r -- "$json" >> "$ZOM_DATA_DIR/history-$(strftime '%Y-%m' $EPOCHSECONDS).jsonl"

  # 2) Non-zero exit -> atomically refresh the failure signal file
  #    (the opencode-side plugin checks this file against its TTL)
  if (( exit_code != 0 )); then
    printf '{"ts":"%s","epoch":%d,"cwd":"%s","exit":%d,"cmd":"%s"}\n' \
      "$ts" "$EPOCHSECONDS" "$(__zom_json_escape "$PWD")" "$exit_code" "$(__zom_json_escape "$cmd")" \
      > "$ZOM_DATA_DIR/last-failure.json.tmp" \
      && mv "$ZOM_DATA_DIR/last-failure.json.tmp" "$ZOM_DATA_DIR/last-failure.json"
  fi

  # 3) Deliver outbox records that arrived while the command ran (see
  #    __zom_outbox_drain) — pre-prompt, one line per record.
  __zom_outbox_drain

  # 4) OSC report: ESC ] CODE ; zom ; v1 ; <base64(json)> BEL
  #    base64-encoded payload so arbitrary bytes in command text cannot
  #    corrupt the OSC frame (warp uses hex for the same reason).
  #    Emitted unconditionally: no receiver exists yet, the fork consumes
  #    this format as-is (hole 1).
  #    Cost note: this is one external process (base64) per command — the
  #    tr is gone (parameter expansion strips base64's line wraps).
  local b64
  b64=${$(printf '%s' "$json" | base64)//$'\n'/}
  printf '\e]%s;zom;v1;%s\a' "$ZOM_OSC_CODE" "$b64"
}

# ---- outbox: the cross-side return channel ----
# opencode-plugin/zom-companion.js is the only writer of outbox.jsonl (recipe
# results, background-session finish notices — one JSON record per line,
# always carrying a .text). zsh consumes it here with a byte cursor:
# outbox.cursor stores the offset of the first unread byte. Steady state (no
# new records) costs zero forks — zstat/sysseek/sysread are builtins; one jq
# parses the increment only when there is one.
#
# Semantics worth naming:
#  - a partial trailing line stays unconsumed until it is complete
#  - unparsable content is skipped (cursor advances) with one warning — a bad
#    line must not dead-lock every future notice
#  - at-least-once: a crash between printing and the cursor write can replay
#    a line; repeated notices are harmless, a lock would not be
#  - concurrent shells share the cursor last-writer-wins — a losing shell may
#    print one record twice (README limits)
__zom_outbox_drain() {
  local LC_ALL=C   # byte addressing for ${#...} and (I) subscripts; scoped, restored on return
  local ob="$ZOM_DATA_DIR/outbox.jsonl"
  [[ -f "$ob" ]] || return 0
  (( $+builtins[zstat] )) || return 0

  local start=0
  [[ -f "$ZOM_DATA_DIR/outbox.cursor" ]] && read -r start < "$ZOM_DATA_DIR/outbox.cursor"
  local size
  size=$(zstat +size "$ob")
  [[ -n "$size" ]] || return 0
  (( start > size )) && start=0   # file recreated or truncated — start over
  (( size > start )) || return 0

  local chunk="" part fd
  exec {fd}<"$ob"
  sysseek -u $fd $start
  while sysread -i $fd part; do chunk+=$part; done
  exec {fd}>&-

  # Consume only complete lines: without a trailing newline the writer was
  # caught mid-line and the tail stays for the next prompt.
  local nl=$'\n' consumed
  if [[ "$chunk" == *$'\n' ]]; then
    consumed=${#chunk}
  else
    consumed=${chunk[(I)$nl]}
    (( consumed > 0 )) || return 0
  fi

  local texts
  if ! texts=$(printf '%s' "${chunk[1,consumed]}" | jq -r '.text // empty' 2>/dev/null); then
    print -u2 -- "zsh-opencode-mini: unparsable outbox content skipped (cursor advanced)"
  fi
  local line
  for line in ${(f)texts}; do
    [[ -n "$line" ]] && print -u2 -- "zom: $line"
  done

  print -r -- "$(( start + consumed ))" > "$ZOM_DATA_DIR/outbox.cursor"
  return 0
}

# ---- background sessions ----
# zom-bg runs a prompt in a dedicated background opencode session. The session
# lives on the shared service (plain `run`), so `opencode mini -s <sid>` can
# attach to it later — --standalone would keep the session client-side and
# unreachable from mini. bg.jsonl is the spawn ledger: the opencode side reads
# it to know which sids to watch for completion, this function prints the sid
# for attaching.
zom-bg() {
  if (( $# == 0 )); then
    print -u2 -- "zom-bg: usage: zom-bg <prompt...>"
    return 1
  fi
  local sid="ses_zom-bg-${EPOCHSECONDS}-$$"
  opencode run -s "$sid" "$@" >/dev/null 2>&1 &
  local pid=$!   # capture before anything else can spawn — $! is the run process
  print -r -- "{\"sid\":\"$sid\",\"pid\":$pid,\"cwd\":\"$(__zom_json_escape "$PWD")\",\"started\":$EPOCHSECONDS}" \
    >> "$ZOM_DATA_DIR/bg.jsonl" || {
      print -u2 -- "zom-bg: cannot write $ZOM_DATA_DIR/bg.jsonl — the completion notice will not fire"
      return 1
    }
  print -- "zom-bg: session $sid started in background"
  print -- "zom-bg: attach with: opencode mini -s $sid"
}

# ---- summon opencode mini ----

# The single launch path, shared by the keybind widget and the `zom` function.
# Kept free of ZLE calls so tests can exercise it without a line editor.
__zom_launch_mini() {
  case "$ZOM_RESUME" in
    main)
      case "$ZOM_REPLAY" in
        on)  "$ZOM_BINARY" mini -s "$ZOM_MAIN_SESSION" --replay-limit "$ZOM_REPLAY_LIMIT" --agent "$ZOM_AGENT" "$@" ;;
        off) "$ZOM_BINARY" mini -s "$ZOM_MAIN_SESSION" --no-replay --agent "$ZOM_AGENT" "$@" ;;
      esac ;;
    off) "$ZOM_BINARY" mini --agent "$ZOM_AGENT" "$@" ;;
  esac
}

# ZLE widget: pause the line editor (zle -I), run the fullscreen TUI,
# then repaint the prompt.
__zom_mini_widget() {
  zle -I
  # opentui inline renderer clears the screen when mini starts with the
  # cursor past column 0; zle -I leaves the cursor at the prompt column.
  # Emit a newline so mini starts on a fresh line (same as a direct command).
  print -- ""
  __zom_launch_mini
  zle reset-prompt
}

# Scriptable entry point (extra args are forwarded to mini)
zom() {
  __zom_launch_mini "$@"
}

# Quick ask: hand the most recent failed command straight to `opencode run`,
# no TUI.
zom-last() {
  local last_failed
  last_failed=$(jq -r '.cmd // empty' "$ZOM_DATA_DIR/last-failure.json" 2>/dev/null)
  if [[ -z "$last_failed" ]]; then
    print -u2 "zom-last: no failed command on record"
    return 1
  fi
  print -- "zom-last: $last_failed"
  opencode run "Explain and fix this failed command (run in the current directory): $last_failed"
}

# ---- install ----
add-zsh-hook preexec __zom_preexec
add-zsh-hook precmd __zom_precmd

if [[ -n "$ZOM_KEYBIND" ]]; then
  # Conflict-aware binding. Never steal a key the user already uses: warn and
  # skip instead (the `zom` function stays available; rebind via shell.keybind).
  # `$seq-prefix` (zsh's own unbound prefix) is safe to take over.
  # Always return 0 — a warning must not break a user's err_return zshrc.
  #
  # Loaded while main still points at viins (macOS factory default), the bind
  # lands in viins and is "lost" the moment the user's zshrc runs `bindkey -e`.
  # The source-time bind below is therefore best-effort; __zom_ensure_bind
  # verifies against the live keymap at each prompt and rebinds until the bind
  # sticks in its final keymap. ZOM_BIND_DONE: 0=trying 2=user-occupied.
  if (( ! $+ZOM_BIND_DONE )); then typeset -g ZOM_BIND_DONE=0; fi
  __zom_bind() {
    local seq="$1" current
    current=$(bindkey "$seq" 2>/dev/null)
    current=${current##*\" }
    [[ "$current" == "$seq-prefix" || "$current" == "undefined-key" || -z "$current" ]] || {
      if [[ "$current" == "__zom_mini_widget" ]]; then
        return 0                                        # already ours
      elif (( ! ZOM_BIND_DONE )); then                  # warn once, not per prompt
        print -u2 -- "zsh-opencode-mini: key '$seq' is already bound to '$current' — binding skipped."
        print -u2 -- "zsh-opencode-mini: set \"keybind\" in $ZOM_CONFIG to another key or \"off\"."
        ZOM_BIND_DONE=2
      fi
      return 0
    }
    zle -N __zom_mini_widget
    if bindkey "$seq" __zom_mini_widget; then :; fi
    return 0
  }
  if (( $+widgets )); then
    __zom_bind "$ZOM_KEYBIND"
  fi

  # Lazy bind: first prompt = post-zshrc, deferred plugins done, final keymap.
  # Self-detaches once the bind reads back as ours (or as user-occupied), so
  # the steady-state prompt pays zero extra work (this check forks once —
  # acceptable for a bounded number of prompts, not forever).
  __zom_ensure_bind() {
    local current
    if (( ZOM_BIND_DONE == 2 )); then
      add-zsh-hook -d precmd __zom_ensure_bind
      return 0
    fi
    current=$(bindkey "$ZOM_KEYBIND" 2>/dev/null)
    if [[ "$current" == *'__zom_mini_widget'* ]]; then
      add-zsh-hook -d precmd __zom_ensure_bind
      return 0
    fi
    __zom_bind "$ZOM_KEYBIND"
    current=$(bindkey "$ZOM_KEYBIND" 2>/dev/null)
    if [[ "$current" == *'__zom_mini_widget'* ]]; then
      add-zsh-hook -d precmd __zom_ensure_bind
    fi
    return 0
  }
  add-zsh-hook precmd __zom_ensure_bind
fi
