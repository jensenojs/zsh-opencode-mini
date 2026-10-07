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

# The document is parsed exactly once, at source time: one jq emits every
# shell-side raw value into ZOM_CFG (@sh does the quoting, so values with
# quotes or newlines survive), and the resolution section below reads only
# the table. Opening a shell costs a fixed two forks (sed + jq) regardless
# of key count. ZOM_CFG_STATUS records how the load went; zom-config
# reports it.
typeset -gA ZOM_CFG=()
typeset -g ZOM_CFG_STATUS=absent
__zom_cfg_load() {
  # Baseline for "no config": every known key present but empty — spelled out
  # without jq, so a half-populated table (and a nounset death on a missing
  # key) is impossible even when jq itself is unavailable.
  local -r empty='ZOM_CFG[binary]=""
    ZOM_CFG[keybind]=""
    ZOM_CFG[dataDir]=""
    ZOM_CFG[resume]=""
    ZOM_CFG[replay]=""
    ZOM_CFG[replayLimit]=""
    ZOM_CFG[passthrough]=""
    ZOM_CFG[failurePrefill]=""
    ZOM_CFG[model]=""
    ZOM_CFG[failureTtlSeconds]=""
    ZOM_CFG[recentDefaultN]=""'
  # One document, one jq: emit all assignments. `// ""` maps jq's falsy
  # values (null/false) to empty = "not set", exactly what the per-key
  # `// empty` reads did before; a wrong-typed section makes jq fail, which
  # lands in the same loud-defaults path as a syntax error.
  local -r q='.shell as $s |
    "ZOM_CFG[binary]="            + (($s.binary         // "") | @sh),
    "ZOM_CFG[keybind]="           + (($s.keybind        // "") | @sh),
    "ZOM_CFG[dataDir]="           + (($s.dataDir        // "") | @sh),
    "ZOM_CFG[resume]="            + (($s.resume         // "") | @sh),
    "ZOM_CFG[replay]="            + (($s.replay         // "") | @sh),
    "ZOM_CFG[replayLimit]="       + (($s.replayLimit    // "") | @sh),
    "ZOM_CFG[passthrough]="       + (($s.passthrough    // "") | @sh),
    "ZOM_CFG[failurePrefill]="    + (($s.failurePrefill // "") | @sh),
    "ZOM_CFG[model]="             + (($s.model          // "") | @sh),
    "ZOM_CFG[failureTtlSeconds]=" + ((.companion.failureTtlSeconds // "") | @sh),
    "ZOM_CFG[recentDefaultN]="    + ((.companion.recentDefaultN    // "") | @sh)'
  local assignments
  if [[ ! -f "$ZOM_CONFIG" ]]; then
    eval "$empty"
  elif assignments=$(sed 's|^[[:space:]]*//.*||' "$ZOM_CONFIG" | jq -re "$q" 2>/dev/null); then
    ZOM_CFG_STATUS=ok
    eval "$assignments"
  else
    print -u2 -- "zsh-opencode-mini: config unparsable, using defaults ($ZOM_CONFIG)"
    ZOM_CFG_STATUS=unparsable
    eval "$empty"
  fi
}

# ---- Single source of defaults --------------------------------------------
# Every user-facing default lives in this one table. Resolution below and the
# zom-config report both read it; no other literal default for these keys
# exists in this file. [model] is empty on purpose: unpinned means the
# agent's global model applies untouched.
typeset -gA ZOM_DEFAULTS=(
  [binary]="opencode-zom"
  [keybind]="^X"
  [dataDir]="${XDG_DATA_HOME:-$HOME/.local/share}/zsh-opencode-mini"
  [resume]="main"
  [replay]="on"
  [replayLimit]="50"
  [passthrough]="on"
  [failurePrefill]='上一条命令失败了（exit {exit}）：{cmd}\n帮我分析失败原因并给出修复建议'
  [model]=""
  [failureTtlSeconds]="600"
  [recentDefaultN]="20"
)

__zom_cfg_load

# ---- Resolution: config table + defaults -> effective shell state ----------
# Every branch reads the raw ZOM_CFG[...] value and normalizes it (off
# tokens, ~ expansion, validation with a loud warning); the results land in
# the ZOM_* scalars the rest of this file uses.
ZOM_DATA_DIR=${ZOM_CFG[dataDir]}
ZOM_DATA_DIR=${ZOM_DATA_DIR/#\~/$HOME}   # expand leading ~ if the user wrote one
: "${ZOM_DATA_DIR:=${ZOM_DEFAULTS[dataDir]}}"

ZOM_KEYBIND=${ZOM_CFG[keybind]}
# "off" is the explicit disable token; absent or empty falls back to the default.
case "$ZOM_KEYBIND" in
  "" | null) ZOM_KEYBIND="${ZOM_DEFAULTS[keybind]}" ;;   # absent from config -> default
  off)       ZOM_KEYBIND=""  ;;   # explicit disable
esac

# Which session C-x resumes. "main" (default): one dedicated assistant session
# (ZOM_MAIN_SESSION), fully isolated from whatever opencode sessions you use
# elsewhere — `-c` here would resume your *globally latest* session (often one
# that is streaming right now), which is never what the keybind means. "off":
# a fresh session every time. Anything else: warn once, fall back to "main".
ZOM_RESUME=${ZOM_CFG[resume]}
case "$ZOM_RESUME" in
  main | "" | null) ZOM_RESUME="${ZOM_DEFAULTS[resume]}" ;;   # absent -> default
  off)              : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.resume '$ZOM_RESUME' invalid (main|off) — using ${ZOM_DEFAULTS[resume]}."
    ZOM_RESUME="${ZOM_DEFAULTS[resume]}" ;;
esac

# Which opencode binary mini launches. Defaults to "opencode" from PATH.
# Pin an absolute path to use a specific build — e.g. a self-built one whose
# renderer keeps the inline scrollback when resuming an existing session
# (official v2.0.22 binary redraws from the top on `-s <existing>`).
# Absent -> the zom binary (scripts/install-zom-binary.sh installs it as
# "opencode-zom"). No silent fallback to the official binary: it lacks the
# fork fixes (inline resume, suspend, key passthrough) and would quietly
# degrade the experience; missing binary is a loud error at launch instead.
ZOM_BINARY=${ZOM_CFG[binary]}
ZOM_BINARY=${ZOM_BINARY/#\~/$HOME}   # expand leading ~ (quoted "$ZOM_BINARY" would not)
if [[ "$ZOM_BINARY" == "" || "$ZOM_BINARY" == "null" ]]; then
  ZOM_BINARY="${ZOM_DEFAULTS[binary]}"
fi
if ! command -v "$ZOM_BINARY" >/dev/null 2>&1; then
  print -u2 -- "zsh-opencode-mini: mini launcher binary not found: $ZOM_BINARY"
  print -u2 -- "  install it:  scripts/install-zom-binary.sh   (or pin shell.binary)"
  ZOM_BINARY=""
fi
# re-source safety: typeset -gr on an existing readonly aborts the whole
# source (leaving the widget undefined) under err_return; skip when present.
# ZOM_BINARY takes no guard: it is assigned unconditionally above, so it is
# never readonly and never needs one.

# ---- Internal defaults (not configuration; edit the source if you must) ----
(( $+ZOM_AGENT )) || typeset -gr ZOM_AGENT="zsh-companion"   # agent name, defined in agent/zsh-companion.md
(( $+ZOM_MAIN_SESSION )) || typeset -gr ZOM_MAIN_SESSION="ses_zom-main"  # the dedicated assistant session ("resume": "main")
# Replay behaviour when resuming the main session (v2.0.21 mini source:
# opening prints the newest N messages into the terminal scrollback, N
# defaulting to 200 — that reprint is the screen-flooding you see on C-x):
#   shell.replay       "on" (default) | "off" — off passes --no-replay
#   shell.replayLimit  positive integer (default 50)
# The session itself keeps its full history; these only bound what mini
# redraws on open.
ZOM_REPLAY=${ZOM_CFG[replay]}
case "$ZOM_REPLAY" in
  on | "" | null) ZOM_REPLAY="${ZOM_DEFAULTS[replay]}" ;;   # absent -> default
  off)            : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.replay '$ZOM_REPLAY' invalid (on|off) — using ${ZOM_DEFAULTS[replay]}."
    ZOM_REPLAY="${ZOM_DEFAULTS[replay]}" ;;
esac
ZOM_REPLAY_LIMIT=${ZOM_CFG[replayLimit]}
if [[ "$ZOM_REPLAY_LIMIT" == "" || "$ZOM_REPLAY_LIMIT" == "null" ]]; then
  ZOM_REPLAY_LIMIT="${ZOM_DEFAULTS[replayLimit]}"   # absent -> default
elif [[ "$ZOM_REPLAY_LIMIT" != <-> || "$ZOM_REPLAY_LIMIT" -lt 1 ]]; then
  print -u2 -- "zsh-opencode-mini: shell.replayLimit '$ZOM_REPLAY_LIMIT' invalid (positive integer) — using ${ZOM_DEFAULTS[replayLimit]}."
  ZOM_REPLAY_LIMIT="${ZOM_DEFAULTS[replayLimit]}"
fi
(( $+ZOM_OSC_CODE )) || typeset -gr ZOM_OSC_CODE="7777"         # private OSC code; may change when the fork lands

# Failure→prefill TTL (seconds). Shared with the opencode-side companion
# plugin, which guards the same last-failure.json signal with the same key.
ZOM_FAILURE_TTL=${ZOM_CFG[failureTtlSeconds]}
[[ "$ZOM_FAILURE_TTL" == "" || "$ZOM_FAILURE_TTL" == "null" ]] && ZOM_FAILURE_TTL="${ZOM_DEFAULTS[failureTtlSeconds]}"
if [[ "$ZOM_FAILURE_TTL" != <-> || "$ZOM_FAILURE_TTL" -lt 1 ]]; then
  print -u2 -- "zsh-opencode-mini: companion.failureTtlSeconds '$ZOM_FAILURE_TTL' invalid (positive integer) — using ${ZOM_DEFAULTS[failureTtlSeconds]}."
  ZOM_FAILURE_TTL="${ZOM_DEFAULTS[failureTtlSeconds]}"
fi

# Key passthrough (default on). When mini sees a key nobody claims (not a
# keymap action, not composer input), it no longer swallows it: mini writes
# the raw bytes to ZOM_PASSTHROUGH_FILE and exits; the widget replays them
# into ZLE, so the key takes effect in the shell. "off" restores the old
# swallow behaviour.
ZOM_PASSTHROUGH=${ZOM_CFG[passthrough]}
case "$ZOM_PASSTHROUGH" in
  ""|on) ZOM_PASSTHROUGH="${ZOM_DEFAULTS[passthrough]}" ;;
  off) ZOM_PASSTHROUGH="off" ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.passthrough '$ZOM_PASSTHROUGH' invalid (on|off) — using ${ZOM_DEFAULTS[passthrough]}."
    ZOM_PASSTHROUGH="${ZOM_DEFAULTS[passthrough]}"
  ;;
esac
ZOM_PASSTHROUGH_FILE="$ZOM_DATA_DIR/passthrough.$$"

# Failure→prefill template. Mechanism (TTL check, placeholder substitution)
# lives here; the wording is policy and lives in the config.
# Placeholders: {cmd} {exit} {cwd}. "off" disables the prefill entirely.
ZOM_FAILURE_PREFILL_TMPL=${ZOM_CFG[failurePrefill]}
case "$ZOM_FAILURE_PREFILL_TMPL" in
  "") ZOM_FAILURE_PREFILL_TMPL="${ZOM_DEFAULTS[failurePrefill]}" ;;
  off) ZOM_FAILURE_PREFILL_TMPL="" ;;
esac

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
# __ZOM_T0/__ZOM_CMD cross the hook boundary (preexec -> precmd), so they
# must live at global scope for the duration of one command; precmd copies
# both into locals and unsets them before the next prompt can observe them.
__zom_preexec() {
  typeset -g __ZOM_T0=$EPOCHREALTIME
  typeset -g __ZOM_CMD=$1
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

  local elapsed_ms=$(( (EPOCHREALTIME - t0) * 1000 ))
  # A wall-clock step backwards between preexec and precmd makes the duration
  # negative; 0 is the honest floor (and keeps "-0"/negative ms out of the store).
  # Plain if, not `&&`, so it cannot trip err_return in the user's shell.
  if (( elapsed_ms < 0 )); then elapsed_ms=0; fi
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

  # Per-line parse: one malformed line must not cost the valid lines after it
  # (a chunk-level jq loses everything past the first bad line, and the cursor
  # would advance past them anyway).
  local line text bad=0
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    if text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null); then
      if [[ -n "$text" ]]; then
        print -u2 -- "zom: $text"
      fi
    else
      bad=$(( bad + 1 ))
    fi
  done <<< "${chunk[1,consumed]}"
  if (( bad > 0 )); then
    print -u2 -- "zsh-opencode-mini: $bad unparsable outbox line(s) skipped (cursor advanced)"
  fi

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
  "$ZOM_BINARY" run -s "$sid" "$@" >/dev/null 2>&1 &
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

# Fresh failure -> a prefilled prompt for the composer (fork --prefill: the
# text lands in the input box unsent; the user reviews and hits enter).
# Returns non-zero when no failure signal is fresh.
__zom_failure_prefill() {
  [[ -n "$ZOM_FAILURE_PREFILL_TMPL" ]] || return 1
  local f="$ZOM_DATA_DIR/last-failure.json"
  [[ -f "$f" ]] || return 1
  local info
  info=$(jq -r '[.epoch // 0, .exit // "?", .cmd // ""] | @tsv' "$f" 2>/dev/null) || return 1
  local epoch exit_code cmd
  epoch=${info[(w)1]}
  exit_code=${info[(w)2]}
  cmd=${info[(w)3,-1]}
  [[ "$epoch" == <-> ]] || return 1
  (( EPOCHSECONDS - epoch <= ZOM_FAILURE_TTL )) || return 1
  local out=${ZOM_FAILURE_PREFILL_TMPL//\{cmd\}/$cmd}
  out=${out//\{exit\}/$exit_code}
  out=${out//\{cwd\}/$PWD}
  printf -- '%s' "$out"
}

# The argv contract between this plugin and the zom fork build: one function
# builds the complete `mini` argv, one probe verifies the binary actually
# knows these flags, and the launcher only probes + execs.

# Capability probe. The stock opencode binary lacks the fork's mini flags
# and would fail or silently degrade at exec time, so before the first
# launch ask `mini --help` for every flag this plugin passes (the top-level
# --help does not list subcommand flags). Success is cached for the shell's
# lifetime — one fork ever. Failure is deliberately not cached: the user may
# swap in a fixed binary, and the next launch must retry the probe.
typeset -g ZOM_PROBE_OK=""
__zom_mini_probe() {
  if [[ "$ZOM_PROBE_OK" == ok ]]; then
    return 0
  fi
  if [[ -z "$ZOM_BINARY" ]]; then
    print -u2 -- "zsh-opencode-mini: mini launcher binary not found: $ZOM_BINARY"
    print -u2 -- "  install it:  scripts/install-zom-binary.sh   (or pin shell.binary)"
    return 1
  fi
  local help
  if ! help=$("$ZOM_BINARY" mini --help 2>&1); then
    print -u2 -- "zsh-opencode-mini: '$ZOM_BINARY mini --help' failed — not a working mini binary"
    return 1
  fi
  local -a missing=()
  local f
  for f in --agent --replay-limit --no-replay --prefill; do
    if [[ "$help" != *"$f"* ]]; then
      missing+=("$f")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    print -u2 -- "zsh-opencode-mini: $ZOM_BINARY does not advertise mini flags: ${missing[*]}"
    print -u2 -- "  the binary is likely not the zom fork build — install: scripts/install-zom-binary.sh (or pin shell.binary)"
    return 1
  fi
  ZOM_PROBE_OK=ok
}

# out-param ZOM_ARGV: the caller declares it local (zsh dynamic scoping
# carries the binding here), so the array never occupies the user's global
# namespace.
__zom_mini_argv() {
  ZOM_ARGV=(mini)
  if [[ "$ZOM_RESUME" == main ]]; then
    ZOM_ARGV+=(-s "$ZOM_MAIN_SESSION")
    case "$ZOM_REPLAY" in
      on)  ZOM_ARGV+=(--replay-limit "$ZOM_REPLAY_LIMIT") ;;
      off) ZOM_ARGV+=(--no-replay) ;;
    esac
  fi
  ZOM_ARGV+=(--agent "$ZOM_AGENT")
  if [[ -n "${ZOM_CFG[model]}" ]]; then
    ZOM_ARGV+=(-m "${ZOM_CFG[model]}")   # no variant-only flag: variant rides on -m
  fi
  # Fresh failure -> a prefilled composer (fork --prefill: the text lands in
  # the input box unsent; the user reviews and hits enter).
  local prefill
  if prefill=$(__zom_failure_prefill); then
    ZOM_ARGV+=(--prefill "$prefill")
  fi
  ZOM_ARGV+=("$@")   # caller's extra args, verbatim
}

# The single launch path, shared by the keybind widget and the `zom` function.
# Kept free of ZLE calls so tests can exercise it without a line editor.
__zom_launch_mini() {
  if ! __zom_mini_probe; then
    return 1   # loud: the probe already reported on stderr; do not exec
  fi
  # The summon loop reuses one session; the entry ("▪ oc mini …") and exit
  # ("Session …") splash banners would stamp a fresh pair into scrollback on
  # every C-x. Hide them via the CLI-config env overlay — this plugin-owned
  # override never touches the user's cli.json.
  local -x OPENCODE_CLI_CONFIG_CONTENT='{"mini":{"splash":"hide"}}'
  if [[ "$ZOM_PASSTHROUGH" == on ]]; then
    rm -f "$ZOM_PASSTHROUGH_FILE"
    local -x ZOM_PASSTHROUGH_FILE="$ZOM_PASSTHROUGH_FILE"
  fi
  local -a ZOM_ARGV
  __zom_mini_argv "$@"
  "$ZOM_BINARY" "${ZOM_ARGV[@]}"
}

# ZLE widget: pause the line editor (zle -I), run the fullscreen TUI,
# then repaint the prompt.
__zom_mini_widget() {
  zle -I
  # opentui inline renderer clears the screen when mini starts with the
  # cursor past column 0; zle -I leaves the cursor at the prompt column.
  # Emit a newline so mini starts on a fresh line (same as a direct command).
  print -- ""
  # Always cold-start: hiding mini is a clean exit (no stopped job exists),
  # and the session lives on the server, so a fresh process replays it. No
  # job-table lookups, no fg.
  # A keypress must survive an err_return zshrc; the failure printed its
  # own stderr, so the return value carries nothing new.
  __zom_launch_mini || true
  # Passthrough replay: mini exited on a key it does not handle and left the
  # raw bytes in the passthrough file. Push them into ZLE so the key takes
  # effect at the shell prompt instead of being lost.
  if [[ "$ZOM_PASSTHROUGH" == on && -s "$ZOM_PASSTHROUGH_FILE" ]]; then
    local keys
    keys=$(<"$ZOM_PASSTHROUGH_FILE")
    rm -f "$ZOM_PASSTHROUGH_FILE"
    zle -U -- "$keys"
  fi
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
  "$ZOM_BINARY" run "Explain and fix this failed command (run in the current directory): $last_failed"
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

# ---- Configuration report (read-only) --------------------------------------
# zom-config prints every knob the plugin reads, the value in effect in this
# shell (captured when the plugin loaded — open a new shell to pick up
# edits), and whether it came from the user's config or the defaults table;
# plus the state of the parts installed on the opencode side. The plugin
# never writes any configuration file.
__zom_cfg_line() {
  local key=$1 value=$2
  local origin=default
  [[ -n "${ZOM_CFG[$key]}" ]] && origin=config   # config spoke for this key
  case "$key" in
    keybind | failurePrefill) [[ -z "$value" ]] && value="off (disabled)" ;;
    model) [[ -z "$value" ]] && value="(not pinned — agent default)" ;;
  esac
  printf '  %-18s %s  (%s)\n' "$key" "$value" "$origin"
}
zom-config() {
  emulate -L zsh
  local strip='s|^[[:space:]]*//.*||'
  print -r -- "zsh-opencode-mini — configuration report (the plugin never writes config)"
  case "$ZOM_CFG_STATUS" in
    ok)         print -r -- "config: $ZOM_CONFIG" ;;
    absent)     print -r -- "config: $ZOM_CONFIG (absent — built-in defaults below)" ;;
    unparsable) print -r -- "config: $ZOM_CONFIG (UNPARSABLE — built-in defaults below)" ;;
  esac
  print -r -- "shell (read once when the plugin loads; open a new shell to apply edits):"
  __zom_cfg_line binary         "$ZOM_BINARY"
  __zom_cfg_line keybind        "$ZOM_KEYBIND"
  __zom_cfg_line dataDir        "$ZOM_DATA_DIR"
  __zom_cfg_line resume         "$ZOM_RESUME"
  __zom_cfg_line replay         "$ZOM_REPLAY"
  __zom_cfg_line replayLimit    "$ZOM_REPLAY_LIMIT"
  __zom_cfg_line passthrough    "$ZOM_PASSTHROUGH"
  __zom_cfg_line failurePrefill "$ZOM_FAILURE_PREFILL_TMPL"
  __zom_cfg_line model          "${ZOM_CFG[model]}"
  print -r -- "companion (read by the opencode-side plugin, per session):"
  __zom_cfg_line failureTtlSeconds "$ZOM_FAILURE_TTL"
  __zom_cfg_line recentDefaultN    "${ZOM_CFG[recentDefaultN]:-${ZOM_DEFAULTS[recentDefaultN]}}"
  print -r -- "recipes (top-level \"recipes\"; the name becomes the tool name and the [zom:<name>] tag):"
  local names name rjson origin
  names=$( [[ -f "$ZOM_CONFIG" ]] && sed "$strip" "$ZOM_CONFIG" | jq -r '.recipes // {} | keys[]' 2>/dev/null )
  if [[ -z "$names" ]]; then
    print -r -- "  (none defined)"
  else
    for name in ${(f)names}; do
      origin="ok"
      [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || origin="INVALID — name must match ^[A-Za-z0-9_-]+$"
      rjson=$( [[ -f "$ZOM_CONFIG" ]] && sed "$strip" "$ZOM_CONFIG" | jq -c --arg n "$name" '.recipes[$n] | {on: (.on // "?"), model: (.model // "?")}' 2>/dev/null )
      printf '  %-18s %s  %s\n' "$name" "$origin" "$rjson"
    done
  fi
  print -r -- "opencode-side parts:"
  local part resolved fm
  for part in "$HOME/.config/opencode/plugins/zom-companion.js" "$HOME/.config/opencode/agent/zsh-companion.md"; do
    if [[ -L "$part" ]]; then
      resolved=$(readlink "$part")
      print -r -- "  $part"
      print -r -- "    -> $resolved"
    elif [[ -f "$part" ]]; then
      print -r -- "  $part (regular file)"
      resolved="$part"
    else
      print -r -- "  $part MISSING — the AI side is blind (no history tool, failure signal, or recipes)"
      resolved=""
    fi
    if [[ -n "$resolved" && "$part" == *.md ]]; then
      fm=$(awk 'NR==1 && /^---[[:space:]]*$/ {f=1; next} f && /^---[[:space:]]*$/ {exit} f && /^[A-Za-z][A-Za-z0-9]*:/ {print substr($0,1,index($0,":")-1)}' "$resolved" 2>/dev/null | paste -sd, -)
      [[ -n "$fm" ]] && print -r -- "    frontmatter: $fm"
    fi
  done
  print -r -- "mini launcher: $ZOM_BINARY"
  if ! command -v "$ZOM_BINARY" >/dev/null 2>&1; then
    print -r -- "  NOT FOUND — run scripts/install-zom-binary.sh or set shell.binary"
  fi
}
