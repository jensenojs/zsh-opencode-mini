# zsh-opencode-mini.plugin.zsh
# The shell side of zsh-opencode-mini: command recording, the outbox consumer
# (cross-side return channel from the opencode plugin), background-session
# spawning, and the opencode mini launcher.
# Principle: zero intrusion into the user's zsh — registers via idempotent
# appends to the preexec_functions/precmd_functions arrays, never overwrites
# widgets, never touches the prompt. Uninstall = remove the source line.
#
# Configuration is deliberately minimal: only what is genuinely shell-side
# (data path, summon keybind). Strategy knobs live on the opencode side, in
# the jsonc config read by companion.js — see README.md.

# ---- Configuration: one TOML file, two consumers ----
# ~/.config/zsh-opencode-mini/config.toml — its "shell" section is read here,
# its "companion" and "recipes" sections by companion.js.
# Both sides parse the same document with python's tomllib, so there is exactly
# one parser and no JSON shim to drift. There is no env-var configuration
# surface. Missing file / missing keys -> defaults; the plugin works with zero
# configuration.
ZOM_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/zsh-opencode-mini/config.toml"

# Interpreter with tomllib (3.11+). The first `python3` on PATH is not
# necessarily it — a project virtualenv or a distro python3.10 shadows it, and
# then every read fails as "unparsable" for a reason the user cannot see.
# Resolve once per shell and reuse; ZOM_PYTHON overrides.
__zom_python() {
  [[ -n "${__ZOM_PY:-}" ]] && return 0
  local candidate
  for candidate in ${=ZOM_PYTHON:-} python3 python3.14 python3.13 python3.12 python3.11; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import tomllib' >/dev/null 2>&1; then
      __ZOM_PY=$candidate
      return 0
    fi
  done
  print -u2 -- "zsh-opencode-mini: no python3 with tomllib (3.11+) found; config is ignored."
  print -u2 -- "  set ZOM_PYTHON=/path/to/python3 or install one."
  return 1
}

# Normalized JSON view of the TOML document. Empty output + non-zero status
# means "absent or unparsable", which every caller treats as "use defaults".
__zom_config_json() {
  [[ -f "$ZOM_CONFIG" ]] || return 1
  __zom_python || return 1
  "$__ZOM_PY" - "$ZOM_CONFIG" <<'PYTOML'
import json, sys, tomllib
try:
    with open(sys.argv[1], "rb") as handle:
        json.dump(tomllib.load(handle), sys.stdout)
except Exception:
    raise SystemExit(1)
PYTOML
}

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
    ZOM_CFG[keybindConflict]=""
    ZOM_CFG[dataDir]=""
    ZOM_CFG[agent]=""
    ZOM_CFG[sharedDatabase]=""
    ZOM_CFG[resume]=""
    ZOM_CFG[replay]=""
    ZOM_CFG[replayLimit]=""
    ZOM_CFG[passthrough]=""
    ZOM_CFG[passthroughKeys]=""
    ZOM_CFG[historyRetainMonths]=""
    ZOM_CFG[osc]=""
    ZOM_CFG[stderrCapture]=""
    ZOM_CFG[failurePrefill]=""
    ZOM_CFG[model]=""
    ZOM_CFG[leader]=""
    ZOM_CFG[failureTtlSeconds]=""
    ZOM_CFG[recentDefaultN]=""'
  # One document, one jq: emit all assignments. `// ""` maps jq's falsy
  # values (null/false) to empty = "not set", exactly what the per-key
  # `// empty` reads did before; a wrong-typed section makes jq fail, which
  # lands in the same loud-defaults path as a syntax error.
  local -r q='.shell as $s |
    "ZOM_CFG[binary]="            + (($s.binary         // "") | @sh),
    "ZOM_CFG[keybind]="           + (($s.keybind        // "") | @sh),
    "ZOM_CFG[keybindConflict]="   + (($s.keybindConflict // "") | @sh),
    "ZOM_CFG[dataDir]="           + (($s.dataDir        // "") | @sh),
    "ZOM_CFG[agent]="             + (($s.agent          // "") | @sh),
    "ZOM_CFG[sharedDatabase]="    + (($s.sharedDatabase // "") | @sh),
    "ZOM_CFG[resume]="            + (($s.resume         // "") | @sh),
    "ZOM_CFG[replay]="            + (($s.replay         // "") | @sh),
    "ZOM_CFG[replayLimit]="       + (($s.replayLimit    // "") | @sh),
    "ZOM_CFG[passthrough]="       + (($s.passthrough    // "") | @sh),
    "ZOM_CFG[passthroughKeys]="   + (($s.passthroughKeys // "") | @sh),
    "ZOM_CFG[historyRetainMonths]=" + (($s.historyRetainMonths // "") | @sh),
    "ZOM_CFG[osc]="               + (($s.osc            // "") | @sh),
    "ZOM_CFG[stderrCapture]="     + (($s.stderrCapture  // "") | @sh),
    "ZOM_CFG[failurePrefill]="    + (($s.failurePrefill // "") | @sh),
    "ZOM_CFG[model]="             + (($s.model          // "") | @sh),
    "ZOM_CFG[leader]="            + (($s.leader         // "") | @sh),
    "ZOM_CFG[failureTtlSeconds]=" + ((.companion.failureTtlSeconds // "") | @sh),
    "ZOM_CFG[recentDefaultN]="    + ((.companion.recentDefaultN    // "") | @sh)'
  local assignments
  if [[ ! -f "$ZOM_CONFIG" ]]; then
    eval "$empty"
  elif assignments=$(__zom_config_json | jq -re "$q" 2>/dev/null); then
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
  [keybindConflict]="notify"
  [dataDir]="${XDG_DATA_HOME:-$HOME/.local/share}/zsh-opencode-mini"
  [agent]="mini"
  [sharedDatabase]="on"
  [resume]="main"
  [replay]="on"
  [replayLimit]="50"
  [passthrough]="on"
  [passthroughKeys]=""
  [historyRetainMonths]="6"
  [osc]="on"
  [stderrCapture]="on"
  [failurePrefill]=$'上一条命令失败了（exit {exit}）：{cmd}\n帮我分析失败原因并给出修复建议'
  [model]=""
  [leader]="ctrl+m"
  [failureTtlSeconds]="600"
  [recentDefaultN]="20"
)

__zom_cfg_load

# ---- Config validation (product surface, not decoration) ------------------
# Every value below is read individually and normalized, so a typo in a key
# name is invisible: the real key keeps its default and the shell behaves as
# if the line were never written. Same for a wrong type, which jq silently
# turns into an empty string. Both are the kind of failure a user cannot debug
# from the outside, so the loader reports them once per shell instead of
# guessing. Values are still read elsewhere; this pass only reports.
__zom_config_check() {
  [[ -n "${__ZOM_CONFIG_CHECKED:-}" ]] && return 0
  __ZOM_CONFIG_CHECKED=1
  [[ -f "$ZOM_CONFIG" ]] || return 0
  __zom_python || return 0
  "$__ZOM_PY" - "$ZOM_CONFIG" <<'PYCHECK'
import sys
import tomllib

STR, INT, LIST = "string", "integer", "array"
# key -> accepted types. Unions are spelled out; "off" as a value of an
# integer key (historyRetainMonths) is a string and is accepted there.
SHELL = {
    "binary": (STR,), "dataDir": (STR,), "agent": (STR,), "keybind": (STR,),
    "keybindConflict": (STR,), "resume": (STR,), "replay": (STR,),
    "replayLimit": (INT,), "passthrough": (STR,), "passthroughKeys": (STR,),
    "historyRetainMonths": (INT, STR), "osc": (STR,), "stderrCapture": (STR,),
    "failurePrefill": (STR,), "model": (STR,), "leader": (STR,),
    "sharedDatabase": (STR,), "failureTtlSeconds": (INT,), "recentDefaultN": (INT,),
}
COMPANION = {
    "failureTtlSeconds": (INT,), "recentDefaultN": (INT,),
    "repeatFailureThreshold": (INT,), "autoTitle": (STR,),
    "autoTitleIdleMinutes": (INT,),
}
RECIPE = {
    "on": (STR,), "model": (STR,), "prompt": (STR,), "deliver": (STR,),
    "exitFilter": (LIST,), "ratePerHour": (INT,), "ttlSeconds": (INT,),
}

def kind(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return INT
    if isinstance(value, str):
        return STR
    if isinstance(value, list):
        return LIST
    if isinstance(value, dict):
        return "table"
    return type(value).__name__

try:
    with open(sys.argv[1], "rb") as handle:
        doc = tomllib.load(handle)
except Exception:
    raise SystemExit(0)  # the loader already reports unparsable configs

problems = []
for section, schema in (("shell", SHELL), ("companion", COMPANION)):
    table = doc.get(section)
    if table is None:
        continue
    if not isinstance(table, dict):
        problems.append(f"[{section}] is {kind(table)}, expected a table")
        continue
    for key, value in table.items():
        if key not in schema:
            problems.append(f"[{section}] {key} is not a known key (ignored)")
            continue
        actual = kind(value)
        if actual not in schema[key]:
            problems.append(f"[{section}] {key} = {value!r} is {actual}, expected {' or '.join(schema[key])}")

recipes = doc.get("recipes")
if recipes is not None and not isinstance(recipes, dict):
    problems.append("[recipes] is not a table")
elif isinstance(recipes, dict):
    for name, recipe in recipes.items():
        if not isinstance(recipe, dict):
            problems.append(f"[recipes.{name}] is {kind(recipe)}, expected a table")
            continue
        for key, value in recipe.items():
            if key not in RECIPE:
                problems.append(f"[recipes.{name}] {key} is not a known key (ignored)")
                continue
            if kind(value) not in RECIPE[key]:
                problems.append(f"[recipes.{name}] {key} = {value!r} is {kind(value)}, expected {' or '.join(RECIPE[key])}")

for section in doc:
    if section not in ("shell", "companion", "recipes"):
        problems.append(f"[{section}] is not a known section (ignored)")

for line in problems[:6]:
    print(f"zsh-opencode-mini: config: {line}", file=sys.stderr)
if len(problems) > 6:
    print(f"zsh-opencode-mini: config: {len(problems) - 6} more", file=sys.stderr)
PYCHECK
}
__zom_config_check

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

# Summon-key prefix conflict. If other bindings in the keymap start with the
# summon key (zsh's emacs map ships a "^X…" sequence family: ^X^U undo,
# ^Xr/^Xs history search, …), zsh cannot know on the first byte whether you
# mean the bare key or a sequence, so a bare press waits KEYTIMEOUT before it
# dispatches — the summon costs ~KEYTIMEOUT more than any plain key.
# The plugin reports only; removing the sequences (bindkey -rp) belongs in
# the user's own rc.
#   notify (default)  one-time warning naming what is shadowed and the price
#   off               stay silent
ZOM_KEYBIND_CONFLICT=${ZOM_CFG[keybindConflict]}
case "$ZOM_KEYBIND_CONFLICT" in
  "" | null) ZOM_KEYBIND_CONFLICT="${ZOM_DEFAULTS[keybindConflict]}" ;;
  notify | off) : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.keybindConflict '$ZOM_KEYBIND_CONFLICT' invalid (notify|off) — using ${ZOM_DEFAULTS[keybindConflict]}."
    ZOM_KEYBIND_CONFLICT="${ZOM_DEFAULTS[keybindConflict]}" ;;
esac

# Which session C-x resumes. "main" (default): one dedicated assistant session,
# fully isolated from whatever opencode sessions you use elsewhere — `-c` here
# would resume your *globally latest* session (often one that is streaming
# right now), which is never what the keybind means. Its identity is a randomly
# generated session id recorded once under the state dir (see __zom_main_sid);
# the id is identity, not a name. "off": a fresh session every time. Anything
# else: warn once, fall back to "main".
ZOM_RESUME=${ZOM_CFG[resume]}
case "$ZOM_RESUME" in
  main | "" | null) ZOM_RESUME="${ZOM_DEFAULTS[resume]}" ;;   # absent -> default
  off)              : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.resume '$ZOM_RESUME' invalid (main|off) — using ${ZOM_DEFAULTS[resume]}."
    ZOM_RESUME="${ZOM_DEFAULTS[resume]}" ;;
esac
# Shared session store. The channel-isolated opencode-zom.db exists to keep the
# fork's schema away from the stock binary's auto-update migrations; opting in
# (default) sets the upstream switch that points the fork back at the one
# shared opencode.db — one session store for both binaries. If a stock update
# ever migrates the schema out from under the fork, "off" restores the
# isolated database without rebuilding anything.
ZOM_SHARED_DB=${ZOM_CFG[sharedDatabase]}
case "$ZOM_SHARED_DB" in
  "" | null | on)  ZOM_SHARED_DB=on ;;
  off)             : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.sharedDatabase '$ZOM_SHARED_DB' invalid (on|off) — using on."
    ZOM_SHARED_DB=on ;;
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

# ---- small predicates ----
# Unsigned-integer test with no EXTENDED_GLOB dependency: `<->` and `[0-9]##`
# silently mis-match when the user's zshrc leaves that option off (the stock
# default), which would route every valid number into the "invalid" branch.
# A negated bracket class is plain glob and works everywhere.
__zom_is_uint() {
  [[ -n "$1" && "$1" != *[!0-9]* ]]
}

# ---- Internal defaults (not configuration; edit the source if you must) ----
# ---- State: the main-session pointer ---------------------------------------
# Session ids are generated by whoever creates the session; upstream only
# demands the "ses_" prefix. The plugin mints one (8 bytes of urandom), records
# it under XDG_STATE_HOME, and resumes that id from then on — nothing in the
# database carries a readable nickname, and rendering never owns identity.
typeset -g ZOM_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/zsh-opencode-mini"
mkdir -p "$ZOM_STATE_DIR" 2>/dev/null || true
typeset -g ZOM_MAIN_SID=""

__zom_main_sid() {
  local f="$ZOM_STATE_DIR/main-session" sid
  if [[ -f "$f" ]]; then
    sid=$(<"$f")
    # A hand-edited or corrupt pointer falls back to minting a fresh id: the
    # file must hold exactly one well-formed session id.
    if [[ "$sid" == ses_* && "$sid" != *[!0-9a-zA-Z_-]* ]]; then
      print -r -- "$sid"
      return 0
    fi
  fi
  sid="ses_$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  print -r -- "$sid" > "$f" 2>/dev/null || return 1
  print -r -- "$sid"
}
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
elif ! __zom_is_uint "$ZOM_REPLAY_LIMIT" || [[ "$ZOM_REPLAY_LIMIT" -lt 1 ]]; then
  print -u2 -- "zsh-opencode-mini: shell.replayLimit '$ZOM_REPLAY_LIMIT' invalid (positive integer) — using ${ZOM_DEFAULTS[replayLimit]}."
  ZOM_REPLAY_LIMIT="${ZOM_DEFAULTS[replayLimit]}"
fi
# shell.osc "on" (default) | "off" — off skips the per-command OSC report
# entirely (also saves its base64 fork). The frame is a private protocol;
# terminals without a receiver swallow it, so on is safe everywhere, but off
# is the honest choice when you know nothing consumes it.
ZOM_OSC=${ZOM_CFG[osc]}
case "$ZOM_OSC" in
  on | "" | null) ZOM_OSC="${ZOM_DEFAULTS[osc]}" ;;   # absent -> default
  off)            : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.osc '$ZOM_OSC' invalid (on|off) — using ${ZOM_DEFAULTS[osc]}."
    ZOM_OSC="${ZOM_DEFAULTS[osc]}" ;;
esac
(( $+ZOM_OSC_CODE )) || typeset -gr ZOM_OSC_CODE="7777"         # private OSC code; may change when the fork lands

# shell.stderrCapture "on" (default) | "off" — "on" installs one resident tee
# process at source time (the stderr-tail block below) that mirrors the
# shell's stderr into <dataDir>/stderr-tail.log while still writing every
# byte to the terminal; "off" leaves the shell's stderr untouched.
ZOM_STDERR_CAPTURE=${ZOM_CFG[stderrCapture]}
case "$ZOM_STDERR_CAPTURE" in
  on | "" | null) ZOM_STDERR_CAPTURE="${ZOM_DEFAULTS[stderrCapture]}" ;;   # absent -> default
  off)            : ;;
  *)
    print -u2 -- "zsh-opencode-mini: shell.stderrCapture '$ZOM_STDERR_CAPTURE' invalid (on|off) — using ${ZOM_DEFAULTS[stderrCapture]}."
    ZOM_STDERR_CAPTURE="${ZOM_DEFAULTS[stderrCapture]}" ;;
esac

# Failure→prefill TTL (seconds). Shared with the opencode-side companion
# plugin, which guards the same last-failure.json signal with the same key.
ZOM_FAILURE_TTL=${ZOM_CFG[failureTtlSeconds]}
[[ "$ZOM_FAILURE_TTL" == "" || "$ZOM_FAILURE_TTL" == "null" ]] && ZOM_FAILURE_TTL="${ZOM_DEFAULTS[failureTtlSeconds]}"
if ! __zom_is_uint "$ZOM_FAILURE_TTL" || [[ "$ZOM_FAILURE_TTL" -lt 1 ]]; then
  print -u2 -- "zsh-opencode-mini: companion.failureTtlSeconds '$ZOM_FAILURE_TTL' invalid (positive integer) — using ${ZOM_DEFAULTS[failureTtlSeconds]}."
  ZOM_FAILURE_TTL="${ZOM_DEFAULTS[failureTtlSeconds]}"
fi

# Key passthrough (default on). When mini sees a key nobody claims (not a
# keymap action, not composer input), the fork logs it as a JSON line to
# $ZOM_PASSTHROUGH_FILE.keys.log (rolling cap, newest kept) and keeps
# running — an unhandled key must not kill the TUI. Keys listed in
# shell.passthroughKeys (comma-separated strokes, e.g. "ctrl+r") keep the
# old exit-and-replay behaviour: mini writes the raw bytes to
# ZOM_PASSTHROUGH_FILE and exits; the widget replays them into ZLE, so the
# key takes effect in the shell. "off" restores the old swallow behaviour.
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
ZOM_PASSTHROUGH_KEYS=${ZOM_CFG[passthroughKeys]}
[[ "$ZOM_PASSTHROUGH_KEYS" == null ]] && ZOM_PASSTHROUGH_KEYS=""

# History retention. Monthly files accumulate forever otherwise; files older
# than shell.historyRetainMonths are deleted once per shell at source time.
# "off" keeps everything.
ZOM_HISTORY_RETAIN=${ZOM_CFG[historyRetainMonths]}
case "$ZOM_HISTORY_RETAIN" in
  "" | null) ZOM_HISTORY_RETAIN="${ZOM_DEFAULTS[historyRetainMonths]}" ;;
  off)       ZOM_HISTORY_RETAIN="" ;;
  *)
    if ! __zom_is_uint "$ZOM_HISTORY_RETAIN" || [[ "$ZOM_HISTORY_RETAIN" -lt 1 ]]; then
      print -u2 -- "zsh-opencode-mini: shell.historyRetainMonths '$ZOM_HISTORY_RETAIN' invalid (positive integer|off) — using ${ZOM_DEFAULTS[historyRetainMonths]}."
      ZOM_HISTORY_RETAIN="${ZOM_DEFAULTS[historyRetainMonths]}"
    fi ;;
esac

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

if [[ ! -d "$ZOM_DATA_DIR" ]]; then
  mkdir -p "$ZOM_DATA_DIR" 2>/dev/null || \
    print -u2 -- "zsh-opencode-mini: cannot create data dir $ZOM_DATA_DIR — recording disabled"
fi

# ---- stderr capture (dual mode, resolved once at source) --------------------
# last-failure.json records THAT a command failed; the model asking "why did
# it fail" also needs the stderr of the failure. Two channels, picked ONCE
# per shell — never switched after a failed capture:
#   scrollback — $WEZTERM_PANE names a pane this wezterm instance actually
#                serves: stderr is never touched; on failure the pane's own
#                text tail is fetched via `wezterm cli get-text`.
#   tee        — otherwise, when a TTY exists: one resident tee per shell
#                mirrors stderr to the terminal (byte for byte, display
#                semantics untouched) and into a bounded append-only log.
# The probe is a real `get-text` — the exact call the failure path will make
# — because `wezterm cli list` has no --pane-id filter to ask with and exit
# status is the only format-independent reachability answer. A stale or
# inherited WEZTERM_PANE (pane closed, ssh env) fails the probe and lands in
# tee mode: the same guard the spawn hooks needed against "WEZTERM_PANE was
# inherited". wezterm absent from PATH, capture off, or a tty-less shell
# (scripts, test sandboxes): no channel, and nothing is installed.
# What this is NOT: a general transcript — stdout is never captured (the
# scrollback tail mixes it in only because the terminal holds both), and the
# tee log holds at most one rotation window of output.
ZOM_STDERR_LOG="$ZOM_DATA_DIR/stderr-tail.log"
# knockout: fixed 256 KB window; make it configurable if a real workload
# legitimately needs more than the last few screens of stderr
(( $+ZOM_STDERR_MAX_BYTES )) || typeset -gr ZOM_STDERR_MAX_BYTES=262144
ZOM_STDERR_MODE=""
if [[ "$ZOM_STDERR_CAPTURE" == on ]]; then
  if [[ -n "${WEZTERM_PANE:-}" ]] && (( $+commands[wezterm] )) \
    && wezterm cli get-text --pane-id "$WEZTERM_PANE" >/dev/null 2>&1; then
    ZOM_STDERR_MODE=scrollback
  elif [[ -n "${TTY:-}" && -d "$ZOM_DATA_DIR" ]] && (( $+commands[tee] )); then
    # tee's log write is O_APPEND (tee -a), which is what makes rotation below
    # a plain truncate: once the file is emptied, the next append lands at the
    # new (zero) end of file. No mv, no fd swap, no second tee, no lingering
    # writer on a stale inode — the cost is that writes racing the truncate
    # can be lost, which only ever blurs a tail that exists to be recent.
    # The `> "$TTY"` write-back exists only inside this branch — scrollback
    # mode never redirects fd 2 at all.
    if exec 2> >(tee -a "$ZOM_STDERR_LOG" > "$TTY" 2>/dev/null); then
      ZOM_STDERR_MODE=tee
    else
      print -u2 -- "zsh-opencode-mini: stderr tail capture failed to install — continuing without it"
      ZOM_STDERR_MODE=""
    fi
  fi
fi

# Bounded log, checked once per command with one builtin stat (zero forks —
# the same per-command budget as the [[ -d ]] guard in __zom_precmd). Only
# the tee writer trims: scrollback mode holds no log, and a channel-less
# shell must not truncate a sibling shell's live log. Runs AFTER the failure
# branch has read the tail, so a rotation can never erase the stderr of the
# very failure being recorded.
__zom_stderr_rotate() {
  [[ "$ZOM_STDERR_MODE" == tee ]] || return 0
  (( $+builtins[zstat] )) || return 0
  local -a st
  if ! zstat -A st +size "$ZOM_STDERR_LOG" 2>/dev/null; then
    return 0   # no log yet (capture off, or nothing written this session)
  fi
  if (( st[1] > ZOM_STDERR_MAX_BYTES )); then
    : > "$ZOM_STDERR_LOG" 2>/dev/null
  fi
  return 0
}

# Single owner of the stderr shape contract: last ~20 lines, capped at 4 KB
# total, control characters except TAB/LF/CR stripped (a raw ESC from coloured
# output would make the JSON unreadable to JSON.parse-based consumers). Both
# channels feed this — the companion's stderr slot must not be able to tell
# which channel produced a record.
__zom_stderr_shape() {
  tail -n 20 | tail -c 4096 | LC_ALL=C tr -d '\000-\010\013\014\016-\037'
}

# tty ownership of a failure signal: another terminal's failure must not
# surface in this one. "" on either side means "cannot tell" — legacy records
# written before the tty field existed, or shells without a terminal (scripts,
# test sandboxes) — and degrades to the previous global-latest behaviour
# instead of hiding a real failure from everyone. One predicate for all three
# consumers (prefill gate, zom-last gate, the success flush in __zom_precmd),
# so reading and clearing can never disagree about who owns a signal.
__zom_tty_owned() {
  [[ -z "$1" || -z "${TTY:-}" || "$1" == "$TTY" ]]
}

# Rolling history cleanup, once per shell. YYYY-MM strings compare
# lexicographically, so a file is dropped when its month sorts before the
# cutoff month. Month arithmetic goes through a total-months counter to
# avoid year-boundary special cases.
if [[ -n "$ZOM_HISTORY_RETAIN" && -d "$ZOM_DATA_DIR" ]]; then
  {
    strftime -s _ZOM_Y '%Y' $EPOCHSECONDS
    strftime -s _ZOM_M '%m' $EPOCHSECONDS
    _ZOM_TOTAL=$(( _ZOM_Y * 12 + 10#$_ZOM_M - ZOM_HISTORY_RETAIN - 1 ))
    _ZOM_CUTOFF=$(printf '%04d-%02d' $(( _ZOM_TOTAL / 12 )) $(( _ZOM_TOTAL % 12 + 1 )))
    for _ZOM_F in "$ZOM_DATA_DIR"/history-*.jsonl(N); do
      _ZOM_NAME=${${_ZOM_F:t}#history-}
      _ZOM_NAME=${_ZOM_NAME%.jsonl}
      [[ "$_ZOM_NAME" < "$_ZOM_CUTOFF" ]] && command rm -f "$_ZOM_F"
    done
    unset _ZOM_Y _ZOM_M _ZOM_TOTAL _ZOM_CUTOFF _ZOM_F _ZOM_NAME
  } 2>/dev/null
fi

# (The pathological-growth sentinel lives at the bottom of this file, after
# the helper functions it uses.)

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

# preexec: command starts. Store start time, command text, and the terminal
# identity (pane id) the command ran in (precmd does not receive the command
# line, and $WEZTERM_PANE is env-static but recorded per command so history
# lines and failure signals carry their terminal of origin).
# __ZOM_T0/__ZOM_CMD/__ZOM_PANE cross the hook boundary (preexec -> precmd),
# so they must live at global scope for the duration of one command; precmd
# copies all three into locals and unsets them before the next prompt can
# observe them.
__zom_preexec() {
  # File-mode scripts (`zsh script.zsh`) dispatch preexec before EVERY line
  # with an empty command argument (zsh 5.9, whenever preexec_functions is
  # non-empty — unrelated to how the hook was registered). A real interactive
  # preexec always carries the command line, so per-line phantoms are
  # recognisable by their empty $1; honouring them would clobber __ZOM_CMD
  # between the real preexec and precmd.
  [[ -n "$1" ]] || return 0
  typeset -g __ZOM_T0=$EPOCHREALTIME
  typeset -g __ZOM_CMD=$1
  typeset -g __ZOM_PANE=${WEZTERM_PANE:-}
}

# precmd: command finished. Append one JSON line to the monthly history file,
# refresh the failure signal file on non-zero exit (with the stderr tail of
# the failure, in the capture mode resolved at source), and emit one OSC
# frame (no receiver exists yet; the format is reserved for wezterm fork hole
# 1). Capture scope: command text + exit code + elapsed ms + cwd + the
# terminal identity (tty, pane id) the command ran in.
# Command stdout is NOT captured; stderr only as a bounded tail on the
# failure signal (the stderr-capture block above).
__zom_precmd() {
  local exit_code=$?                  # first statement: capture $? before anything overwrites it
  [[ -n "${__ZOM_T0:-}" ]] || return 0

  local cmd=${__ZOM_CMD:-}
  local t0=${__ZOM_T0}
  local pane=${__ZOM_PANE:-}
  local tty=${TTY:-}
  unset __ZOM_T0 __ZOM_CMD __ZOM_PANE
  [[ -n "$cmd" ]] || return 0

  # If the data dir could not be created (warning already printed at source
  # time), every redirect below would re-print an error after each command;
  # skip recording instead. `[[ -d ]]` is a builtin stat, no fork per command.
  [[ -d "$ZOM_DATA_DIR" ]] || return 0

  local elapsed_ms=$(( (EPOCHREALTIME - t0) * 1000 ))
  # A wall-clock step backwards between preexec and precmd makes the duration
  # negative; 0 is the honest floor (and keeps "-0"/negative ms out of the store).
  # Plain if, not `&&`, so it cannot trip err_return in the user's shell.
  if (( elapsed_ms < 0 )); then elapsed_ms=0; fi
  elapsed_ms=${elapsed_ms%%.*}   # truncate to whole ms (zsh printf has no -v)

  local ts
  strftime -s ts '%Y-%m-%dT%H:%M:%S%z' $EPOCHSECONDS

  # 1) Append to the monthly history store (the only fork in this path is the
  #    base64 below; strftime is a builtin). tty/pane stamp the terminal of
  #    origin: pane attribution for history, and the key that scopes the
  #    failure signal to the terminal that owns it.
  local json
  json=$(printf '{"ts":"%s","cwd":"%s","exit":%d,"ms":%s,"tty":"%s","pane":"%s","cmd":"%s"}' \
    "$ts" "$(__zom_json_escape "$PWD")" "$exit_code" "$elapsed_ms" \
    "$(__zom_json_escape "$tty")" "$(__zom_json_escape "$pane")" "$(__zom_json_escape "$cmd")")
  print -r -- "$json" >> "$ZOM_DATA_DIR/history-$(strftime '%Y-%m' $EPOCHSECONDS).jsonl"

  # 2) Non-zero exit -> atomically refresh the failure signal file
  #    (the opencode-side plugin checks this file against its TTL)
  #    141 (SIGPIPE) and 130 (SIGINT) are excluded: a pipe consumer exiting
  #    early (`git log | head`) or the user interrupting with Ctrl-C are
  #    normal interactions, not failures worth prefilling a repair prompt for.
  if (( exit_code != 0 && exit_code != 141 && exit_code != 130 )); then
    local stderr_tail=""
    if [[ "$ZOM_STDERR_MODE" == scrollback && -n "$pane" ]] && (( $+commands[wezterm] )); then
      # scrollback mode: the pane's own text (screen content at precmd time —
      # stdout mixed with stderr, bounded by the screen height). Fetched
      # fresh, no log exists in this mode.
      stderr_tail=$(wezterm cli get-text --pane-id "$pane" 2>/dev/null | __zom_stderr_shape) || stderr_tail=""
    elif [[ "$ZOM_STDERR_CAPTURE" == on && "$ZOM_STDERR_MODE" == tee && -s "$ZOM_STDERR_LOG" ]]; then
      # tee mode reads the log its resident tee wrote. A channel-less shell
      # reads nothing: it has no interaction prompt to consume the tail, and
      # mixing a sibling's log into this failure would misattribute the
      # evidence (the redirect cannot fail — the -s guard above).
      stderr_tail=$(__zom_stderr_shape < "$ZOM_STDERR_LOG") || stderr_tail=""
    fi
    printf '{"ts":"%s","epoch":%d,"cwd":"%s","exit":%d,"tty":"%s","pane":"%s","cmd":"%s","stderr":"%s"}\n' \
      "$ts" "$EPOCHSECONDS" "$(__zom_json_escape "$PWD")" "$exit_code" \
      "$(__zom_json_escape "$tty")" "$(__zom_json_escape "$pane")" \
      "$(__zom_json_escape "$cmd")" "$(__zom_json_escape "$stderr_tail")" \
      > "$ZOM_DATA_DIR/last-failure.json.tmp" \
      && mv "$ZOM_DATA_DIR/last-failure.json.tmp" "$ZOM_DATA_DIR/last-failure.json"
  elif (( exit_code == 0 )) && [[ -f "$ZOM_DATA_DIR/last-failure.json" ]]; then
    # "last command failed" must mean THE last command — within the terminal
    # that owns the signal. A success in pane B must not erase pane A's live
    # failure (two panes share the store), so the flush honours the same
    # __zom_tty_owned predicate as the readers. Legacy records without a tty
    # field (and tty-less shells) stay owned by everyone: any success
    # flushes them, exactly the old behaviour.
    local sig_line sig_tty=""
    sig_line=$(<"$ZOM_DATA_DIR/last-failure.json")
    if [[ "$sig_line" == *'"tty":"'* ]]; then
      sig_tty=${${sig_line#*\"tty\":\"}%%\"*}
    fi
    if __zom_tty_owned "$sig_tty"; then
      command rm -f "$ZOM_DATA_DIR/last-failure.json"
    fi
  fi

  # 3) Deliver outbox records that arrived while the command ran (see
  #    __zom_outbox_drain) — pre-prompt, one line per record.
  __zom_outbox_drain

  # 4) OSC report: ESC ] CODE ; zom ; v1 ; <base64(json)> BEL
  #    base64-encoded payload so arbitrary bytes in command text cannot
  #    corrupt the OSC frame (warp uses hex for the same reason).
  #    shell.osc=off skips this entirely, including the base64 fork below —
  #    the frame is a private protocol and terminals without a receiver
  #    swallow it silently.
  if [[ "$ZOM_OSC" == on ]]; then
    local b64
    b64=${$(printf '%s' "$json" | base64)//$'\n'/}
    printf '\e]%s;zom;v1;%s\a' "$ZOM_OSC_CODE" "$b64"
  fi

  # 5) Rotate the stderr tail for the next command (bounded store; see the
  #    stderr-tail block). Deliberately after step 2: the failure branch has
  #    already read the tail this command produced.
  __zom_stderr_rotate
}

# ---- outbox: the cross-side return channel ----
# companion.js is the only writer of outbox.jsonl (recipe
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
  local line text bad=0 bsid
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    if text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null); then
      if [[ -n "$text" ]]; then
        # A bg-done record the companion already injected into a live session
        # is consumed silently: the model already knows (contract on
        # __zom_bg_injected_p below). The string pre-filter keeps the extra
        # jq fork off every non-bg-done record; a record carrying a .sid IS a
        # bg-done record (only appendOutbox's bg-done lines carry one).
        if [[ "$line" == *'"bg-done"'* ]]; then
          bsid=$(printf '%s' "$line" | jq -r '.sid // ""' 2>/dev/null) || bsid=""
          if [[ -n "$bsid" ]] && __zom_bg_injected_p "$bsid"; then
            continue
          fi
        fi
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

# Has the companion already delivered this bg-done session id into a live
# session's context? The opencode-side companion appends {sid: epoch} to
# bg-injected.json at injection time (tmp+mv, the last-failure.json
# protocol); this side only reads it. "Recent" shares the failure TTL
# (companion.failureTtlSeconds -> ZOM_FAILURE_TTL): past the window the
# marker is ignored, so a stale marker can never silence a notice forever.
# Known gap, accepted: the shell can drain a record BEFORE the injection
# happens (no session was open when the event arrived, then the user never
# summoned) — the user then sees the notice twice, once as a terminal line
# and once as a context hint. That is the same at-least-once duplication the
# outbox already tolerates; coordinating the two consumers exactly would
# need a cross-process lock this design deliberately avoids.
__zom_bg_injected_p() {
  local f="$ZOM_DATA_DIR/bg-injected.json"
  [[ -f "$f" ]] || return 1
  local epoch
  epoch=$(jq -r --arg sid "$1" '.[$sid] // 0' "$f" 2>/dev/null) || return 1
  if ! __zom_is_uint "$epoch" || [[ "$epoch" == 0 ]]; then
    return 1
  fi
  if (( EPOCHSECONDS - epoch <= ZOM_FAILURE_TTL )); then
    return 0
  fi
  return 1
}

# ---- background sessions ----
# zom-bg runs a prompt in a dedicated background opencode session. The session
# lives on the shared service (plain `run`), so `opencode mini -s <sid>` can
# attach to it later — --standalone would keep the session client-side and
# unreachable from mini. bg.jsonl is the spawn ledger: the opencode side reads
# it to know which sids to watch for completion, this function prints the sid
# for attaching.
# Spawn-hook dispatch: entries in the ZOM_SPAWN_HOOKS array run before every
# spawn point (mini / zom-bg / zom-last); a failing hook must not block the
# spawn.
# Mechanism/policy split: the plugin owns the spawn facts, hooks own what to
# do with them. Entries may be zsh functions or external executables; both
# receive the spawn context through exported env vars (dynamically scoped —
# set for the hook call, gone on return):
#   ZOM_HOOK_KIND  mini | bg | last
#   ZOM_HOOK_SID   session id when known at hook time (bg always; mini when
#                  resuming the main session; empty otherwise)
#   ZOM_HOOK_CWD   the directory the spawn happens in
# Env vars rather than argv: the contract grows without every consumer
# re-signing, and external executables inherit the same environment.
# Product boundary: zom core ships no terminal-state integration; consumers
# (e.g. wezterm-attention) hook in via ZOM_SPAWN_HOOKS+=(fn) in their own
# zsh config.
typeset -gU ZOM_SPAWN_HOOKS
__zom_run_spawn_hooks() {
  local -x ZOM_HOOK_KIND=${1:-} ZOM_HOOK_SID=${2:-} ZOM_HOOK_CWD=$PWD
  # Usage measurement + summon identity: one line per spawn, all builtins.
  # The tty+cwd stamp is what the companion (zom-companion.js) reads back as
  # "which shell summoned this session" for tty-scoped failure signals and
  # cwd-ranked recent history — the companion has no env channel into the
  # shell, so the ledger is the direct path, last-summon-wins. Hook consumers
  # needing the tty read $TTY directly (function hooks share the shell's
  # scope; external ones get the real device via the stdin redirect below).
  # knockout: unrotated append-only; at ~60 bytes/line even heavy use takes
  # years to matter — if it ever does, fold it into the monthly rotation.
  [[ -d "$ZOM_DATA_DIR" ]] && \
    print -r -- "{\"ts\":$EPOCHSECONDS,\"kind\":\"${ZOM_HOOK_KIND}\",\"tty\":\"$(__zom_json_escape "${TTY:-}")\",\"cwd\":\"$(__zom_json_escape "$PWD")\"}" >> "$ZOM_DATA_DIR/spawns.jsonl"
  local h
  for h in ${=ZOM_SPAWN_HOOKS:-}; do
    if (( $+functions[$h] || $+commands[$h] )) || [[ -x "$h" ]]; then
      # Hooks run on behalf of the interactive user, but one spawn point is a
      # ZLE widget — and inside a widget `[[ -t 0 ]]` is false even in a real
      # terminal (zsh runs widgets with stdin detached). Hooks that probe the
      # terminal (wezterm-attention's claim refuses with "unsafe_tty") would
      # misfire on a widget-spawned mini, so reconnect stdin to the terminal.
      # Redirect from the real device ($TTY), not /dev/tty: on macOS opening
      # /dev/tty yields the ctty alias whose ttyname(3) is literally
      # "/dev/tty" (rdev 2,0), so a consumer identifying its terminal by path
      # mismatches against the mux's tty_name and refuses — that is the
      # "WEZTERM_PANE was inherited" variant. Where no terminal exists at all
      # (cron, tests) fall back to the inherited stdin.
      if [[ -n "${TTY:-}" ]] && ( : < "$TTY" ) 2>/dev/null; then
        "$h" < "$TTY" || {
          # A hook that fails produces no output of its own — without this
          # notice the user's customized scenario silently stops working.
          __zom_notice hook-failure "spawn hook $h exited $? (kind=$ZOM_HOOK_KIND); it did not run"
        }
      else
        "$h" || __zom_notice hook-failure "spawn hook $h exited $? (kind=$ZOM_HOOK_KIND); it did not run"
      fi
    fi
  done
  return 0
}
zom-bg() {
  if (( $# == 0 )); then
    print -u2 -- "zom-bg: usage: zom-bg <prompt...>"
    return 1
  fi
  local sid="ses_zom-bg-${EPOCHSECONDS}-$$"
  # sid exists before the hooks so consumers (e.g. wezterm-attention) can
  # bind the coming background session to this pane's activity.
  __zom_run_spawn_hooks bg "$sid"
  [[ "$ZOM_SHARED_DB" == on ]] && local -x OPENCODE_DISABLE_CHANNEL_DB=1
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
  local info cwd
  info=$(jq -r '[.epoch // 0, .exit // "?", (.tty // ""), .cmd // ""] | @tsv' "$f" 2>/dev/null) || return 1
  cwd=$(jq -r '.cwd // ""' "$f" 2>/dev/null) || return 1
  local epoch exit_code sig_tty cmd rest
  # Split on the first three real tabs only. jq's @tsv escapes tabs inside cmd
  # to a literal backslash-t, so real tabs appear exactly as the field
  # separators; splitting with ${(w)} here would collapse runs of spaces in
  # the original command into one.
  epoch=${info%%$'\t'*}
  rest=${info#*$'\t'}
  exit_code=${rest%%$'\t'*}
  rest=${rest#*$'\t'}
  sig_tty=${rest%%$'\t'*}
  cmd=${rest#*$'\t'}
  __zom_is_uint "$epoch" || return 1
  (( EPOCHSECONDS - epoch <= ZOM_FAILURE_TTL )) || return 1
  # Directory match: a failure observed in another working directory must not
  # surface here, even inside the TTL window (different project, different bug).
  [[ "$cwd" == "$PWD" ]] || return 1
  # Terminal ownership: another pane's failure is invisible here (empty
  # sig_tty = legacy record, owned by everyone). Checked before consume-once:
  # a mismatched glance must not burn the signal for the pane that owns it.
  __zom_tty_owned "$sig_tty" || return 1
  # Consume-once: the prefill is a suggestion — seen is consumed, whether or
  # not the user actually sent it. Record the failure's epoch when we prefill
  # and never prefill the same failure again; a NEW failure carries a new
  # epoch and prefills as usual.
  local pf="$ZOM_DATA_DIR/prefilled-epoch"
  [[ -f "$pf" && $(<"$pf") == "$epoch" ]] && return 1
  local out=${ZOM_FAILURE_PREFILL_TMPL//\{cmd\}/$cmd}
  out=${out//\{exit\}/$exit_code}
  out=${out//\{cwd\}/$PWD}
  print -r -- "$epoch" > "$pf"
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
  for f in --agent --replay-limit --no-replay --prefill --leader; do
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
  if [[ -n "$ZOM_MAIN_SID" ]]; then
    ZOM_ARGV+=(-s "$ZOM_MAIN_SID")
    case "$ZOM_REPLAY" in
      on)  ZOM_ARGV+=(--replay-limit "$ZOM_REPLAY_LIMIT") ;;
      off) ZOM_ARGV+=(--no-replay) ;;
    esac
  fi
  # One source for the agent id: this config key. companion.js reads the same
  # key and registers its agent under it, so the launch and the definition
  # cannot drift apart.
  ZOM_ARGV+=(--agent "${ZOM_CFG[agent]:-${ZOM_DEFAULTS[agent]}}")
  # The leader is a mini-side knob: the main TUI keeps cli.json's leader, and
  # mini gets its own because its dismiss key owns ctrl+x.
  local leader=${ZOM_CFG[leader]:-${ZOM_DEFAULTS[leader]}}
  [[ -n "$leader" ]] && ZOM_ARGV+=(--leader "$leader")
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

# A session's working directory is stored on the session, not derived from the
# directory the launcher happens to sit in — resuming from elsewhere would keep
# the old one forever, and every project-shaped thing (AGENTS.md, tilth, tools)
# would keep describing the wrong tree. The TUI has /cd for this; the summon
# path has to do the same move up front, through the service the CLI already
# launched. Best effort: a server that is not up yet (404/timeout) just means
# the session keeps its directory, never a failed summon.
__zom_sync_session_dir() {  # <sid>
  local sid=$1
  local state=${XDG_STATE_HOME:-$HOME/.local/state}/opencode
  local file=$state/service-${${ZOM_BINARY:t}#opencode-}.json
  [[ -r "$file" ]] || return 0
  local url pw
  url=$(jq -r '.url // empty' "$file" 2>/dev/null) || return 0
  pw=$(jq -r '.password // empty' "$file" 2>/dev/null) || return 0
  [[ -n "$url" && -n "$pw" ]] || return 0
  curl -fsS -m 1 -o /dev/null -X POST "$url/api/session/$sid/move" \
    -u "opencode:$pw" -H 'content-type: application/json' \
    -d "$(jq -Rn --arg d "$PWD" '{directory:$d}')" 2>/dev/null
  return 0
}

# The single launch path, shared by the keybind widget and the `zom` function.
# Kept free of ZLE calls so tests can exercise it without a line editor.
__zom_launch_mini() {
  if ! __zom_mini_probe; then
    return 1   # loud: the probe already reported on stderr; do not exec
  fi
  # The pointer is resolved exactly once per launch: hooks, the cwd sync and
  # the argv must all see the same id even when the file did not exist yet.
  if [[ "$ZOM_RESUME" == main ]]; then
    ZOM_MAIN_SID=$(__zom_main_sid) || {
      print -u2 -- "zsh-opencode-mini: cannot write $ZOM_STATE_DIR/main-session — resuming off for this launch"
      ZOM_MAIN_SID=""
    }
  else
    ZOM_MAIN_SID=""
  fi
  [[ -n "$ZOM_MAIN_SID" ]] && __zom_sync_session_dir "$ZOM_MAIN_SID"
  __zom_run_spawn_hooks mini "$ZOM_MAIN_SID"
  # The summon loop reuses one session; the entry ("▪ oc mini …") and exit
  # ("Session …") splash banners would stamp a fresh pair into scrollback on
  # every C-x. Hide them via the CLI-config env overlay — this plugin-owned
  # override never touches the user's cli.json.
  local -x OPENCODE_CLI_CONFIG_CONTENT='{"mini":{"splash":"hide"}}'
  # One session store with the stock binary (see ZOM_SHARED_DB above).
  [[ "$ZOM_SHARED_DB" == on ]] && local -x OPENCODE_DISABLE_CHANNEL_DB=1
  if [[ "$ZOM_PASSTHROUGH" == on ]]; then
    rm -f "$ZOM_PASSTHROUGH_FILE"
    local -x ZOM_PASSTHROUGH_FILE="$ZOM_PASSTHROUGH_FILE"
    if [[ -n "$ZOM_PASSTHROUGH_KEYS" ]]; then
      local -x ZOM_PASSTHROUGH_KEYS="$ZOM_PASSTHROUGH_KEYS"
    fi
  fi
  local -a ZOM_ARGV
  __zom_mini_argv "$@"
  "$ZOM_BINARY" "${ZOM_ARGV[@]}"
}

# Shell-side notices. Some degradations produce no output at all (a hook that
# stopped running) or flash by at shell start (the size sentinel) — the user
# cannot perceive them in daily use. They are appended to notices.jsonl; the
# opencode companion drains that file into the context injection on the next
# summon, so the model surfaces them naturally. Delivery is at-most-once and
# loss-tolerant by design (DESIGN philosophy, same as the outbox): a lost
# notice costs one silent degradation period, a duplicated one costs nothing.
# Dedupe per shell per (kind, text): a hook that fails on every spawn must not
# append on every spawn.
typeset -gA __ZOM_NOTICED
__zom_notice() {  # <kind> <text>
  local key="$1"$'\n'"$2"
  (( ${+__ZOM_NOTICED[$key]} )) && return 0
  __ZOM_NOTICED[$key]=1
  [[ -d "$ZOM_DATA_DIR" ]] || return 0
  print -r -- "{\"ts\":$EPOCHSECONDS,\"kind\":\"$(__zom_json_escape "$1")\",\"text\":\"$(__zom_json_escape "$2")\"}" \
    >> "$ZOM_DATA_DIR/notices.jsonl" 2>/dev/null
}

# Unclaimed-key feedback. The fork logs keys nobody claimed to
# <passthrough-file>.keys.log; when the same stroke shows up repeatedly the
# user is pressing something mini ignores — say so once per shell per stroke
# and name the two fixes (bind it in mini, or allowlist it for shell replay).
typeset -gA __ZOM_HINTED
__zom_unclaimed_hint() {
  [[ "$ZOM_PASSTHROUGH" == on ]] || return 0
  local log="${ZOM_PASSTHROUGH_FILE}.keys.log"
  [[ -s "$log" ]] || return 0
  local n stroke
  while read -r n stroke; do
    if (( n >= 3 )) && (( ! ${+__ZOM_HINTED[$stroke]} )); then
      __ZOM_HINTED[$stroke]=1
      print -u2 -- "zsh-opencode-mini: '${(V)stroke}' unclaimed $n times — bind it in mini, or add it to shell.passthroughKeys to replay it to the shell"
    fi
  done < <(jq -r '.stroke // empty' "$log" 2>/dev/null | sort | uniq -c)
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
  __zom_unclaimed_hint
  zle reset-prompt
}

# Scriptable entry point (extra args are forwarded to mini)
zom() {
  __zom_launch_mini "$@"
}

# Quick ask: hand the most recent failed command straight to `opencode run`,
# no TUI. Same freshness rules as the composer prefill: a record older than
# companion.failureTtlSeconds, or one from a different directory, does not
# count as "the last failure" here either.
zom-last() {
  local f="$ZOM_DATA_DIR/last-failure.json"
  local last_failed epoch cwd sig_tty
  last_failed=$(jq -r '.cmd // empty' "$f" 2>/dev/null)
  if [[ -z "$last_failed" ]]; then
    print -u2 "zom-last: no failed command on record"
    return 1
  fi
  epoch=$(jq -r '.epoch // 0' "$f" 2>/dev/null)
  cwd=$(jq -r '.cwd // ""' "$f" 2>/dev/null)
  if ! __zom_is_uint "$epoch" || (( EPOCHSECONDS - epoch > ZOM_FAILURE_TTL )); then
    print -u2 "zom-last: failure record is stale (older than ${ZOM_FAILURE_TTL}s)"
    return 1
  fi
  if [[ "$cwd" != "$PWD" ]]; then
    print -u2 "zom-last: last failure was in $cwd, not here"
    return 1
  fi
  # Same ownership rule as the prefill: another terminal's failure is not
  # explainable from this one — send the user to the terminal that saw it.
  sig_tty=$(jq -r '.tty // ""' "$f" 2>/dev/null)
  if ! __zom_tty_owned "$sig_tty"; then
    print -u2 "zom-last: last failure was in another terminal"
    return 1
  fi
  print -- "zom-last: $last_failed"
  # `run` creates a fresh session whose id is only known to opencode itself.
  __zom_run_spawn_hooks last
  [[ "$ZOM_SHARED_DB" == on ]] && local -x OPENCODE_DISABLE_CHANNEL_DB=1
  "$ZOM_BINARY" run "Explain and fix this failed command (run in the current directory): $last_failed"
}

# ---- install ----
# Direct idempotent array append: the (I) probe keeps double-sourcing
# idempotent, and nothing here needs add-zsh-hook. Note the per-line phantom
# preexec of file-mode scripts is a zsh 5.9 property of ANY non-empty
# preexec_functions (registration method irrelevant) — __zom_preexec guards
# against it via its empty-$1 check.
(( ${preexec_functions[(I)__zom_preexec]} )) || preexec_functions+=(__zom_preexec)
(( ${precmd_functions[(I)__zom_precmd]} )) || precmd_functions+=(__zom_precmd)

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
  # Once the summon key reads back as ours, surface the sequence-prefix
  # conflict once per shell (see shell.keybindConflict above). `bindkey -M
  # main -L` prints the main keymap's bindings as bindkey commands (note:
  # `-lL` only lists keymap creation lines, not the bindings inside); a
  # binding strictly extending the summon key is a sequence zsh must
  # disambiguate against on every press.
  if (( ! $+ZOM_CONFLICT_DONE )); then typeset -g ZOM_CONFLICT_DONE=0; fi
  __zom_keybind_conflict() {
    (( ZOM_CONFLICT_DONE )) && return 0
    ZOM_CONFLICT_DONE=1
    [[ "$ZOM_KEYBIND_CONFLICT" == off ]] && return 0
    local line key name kt
    local -a hits
    while IFS= read -r line; do
      [[ "$line" == 'bindkey "'* ]] || continue
      key=${line#*\"}; key=${key%%\"*}
      name=${line##*\" }; name=${name%\"}
      if [[ "$key" != "$ZOM_KEYBIND" && "$key" == "$ZOM_KEYBIND"* ]]; then
        hits+=("\"$key\" ${name:-<undefined>}")
      fi
    done <<< "$(bindkey -M main -L 2>/dev/null || bindkey -L)"
    local n=${#hits}
    (( n )) || return 0
    local samples="${(j:, :)hits[1,3]}"
    (( n > 3 )) && samples="$samples …(+$(( n - 3 )) more)"
    # Report only. Removing the sequences is a keymap change; that belongs in
    # the user's own rc (bindkey -rp), not in a plugin they load indirectly.
    print -u2 -- "zsh-opencode-mini: \"$ZOM_KEYBIND\" also prefixes $n keymap sequence(s) — $samples."
    kt=${KEYTIMEOUT:-40}   # centiseconds, zsh default 40
    kt="$(printf '%d.%02ds' $(( kt / 100 )) $(( kt % 100 )))"
    print -u2 -- "zsh-opencode-mini: a bare \"$ZOM_KEYBIND\" press waits KEYTIMEOUT ($kt) before zsh dispatches it — the summon is that much slower."
    print -u2 -- "zsh-opencode-mini: to drop them, add 'bindkey -rp \"$ZOM_KEYBIND\"' to your zshrc after this plugin loads; or lower KEYTIMEOUT to shrink the wait."
    return 0
  }
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
    # The prefix-conflict report runs only from __zom_ensure_bind (first
    # prompt): KEYTIMEOUT and the keymap are final there, while at source
    # time the user rc has usually not set KEYTIMEOUT yet and the reported
    # cost would be wrong.
  fi

  # Lazy bind: first prompt = post-zshrc, deferred plugins done, final keymap.
  # Self-detaches once the bind reads back as ours (or as user-occupied), so
  # the steady-state prompt pays zero extra work (this check forks once —
  # acceptable for a bounded number of prompts, not forever).
  __zom_ensure_bind() {
    local current
    if (( ZOM_BIND_DONE == 2 )); then
      precmd_functions=(${precmd_functions:#__zom_ensure_bind})
      return 0
    fi
    current=$(bindkey "$ZOM_KEYBIND" 2>/dev/null)
    if [[ "$current" == *'__zom_mini_widget'* ]]; then
      precmd_functions=(${precmd_functions:#__zom_ensure_bind})
      __zom_keybind_conflict
      return 0
    fi
    __zom_bind "$ZOM_KEYBIND"
    current=$(bindkey "$ZOM_KEYBIND" 2>/dev/null)
    if [[ "$current" == *'__zom_mini_widget'* ]]; then
      precmd_functions=(${precmd_functions:#__zom_ensure_bind})
      __zom_keybind_conflict
    fi
    return 0
  }
  (( ${precmd_functions[(I)__zom_ensure_bind]} )) || precmd_functions+=(__zom_ensure_bind)
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
  print -r -- "zsh-opencode-mini — configuration report (the plugin never writes config)"
  case "$ZOM_CFG_STATUS" in
    ok)         print -r -- "config: $ZOM_CONFIG" ;;
    absent)     print -r -- "config: $ZOM_CONFIG (absent — built-in defaults below)" ;;
    unparsable) print -r -- "config: $ZOM_CONFIG (UNPARSABLE — built-in defaults below)" ;;
  esac
  print -r -- "shell (read once when the plugin loads; open a new shell to apply edits):"
  __zom_cfg_line binary         "$ZOM_BINARY"
  __zom_cfg_line keybind        "$ZOM_KEYBIND"
  __zom_cfg_line keybindConflict "$ZOM_KEYBIND_CONFLICT"
  __zom_cfg_line dataDir        "$ZOM_DATA_DIR"
  __zom_cfg_line resume         "$ZOM_RESUME"
  __zom_cfg_line replay         "$ZOM_REPLAY"
  __zom_cfg_line replayLimit    "$ZOM_REPLAY_LIMIT"
  __zom_cfg_line passthrough    "$ZOM_PASSTHROUGH"
  __zom_cfg_line passthroughKeys "$ZOM_PASSTHROUGH_KEYS"
  __zom_cfg_line historyRetainMonths "${ZOM_HISTORY_RETAIN:-off}"
  __zom_cfg_line osc            "$ZOM_OSC"
  __zom_cfg_line stderrCapture  "$ZOM_STDERR_CAPTURE"
  __zom_cfg_line failurePrefill "$ZOM_FAILURE_PREFILL_TMPL"
  __zom_cfg_line model          "${ZOM_CFG[model]}"
  __zom_cfg_line agent          "${ZOM_CFG[agent]:-${ZOM_DEFAULTS[agent]}}"
  __zom_cfg_line sharedDatabase "${ZOM_CFG[sharedDatabase]:-${ZOM_DEFAULTS[sharedDatabase]}}"
  __zom_cfg_line leader         "${ZOM_CFG[leader]:-${ZOM_DEFAULTS[leader]}}"
  print -r -- "companion (read by the opencode-side plugin, per session):"
  __zom_cfg_line failureTtlSeconds "$ZOM_FAILURE_TTL"
  __zom_cfg_line recentDefaultN    "${ZOM_CFG[recentDefaultN]:-${ZOM_DEFAULTS[recentDefaultN]}}"
  print -r -- "recipes (top-level \"recipes\"; the name becomes the tool name and the [zom:<name>] tag):"
  local names name rjson origin
  names=$( __zom_config_json | jq -r '.recipes // {} | keys[]' 2>/dev/null )
  if [[ -z "$names" ]]; then
    print -r -- "  (none defined)"
  else
    for name in ${(f)names}; do
      origin="ok"
      [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || origin="INVALID — name must match ^[A-Za-z0-9_-]+$"
      rjson=$( __zom_config_json | jq -c --arg n "$name" '.recipes[$n] | {on: (.on // "?"), model: (.model // "?")}' 2>/dev/null )
      printf '  %-18s %s  %s\n' "$name" "$origin" "$rjson"
    done
  fi
  print -r -- "opencode-side parts:"
  local part resolved fm
  for part in "$HOME/.config/opencode/plugins/zom-companion.js"; do
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

# ---- pathological-growth sentinel, once per shell ----
# A runaway loop can flood the monthly file faster than retention can age it
# out; past a fixed ceiling the file is almost certainly garbage, so surface
# it instead of letting the store grow silently. Warn-only: deleting live
# data on a heuristic would be worse. Two surfaces: stderr now (the user may
# be watching), notices.jsonl for the companion to inject on the next summon
# (the user may not have been).
# knockout: fixed 10 MB ceiling, make it configurable if a real workload ever
# legitimately exceeds it
if [[ -d "$ZOM_DATA_DIR" ]]; then
  for _ZOM_F in "$ZOM_DATA_DIR"/history-*.jsonl(N); do
    if (( $(wc -c < "$_ZOM_F" 2>/dev/null || echo 0) > 10485760 )); then
      print -u2 -- "zsh-opencode-mini: ${_ZOM_F:t} is over 10 MB — likely a runaway producer; inspect and trim it"
      __zom_notice history-oversized "${_ZOM_F:t} is over 10 MB — likely a runaway producer writing shell history; inspect and trim it"
    fi
  done
  unset _ZOM_F
fi

# ---- opencode-side parts ----
# The zsh half is this file; the AI half (companion plugin, agent definition,
# extensions) is installed from here, because plugin managers only source this
# file. Real copies, refreshed when they differ, never symlinks: opencode's
# config must not couple to a checkout that can be mid-edit or removed.
__zom_install_opencode_parts() {
  local cfg_base="${XDG_CONFIG_HOME:-$HOME/.config}"
  local src_dir="${${(%):-%x}:A:h}"
  local -a parts=(
    "companion.js:$cfg_base/opencode/plugins/zom-companion.js"
  )
  # Extensions live next to config.toml — the same seam ZOM_CONFIG splits,
  # and the same directory companion.js scans on the way out.
  local cfg_dir="${${ZOM_CONFIG:-$cfg_base/zsh-opencode-mini/config.toml}:h}"
  local ext_dst="$cfg_dir/extensions"
  # The agent prompt is the user's file; the repo only supplies the seed.
  [[ -d "$cfg_dir" ]] || mkdir -p "$cfg_dir" 2>/dev/null
  [[ -f "$cfg_dir/agent.md" ]] ||
    cp -f "$src_dir/agent.example.md" "$cfg_dir/agent.md" 2>/dev/null || true
  local part src dst f
  for f in "$src_dir"/extensions/*.js(N); do
    parts+=("extensions/${f:t}:$ext_dst/${f:t}")
  done
  for f in "$ext_dst"/*.js(N); do
    [[ -f "$src_dir/extensions/${f:t}" ]] || rm -f "$f"
  done
  for part in $parts; do
    src="$src_dir/${part%%:*}"
    dst="${part#*:}"
    [[ -f "$src" ]] || continue
    [[ -L "$dst" ]] && rm -f "$dst"
    [[ -f "$dst" ]] && cmp -s "$src" "$dst" && continue
    mkdir -p "${dst:h}" 2>/dev/null || continue
    cp -f "$src" "$dst" 2>/dev/null
  done
}
__zom_install_opencode_parts
