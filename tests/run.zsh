#!/usr/bin/env zsh
#!/usr/bin/env zsh
# Integration + unit test suite for zsh-opencode-mini.
#
# Run:    ./tests/run.zsh
# Result: one PASS/FAIL line per assertion, non-zero exit on any failure.
#
# Sandbox model: every scenario runs the plugin in a pristine `zsh -f` with
# HOME / XDG_CONFIG_HOME / XDG_DATA_HOME pointed at a fresh temp dir, so the
# plugin's config discovery (config.jsonc) and data store land inside the
# sandbox — exactly the paths a real user's setup would use.
#
# Scenario inventory (what is covered, and what is deliberately not):
#
#   Hook logic (pure zsh, no TTY needed — hook functions are called in the
#   real preexec→cmd→precmd order by hand):
#     S1  recording: history JSONL gets one line per command, fields correct
#     S2  JSON escaping: quotes, backslash, tab, newline in command text
#     S3  failure signal: non-zero exit refreshes last-failure.json (atomic
#         final state), zero exit leaves it untouched
#     S4  datetime module: plugin self-loads zsh/datetime under `zsh -f`
#         (regression: empty EPOCHREALTIME once disabled recording entirely)
#     S5  OSC frame: stdout carries ESC]7777;zom;v1;<base64> and the decoded
#         payload round-trips to the same JSON
#   Launcher (mock opencode-zom in tests/bin):
#     S6  zom: mock receives `mini -c --agent zsh-companion`
#     S7  zom-last: prompt contains the recorded failing command
#   Configuration (config.jsonc, the single config file):
#     S8  keybind: default ^X bound; keybind:"" in config suppresses it
#     S9  dataDir: config-provided dataDir is honored (incl. ~ expansion)
#   opencode-side plugin (companion.js, driven via node if available):
#     S10 contract: setup() registers the tool + context hook on a mock V2
#         ctx; a mock V3 ctx (breaking change) fails loudly
#   Robustness / mechanics (audit follow-ups):
#     S12 err_return+nounset survival: sourcing inside a function keeps the
#         shell alive
#     S13 broken config: one loud warning, defaults take effect
#     S14 concurrent recording: two shells, 200 commands each, no torn lines
#     S15 zom-last with no failure on record: hint + exit 1 + nothing sent
#     S16 outbox byte-cursor drain: deliver, advance, no repeat, partial
#         tail line waits for completion
#     S17 zom-bg: sid, ledger, background run -s (never --standalone),
#         empty-prompt rejection
#
#   NOT automated (declared boundary): the real keystroke→ZLE→widget→zle -I
#   chain requires a live interactive shell; zsh's hook invocation semantics
#   are upstream guarantees, not this repo's logic. Manual acceptance after
#   install: press C-x, see mini open and the prompt repaint after exit.

emulate -L zsh
setopt err_return no_unset

ROOT=${${0:a}:h:h}
PLUGIN="$ROOT/zsh-opencode-mini.plugin.zsh"
MOCKBIN="$ROOT/tests/bin"
PASS=0
FAIL=0
TD=

# --- tiny assert helpers ---------------------------------------------------
# NOTE: PASS=$((PASS+1)) instead of ((PASS++)) — the postfix form evaluates to
# 0 on the first hit, which trips err_return and silently aborts scenarios.
ok()   { print -r -- "  PASS  $1"; PASS=$(( PASS + 1 )) }
bad()  { print -r -- "  FAIL  $1: $2"; FAIL=$(( FAIL + 1 )) }
assert_eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1" "expected [$3], got [$2]" }
assert_contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1" "[$2] lacks [$3]" }
assert_not_contains() { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1" "[$2] unexpectedly contains [$3]" }
assert_file_exists() { [[ -f "$1" ]] && ok "$2" || bad "$2" "missing file $1" }
assert_file_missing() { [[ ! -f "$1" ]] && ok "$2" || bad "$2" "file unexpectedly exists: $1" }

# fresh sandbox per scenario: HOME + XDG dirs inside a temp tree
sandbox() {
  TD=$(mktemp -d)
  export HOME="$TD/home"
  export XDG_CONFIG_HOME="$TD/home/.config"
  export XDG_DATA_HOME="$TD/home/.local/share"
  DD="$XDG_DATA_HOME/zsh-opencode-mini"      # default dataDir the plugin will pick
  export ZOM_MOCK_LOG="$TD/mock.log"
  : > "$ZOM_MOCK_LOG"
}
cleanup() { [[ -n "$TD" ]] && mv "$TD" /tmp/zom-suite-scratch-$$ 2>/dev/null; TD= }

# write a config.jsonc into the sandbox
write_config() { mkdir -p "$XDG_CONFIG_HOME/zsh-opencode-mini"; cat > "$XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc"; }

# source the plugin in a pristine zsh, run a body, capture stdout.
# NOTE: runs with the mock opencode first on PATH.
run_zsh() { PATH="$MOCKBIN:$PATH" zsh -f -c "source '$PLUGIN'; $1" }

# drive one recorded command through the real hook pair, in order
run_command() { run_zsh "__zom_preexec '$1'; $2; __zom_precmd" }

# --- scenarios -------------------------------------------------------------

t_S1_recording() {
  sandbox
  run_command 'echo hello' 'true'
  run_command 'ls -la'     'true'
  local n
  n=$(cat "$DD"/history-*.jsonl | wc -l | tr -d ' ')
  assert_eq "S1 two lines recorded" "$n" "2"
  local line1
  line1=$(head -n1 "$DD"/history-*.jsonl)
  assert_contains "S1 cmd field"  "$line1" '"cmd":"echo hello"'
  assert_contains "S1 exit field" "$line1" '"exit":0'
  assert_contains "S1 cwd field"  "$line1" "\"cwd\":\"$PWD\""
  jq -e '.ms >= 0 and (.ts | length > 0)' "$DD"/history-*.jsonl >/dev/null \
    && ok "S1 valid JSONL (ts, ms)" || bad "S1 valid JSONL" "jq rejected"
  cleanup
}

t_S2_escaping() {
  sandbox
  local tricky='printf "quote:\" backslash:\\ tab:\t done"'
  run_command "$tricky" 'true'
  local decoded
  decoded=$(run_zsh "jq -r '.cmd' \$(ls '$DD'/history-*.jsonl)")
  assert_eq "S2 round-trip through JSON" "$decoded" "$tricky"
  cleanup
}

t_S3_failure_signal() {
  sandbox
  run_command 'false-cmd' 'false'
  local f="$DD/last-failure.json"
  assert_file_exists "$f" "S3 failure file written"
  local cmd exit
  cmd=$(jq -r '.cmd' "$f"); exit=$(jq -r '.exit' "$f")
  assert_eq "S3 recorded failing cmd" "$cmd" "false-cmd"
  assert_eq "S3 recorded exit"        "$exit" "1"
  # New semantics (cwd-scoped global-latest): a succeeding command flushes
  # the failure signal, and signal exits (141 SIGPIPE / 130 SIGINT) are not
  # recorded as failures at all.
  run_command 'true-cmd' 'true'
  assert_file_missing "$f" "S3 zero-exit flushes signal"
  run_command 'sigpipe-cmd' '(exit 141)'
  assert_file_missing "$f" "S3 exit 141 not recorded"
  run_command 'sigint-cmd'  '(exit 130)'
  assert_file_missing "$f" "S3 exit 130 not recorded"
  run_command 'false-cmd' 'false'
  assert_file_exists "$f" "S3 real failure still recorded"
  assert_eq "S3 no .tmp leftover" "$(ls "$DD" | grep -c tmp || true)" "0"
  cleanup
}

t_S4_datetime_selfload() {
  # plugin must work under a bare zsh -f (no zshrc to have loaded datetime)
  sandbox
  run_zsh "__zom_preexec 'probe-datetime'; true; __zom_precmd" >/dev/null 2>&1 || true
  assert_file_exists "$DD/history-"*.jsonl "S4 recording works under zsh -f"
  local ms
  ms=$(jq -r '.ms' "$DD"/history-*.jsonl 2>/dev/null)
  [[ "$ms" =~ ^[0-9]+$ ]] && ok "S4 ms is numeric (EPOCHREALTIME live)" || bad "S4 ms numeric" "got [$ms]"
  cleanup
}

t_S5_osc_frame() {
  sandbox
  local out
  out=$(run_command 'osc-probe' 'true')
  assert_contains "S5 frame present" "$out" $'\e]7777;zom;v1;'
  local b64 json_from_frame
  b64=${out#*;zom;v1;}       # strip everything up to and incl. the header
  b64=${b64%%$'\a'*}         # strip the BEL terminator and beyond
  json_from_frame=$(print -r -- "$b64" | base64 --decode 2>/dev/null)
  local json_on_disk
  json_on_disk=$(head -n1 "$DD"/history-*.jsonl)
  assert_eq "S5 payload round-trips" "$json_from_frame" "$json_on_disk"
  cleanup
}

t_S6_zom_launch() {
  sandbox
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  local log
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 default resume=main pins session" "$log" "argv=mini -s ses_zom-main --replay-limit 50 --agent zsh-companion extra-arg"
  cleanup
  sandbox
  write_config <<'EOF'
{ "shell": { "resume": "off" } }
EOF
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 resume=off starts fresh" "$log" "argv=mini --agent zsh-companion extra-arg"
  cleanup
  sandbox
  write_config <<'EOF'
{ "shell": { "resume": "main", "replay": "off" } }
EOF
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 replay=off passes --no-replay" "$log" "argv=mini -s ses_zom-main --no-replay --agent zsh-companion extra-arg"
  cleanup
  sandbox
  write_config <<'EOF'
{ "shell": { "resume": "main", "replayLimit": 7 } }
EOF
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 replayLimit honoured" "$log" "argv=mini -s ses_zom-main --replay-limit 7 --agent zsh-companion extra-arg"
  cleanup
  sandbox
  run_command 'git push --force' 'false'   # record a fresh failure
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 fresh failure prefills composer" "$log" "--prefill"
  assert_contains "S6 prefill carries the failed command" "$log" "git push --force"
  cleanup
  sandbox
  run_command 'git push --force' 'false'   # failure recorded in sandbox cwd
  # Same failure signal observed from another directory: no prefill there.
  run_zsh 'cd /; zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_not_contains "S6 failure in other cwd does not prefill" "$log" "--prefill"
  cleanup
  sandbox
  run_command 'git push --force' 'false'
  printf '{"ts":"2020-01-01T00:00:00+0000","epoch":1,"cwd":"/tmp","exit":1,"cmd":"git push --force"}\n' \
    > "$DD/last-failure.json"   # stale beyond any TTL (epoch inside the payload)
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_not_contains "S6 stale failure does not prefill" "$log" "--prefill"
  cleanup
  sandbox
  run_command 'git push --force' 'false'
  write_config <<'EOF'
{ "shell": { "failurePrefill": "cwd={cwd} exit={exit} cmd={cmd}" } }
EOF
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 custom failurePrefill template honoured" "$log" "cwd=$(pwd) exit=1 cmd=git push --force"
  cleanup
  sandbox
  run_command 'git push --force' 'false'
  write_config <<'EOF'
{ "shell": { "failurePrefill": "off" } }
EOF
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_not_contains "S6 failurePrefill off disables prefill" "$log" "--prefill"
  cleanup
  sandbox
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 passthrough file env exported by default" "$log" "passthrough=$DD/passthrough."
  cleanup
  sandbox
  write_config <<<'{ "shell": { "passthrough": "off" } }'
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 passthrough=off leaves env unset" "$log" "passthrough=<unset>"
  cleanup
  sandbox
  write_config <<<'{ "shell": { "model": "test-provider/test-model#fast" } }'
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_contains "S6 model pin reaches mini via -m" "$log" "-m test-provider/test-model#fast"
  cleanup
}

t_S7_zom_last() {
  sandbox
  run_command 'git push --force' 'false'
  local out
  out=$(run_zsh 'zom-last' 2>/dev/null)
  assert_contains "S7 prompt carries failed cmd" "$out" "git push --force"
  assert_contains "S7 went through opencode run" "$(cat "$ZOM_MOCK_LOG")" "argv=run"
  cleanup
}

t_S8_keybind() {
  sandbox
  # default: ^X bound to the widget. Probe the keymap via bindkey's text
  # output — $widgets is keyed by widget NAME (values are implementations),
  # it cannot answer "what is bound to ^X".
  local w
  w=$(run_zsh "bindkey '^X'" 2>/dev/null)
  assert_contains "S8 default ^X bound" "$w" "__zom_mini_widget"
  # config keybind:"off" suppresses the binding and the widget registration
  write_config <<<'{ "shell": { "keybind": "off" } }'
  w=$(run_zsh "print -r -- \${widgets[__zom_mini_widget]:-<none>}" 2>/dev/null)
  assert_eq "S8 config keybind off suppresses" "$w" "<none>"
  cleanup
}

t_S9_config_dataDir() {
  sandbox
  write_config <<<'{ "shell": { "dataDir": "'"$TD"'/custom-store" } }'
  run_command 'stored-elsewhere' 'true'
  assert_file_exists "$TD/custom-store/history-"*.jsonl "S9 config dataDir honored"
  cleanup

  sandbox
  write_config <<<'{ "shell": { "dataDir": "~/tilde-store" } }'
  run_command 'tilde-cmd' 'true'
  assert_file_exists "$HOME/tilde-store/history-"*.jsonl "S9 tilde expansion in dataDir"
  cleanup
}

t_S10_companion_contract() {
  sandbox
  if ! command -v node >/dev/null 2>&1; then
    print -r -- "  SKIP  S10 (node not available; companion.js left to manual verification)"
    return 0
  fi
  local out
  out=$(node "$ROOT/tests/companion.test.mjs" 2>&1) || true
  assert_contains "S10 companion: V2 ctx loads"    "$out" "PASS v2 loads"
  assert_contains "S10 companion: tool registered" "$out" "PASS tool registered"
  assert_contains "S10 companion: fresh failure injected" "$out" "PASS fresh failure injected"
  assert_contains "S10 companion: stale failure silent"   "$out" "PASS stale failure silent"
  assert_contains "S10 companion: V3 refused loudly"      "$out" "PASS v3 refused loudly"
  cleanup
}

t_S11_keybind_conflict() {
  sandbox
  # user already owns ^X: plugin must warn and keep the existing binding,
  # register no widget, and not break an err_return environment (exit 0)
  local out
  out=$(PATH="$MOCKBIN:$PATH" zsh -f -c \
    "setopt err_return; bindkey '^X' my-own-widget; source '$PLUGIN' 2>&1; \
     bindkey '^X'; print -r -- \${widgets[__zom_mini_widget]:-<none>}" 2>/dev/null)
  assert_contains "S11 conflict warned"   "$out" "already bound to 'my-own-widget'"
  assert_contains "S11 existing kept"     "$out" '"^X" my-own-widget'
  assert_contains "S11 our widget absent" "$out" "<none>"
  cleanup
}

t_S12_err_return_survival() {
  # the plugin is sourced into user shells that may run with err_return:
  # sourcing inside a function (the classic tripwire) must survive and
  # execution must continue afterwards
  sandbox
  local out rc
  out=$(PATH="$MOCKBIN:$PATH" zsh -f -c \
    "setopt err_return nounset; f(){ source '$PLUGIN' 2>/dev/null; }; f; print -r -- alive" 2>&1)
  rc=$?
  assert_contains "S12 survives function source under err_return" "$out" "alive"
  assert_eq "S12 source exits clean" "$rc" "0"
  cleanup
}

t_S13_broken_config() {
  # a syntax-broken config.jsonc must produce one loud warning and fall back
  # to defaults (keybind ^X bound, default dataDir), not silently mis-parse
  sandbox
  mkdir -p "$XDG_CONFIG_HOME/zsh-opencode-mini"
  print '{ broken jsonc !!!' > "$XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc"
  local out
  out=$(PATH="$MOCKBIN:$PATH" zsh -f -c "source '$PLUGIN' 2>&1; bindkey '^X'" 2>&1)
  assert_contains "S13 unparsable warning" "$out" "config unparsable, using defaults"
  assert_contains "S13 default keybind still bound" "$out" "__zom_mini_widget"
  cleanup
}

t_S14_concurrent_append() {
  # two shells recording concurrently into the same monthly history file:
  # every line must survive intact (append of a line is atomic at these sizes)
  sandbox
  local writer='for i in {1..200}; do __zom_preexec "w-TAG-\$i"; true; __zom_precmd; done'
  PATH="$MOCKBIN:$PATH" zsh -f -c "source '$PLUGIN'; ${writer/TAG/a}" >/dev/null 2>&1 &
  local p1=$!
  PATH="$MOCKBIN:$PATH" zsh -f -c "source '$PLUGIN'; ${writer/TAG/b}" >/dev/null 2>&1 &
  local p2=$!
  wait $p1 $p2
  local n bad_lines
  n=$(cat "$DD"/history-*.jsonl | wc -l | tr -d ' ')
  assert_eq "S14 400 interleaved lines all present" "$n" "400"
  bad_lines=$(jq -e '.cmd and .ts and (.exit == 0)' "$DD"/history-*.jsonl 2>/dev/null | grep -c true)
  assert_eq "S14 every line is intact JSON" "$bad_lines" "400"
  cleanup
}

t_S15_zom_last_empty() {
  # no failure on record: stderr hint, non-zero exit, nothing sent to opencode
  sandbox
  local out rc
  out=$(run_zsh 'zom-last' 2>&1) && rc=0 || rc=$?
  assert_contains "S15 stderr hint" "$out" "no failed command on record"
  assert_eq "S15 returns 1" "$rc" "1"
  assert_eq "S15 nothing sent to opencode" "$(cat "$ZOM_MOCK_LOG")" ""
  cleanup
}

t_S16_outbox_cursor() {
  # outbox drain: full lines deliver as pre-prompt hints, the cursor advances
  # past consumed bytes, a partial trailing line waits, a second drain with
  # nothing new prints nothing
  sandbox
  mkdir -p "$DD"   # the fixture writes before any plugin source creates the dir
  print -r -- '{"id":"a","kind":"recipe","text":"first suggestion"}' > "$DD/outbox.jsonl"
  print -r -- '{"id":"b","kind":"bg-done","sid":"ses_zom-bg-x","ok":true,"text":"background session finished"}' >> "$DD/outbox.jsonl"
  print -rn -- '{"id":"c","kind":"recipe","te' >> "$DD/outbox.jsonl"
  local out
  out=$(run_zsh '__zom_outbox_drain' 2>&1)
  assert_contains "S16 first record delivered"  "$out" "zom: first suggestion"
  assert_contains "S16 bg-done text delivered"  "$out" "zom: background session finished"
  # cursor sits at the end of the last complete line, strictly before EOF:
  # the partial tail line stays unconsumed for the next drain
  local expect after_partial size
  expect=$(head -n2 "$DD/outbox.jsonl" | wc -c | tr -d ' ')
  after_partial=$(cat "$DD/outbox.cursor")
  size=$(run_zsh "zstat +size '$DD/outbox.jsonl'")
  assert_eq "S16 cursor at last complete line" "$after_partial" "$expect"
  assert_file_exists "$DD/outbox.cursor" "S16 cursor file written"
  [[ "$after_partial" -lt "$size" ]] \
    && ok "S16 partial line withheld" || bad "S16 partial line withheld" "cursor=$after_partial size=$size"
  out=$(run_zsh '__zom_outbox_drain' 2>&1)
  assert_eq "S16 no repeat on second drain" "$out" ""
  # complete the tail line: it delivers on the next drain, exactly once
  print -r -- 'xt":"third suggestion"}' >> "$DD/outbox.jsonl"
  out=$(run_zsh '__zom_outbox_drain' 2>&1)
  assert_contains "S16 completed tail delivers" "$out" "zom: third suggestion"
  assert_eq "S16 completed tail delivers once" "$(print -r -- "$out" | grep -c 'third suggestion')" "1"
  cleanup
}

t_S16_outbox_malformed() {
  # a malformed complete line must cost only itself: valid lines before and
  # after it still deliver, one warning names the skipped count, cursor runs
  # to EOF (all lines were complete)
  sandbox
  mkdir -p "$DD"
  print -r -- '{"id":"a","kind":"recipe","text":"before garbage"}' > "$DD/outbox.jsonl"
  print -r -- 'notjson-at-all' >> "$DD/outbox.jsonl"
  print -r -- '{"id":"c","kind":"recipe","text":"after garbage"}' >> "$DD/outbox.jsonl"
  local out
  out=$(run_zsh '__zom_outbox_drain' 2>&1)
  assert_contains "S16b pre-malformed line survives"  "$out" "zom: before garbage"
  assert_contains "S16b post-malformed line survives" "$out" "zom: after garbage"
  assert_contains "S16b one warning with count"       "$out" "1 unparsable outbox line"
  local cursor size
  cursor=$(cat "$DD/outbox.cursor")
  size=$(run_zsh "zstat +size '$DD/outbox.jsonl'")
  assert_eq "S16b cursor at EOF (all lines complete)" "$cursor" "$size"
  cleanup
}

t_S17_zom_bg() {
  # zom-bg spawns `opencode run -s <sid>` in the background (never
  # --standalone: the session must stay reachable by mini), writes the
  # spawn ledger, prints the sid, and rejects an empty prompt
  sandbox
  local out
  out=$(run_zsh 'zom-bg "fix the flaky test"' 2>&1)
  assert_contains "S17 sid printed" "$out" "ses_zom-bg-"
  assert_contains "S17 attach hint" "$out" "opencode mini -s ses_zom-bg-"
  local sid
  sid=$(print -r -- "$out" | grep -o 'ses_zom-bg-[0-9]*-[0-9]*' | head -n1)
  local ledger
  ledger=$(cat "$DD/bg.jsonl")
  assert_contains "S17 ledger records sid" "$ledger" "\"sid\":\"$sid\""
  assert_contains "S17 ledger has pid+started" "$ledger" '"pid":'
  assert_contains "S17 ledger has started" "$ledger" '"started":'
  # the run is backgrounded; wait for the mock binary to log its argv. The
  # budget must absorb a loaded machine (fork+exec of a fresh zsh can take
  # seconds under heavy load), not a fresh one — 20s, still bounded.
  local tries=0
  while (( tries < 200 )) && ! grep -q "argv=run" "$ZOM_MOCK_LOG" 2>/dev/null; do
    sleep 0.1
    tries=$(( tries + 1 ))
  done
  assert_contains "S17 run invoked with -s and prompt" "$(cat "$ZOM_MOCK_LOG")" \
    "argv=run -s $sid fix the flaky test"
  assert_eq "S17 no --standalone" "$(grep -c -- --standalone "$ZOM_MOCK_LOG" || true)" "0"
  local rc
  out=$(run_zsh 'zom-bg' 2>&1) && rc=0 || rc=$?
  assert_contains "S17 empty prompt rejected" "$out" "usage: zom-bg"
  assert_eq "S17 empty prompt returns 1" "$rc" "1"
  cleanup
}

# --- runner ----------------------------------------------------------------
print -r -- "zsh-opencode-mini test suite"
print -r -- "plugin: $PLUGIN"
t_S18_zom_config() {
  # read-only report: defaults marked as defaults, config values marked as
  # config, recipes listed by name, opencode parts resolved
  sandbox
  local out
  out=$(run_zsh 'zom-config' 2>&1)
  assert_contains "S18 absent config flagged"   "$out" "(absent"
  assert_contains "S18 binary default"          "$out" "binary             opencode-zom  (default)"
  assert_contains "S18 resume default"          "$out" "resume             main  (default)"
  assert_contains "S18 replayLimit default"     "$out" "replayLimit        50  (default)"
  assert_contains "S18 no recipes"              "$out" "(none defined)"
  assert_contains "S18 agent part listed"       "$out" "zsh-companion.md"
  assert_contains "S18 companion key present"   "$out" "failureTtlSeconds  600  (default)"
  assert_contains "S18 model unpinned shown"     "$out" "(not pinned — agent default)"
  sandbox
  write_config <<'CFG'
{
  "shell": { "replayLimit": 7, "keybind": "off" },
  "companion": { "recentDefaultN": 9 },
  "recipes": {
    "watch-tests": { "on": "failure", "model": "zhipuai-coding-plan/glm-5.3-flash" },
    "bad name!":   { "on": "failure", "model": "zhipuai-coding-plan/glm-5.3-flash" }
  }
}
CFG
  out=$(run_zsh 'zom-config' 2>&1)
  assert_contains "S18 config value marked"     "$out" "replayLimit        7  (config)"
  assert_contains "S18 keybind disabled shown"  "$out" "keybind            off (disabled)"
  assert_contains "S18 companion config value"  "$out" "recentDefaultN     9  (config)"
  assert_contains "S18 recipe listed ok"        "$out" "watch-tests"
  assert_contains "S18 recipe name validated"   "$out" "INVALID"
  # every recipe name that reaches the user is screened by the same regex the
  # opencode side enforces — a bad name is visible here, not silent
  local badline
  badline=$(print -r -- "$out" | grep 'bad name')
  assert_contains "S18 bad recipe flagged same line" "$badline" "INVALID"
}

t_S19_agent_md_frontmatter() {
  # the installed agent md is a behavior contract; its frontmatter may carry
  # only identity keys. Anything else (a model pin, a hidden toggle for other
  # agents) must fail the suite, so it cannot creep in invisibly.
  local md="$ROOT/agent/zsh-companion.md"
  assert_file_exists "$md" "S19 agent md present in repo"
  local keys k
  keys=$(awk 'NR==1 && /^---[[:space:]]*$/ {f=1; next} f && /^---[[:space:]]*$/ {exit} f && /^[A-Za-z][A-Za-z0-9]*:/ {print substr($0,1,index($0,":")-1)}' "$md")
  assert_contains "S19 frontmatter parsed" "$keys" "description"
  for k in ${(f)keys}; do
    case "$k" in
      description|mode|hidden) ok "S19 frontmatter key allowed: $k" ;;
      *) bad "S19 frontmatter key allowed: $k" "unexpected key — move behavior into the body or config.jsonc" ;;
    esac
  done
}

t_S20_widget_always_cold_start() {
  # Hiding mini is a clean exit in the zom fork (no suspend, no stopped
  # job), so C-x at the shell always cold-starts and replays the session
  # from the server. The widget must contain no job-table machinery at all:
  # widget-launched jobs carry no command text (zsh records nothing for
  # commands exec'd inside ZLE widgets, so %?str never matches), zsh job
  # tables are invisible inside $(…) subshells, and a stopped mini holds
  # its pane hostage (terminal kill confirmation). Structural check — the
  # real keystroke→ZLE→launch loop is declared NOT automated (see header
  # boundary).
  local widget
  widget=$(awk '/^__zom_mini_widget\(\)/{f=1} f{print} f && /^}/{exit}' "$PLUGIN")
  assert_contains "S20 widget launches mini" "$widget" '__zom_launch_mini || true'
  if [[ "$widget" == *'fg '* || "$widget" == *'jobs '* || "$widget" == *'%?'* ]]; then
    bad "S20 widget free of job machinery" "found fg/jobs/%? — hiding is a clean exit, nothing to resume"
  else
    ok "S20 widget free of job machinery"
  fi
  if grep -q '__zom_stopped_mini_job' "$PLUGIN"; then
    bad "S20 stopped-job helper deleted" "__zom_stopped_mini_job still present"
  else
    ok "S20 stopped-job helper deleted"
  fi
}

t_S21_resource_idempotent() {
  # re-sourcing the plugin (sheldon cache rebuild, user dotfile reload) must
  # not abort halfway: typeset -gr on an existing readonly throws under
  # err_return and leaves the widget undefined (real regression observed).
  sandbox
  local out
  out=$(run_zsh "source '$PLUGIN' && source '$PLUGIN' && print -r -- \${widgets[__zom_mini_widget]:-<none>}; echo RS=\$?" 2>/dev/null)
  assert_contains "S21 double source keeps widget" "$out" "__zom_mini_widget"
  assert_contains "S21 double source exit 0" "$out" "RS=0"
}

t_S22_argv_probe() {
  # the mini argv is a contract with the zom fork build; the probe asks
  # `mini --help` for every flag the plugin passes. A binary missing flags
  # is refused loudly (stderr names the flags), nothing is exec'd, exit 1.
  # Success caches for the shell's lifetime; failure retries on next launch.
  sandbox
  local out rc
  out=$(PATH="$MOCKBIN:$PATH" ZOM_MOCK_HELP_MISSING="--prefill" zsh -f -c "source '$PLUGIN'; zom" 2>&1) && rc=0 || rc=$?
  assert_contains "S22 missing flag named"  "$out" "--prefill"
  assert_contains "S22 fork hint shown"     "$out" "zom fork build"
  assert_eq    "S22 returns 1"              "$rc" "1"
  assert_eq    "S22 nothing exec'd"         "$(grep -c 'argv=mini -s' "$ZOM_MOCK_LOG" || true)" "0"
  cleanup

  # success is cached: two launches in one shell probe exactly once
  sandbox
  run_zsh 'zom a; zom b' >/dev/null 2>&1
  assert_eq "S22 one probe per shell"   "$(grep -c 'argv=mini --help' "$ZOM_MOCK_LOG" || true)" "1"
  assert_eq "S22 both launches exec'd"  "$(grep -c 'argv=mini -s' "$ZOM_MOCK_LOG" || true)" "2"
  cleanup

  # failure is not cached: the user may swap in a fixed binary, so the next
  # launch in the same shell must re-probe (and still refuse to exec)
  sandbox
  PATH="$MOCKBIN:$PATH" ZOM_MOCK_HELP_MISSING="--agent" zsh -f -c "source '$PLUGIN'; zom; zom" >/dev/null 2>&1 || true
  assert_eq "S22 failed probe retried"  "$(grep -c 'argv=mini --help' "$ZOM_MOCK_LOG" || true)" "2"
  assert_eq "S22 still nothing exec'd"  "$(grep -c 'argv=mini -s' "$ZOM_MOCK_LOG" || true)" "0"
  cleanup
}

t_S23_sequence_conflict() {
  # keybindConflict (shell.*): sequences sharing the summon-key prefix force
  # zsh to wait KEYTIMEOUT on every bare press. Default notify names them and
  # how to remove them in the user's own rc (the plugin reports only, it
  # never edits the keymap); off stays silent; bad values warn and fall back
  # to notify; the check runs once per shell. The check is invoked by
  # __zom_ensure_bind on the first prompt; tests call it directly (zsh -c
  # has no precmd), which is the same function and the same state.
  local setup="bindkey -e; KEYTIMEOUT=100; bindkey '^Xs' history-incremental-search-forward; bindkey '^X^U' undo"
  local H out
  local mk() { H=$(mktemp -d); mkdir -p "$H/.config/zsh-opencode-mini"; printf '%s' "$1" > "$H/.config/zsh-opencode-mini/config.jsonc"; }

  mk '{"shell":{"keybindConflict":"notify"}}'
  out=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" zsh -f -c "$setup; source '$PLUGIN'; __zom_keybind_conflict" 2>&1)
  assert_contains "S23 notify lists sequences"  "$out" 'also prefixes'
  assert_contains "S23 notify names a hit"      "$out" '"^X^B" vi-match-bracket'
  assert_contains "S23 notify prices the cost"  "$out" 'KEYTIMEOUT (1.00s)'
  assert_contains "S23 notify names the fix"    "$out" 'bindkey -rp "^X"'
  # the plugin edits no keymap: the shadowing sequences survive the report
  out=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" zsh -f -c "$setup; source '$PLUGIN'; __zom_keybind_conflict; bindkey '^Xs'" 2>&1)
  assert_contains "S23 keymap untouched" "$out" 'history-incremental-search-forward'

  mk '{"shell":{"keybindConflict":"off"}}'
  out=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" zsh -f -c "$setup; source '$PLUGIN'; __zom_keybind_conflict" 2>&1)
  assert_not_contains "S23 off silent" "$out" 'zsh-opencode-mini:'

  mk '{"shell":{"keybindConflict":"wat"}}'
  out=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" zsh -f -c "source '$PLUGIN'" 2>&1)
  assert_contains "S23 invalid warns"    "$out" "keybindConflict 'wat' invalid (notify|off)"

  # once per shell: repeated calls print nothing more
  mk '{"shell":{"keybindConflict":"notify"}}'
  out=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" zsh -f -c "$setup; source '$PLUGIN'; __zom_keybind_conflict; __zom_keybind_conflict" 2>&1)
  assert_eq "S23 once guard" "$(print -r -- "$out" | grep -c 'also prefixes')" "1"

  # zom-config surfaces the knob
  sandbox
  out=$(run_zsh 'zom-config' 2>&1)
  assert_contains "S23 zom-config line" "$out" "keybindConflict"
  rm -rf "$H" 2>/dev/null
  cleanup
}

t_S24_regression_fixes() {
  # 1) Numeric validation must work without EXTENDED_GLOB (zsh -f leaves it
  #    off): a valid replayLimit survives with no warning.
  sandbox
  write_config <<<'{ "shell": { "replayLimit": 7 } }'
  local out
  out=$(run_zsh 'print -r -- $ZOM_REPLAY_LIMIT' 2>&1)
  assert_eq "S24 replayLimit honored w/o EXTENDED_GLOB" "$out" "7"
  cleanup

  # 2) Prefill must preserve runs of spaces/tabs in the failed command
  #    (jq @tsv escapes inner tabs, so real tabs are field separators only).
  sandbox
  mkdir -p "$DD"
  local spaced='echo  a   b	c'
  local now=$(date +%s)
  printf '{"ts":"t","epoch":%d,"cwd":%s,"exit":1,"cmd":%s}\n' \
    "$now" "$(jq -Rn --arg s "$PWD" '$s')" "$(jq -Rn --arg s "$spaced" '$s')" \
    > "$DD/last-failure.json"
  out=$(run_zsh '__zom_failure_prefill')
  assert_contains "S24 prefill keeps double spaces" "$out" 'echo  a   b'
  cleanup

  # 3) zom-last applies the same freshness rules as the prefill: stale
  #    records and failures from another directory are rejected.
  sandbox
  mkdir -p "$DD"
  printf '{"ts":"t","epoch":1,"cwd":%s,"exit":1,"cmd":"old-cmd"}\n' \
    "$(jq -Rn --arg s "$PWD" '$s')" > "$DD/last-failure.json"
  out=$(run_zsh 'zom-last' 2>&1) || true
  assert_contains "S24 zom-last stale rejected" "$out" 'stale'
  printf '{"ts":"t","epoch":%d,"cwd":"/somewhere/else","exit":1,"cmd":"other-cmd"}\n' \
    "$now" > "$DD/last-failure.json"
  out=$(run_zsh 'zom-last' 2>&1) || true
  assert_contains "S24 zom-last wrong cwd rejected" "$out" 'not here'
  cleanup

  # 4) Spawn hooks run with stdin reconnected to /dev/tty (a ZLE widget's
  #    stdin is not a tty; hooks probing the terminal would misfire). In a
  #    test shell there is no tty at all — the hook must still run and its
  #    failure must not abort the spawn path.
  sandbox
  out=$(run_zsh 'ZOM_SPAWN_HOOKS+=(myhook); myhook() { print -r -- hook-ran; return 1 }; __zom_run_spawn_hooks; print -r -- after')
  assert_contains "S24 hook ran without tty" "$out" 'hook-ran'
  assert_contains "S24 hook failure tolerated" "$out" 'after'
  cleanup
}

t_S25_history_retention() {
  # Monthly files older than shell.historyRetainMonths are deleted at source
  # time; the cutoff is computed in total months to survive year boundaries.
  sandbox
  mkdir -p "$DD"
  : > "$DD/history-2020-01.jsonl"
  : > "$DD/history-$(date +%Y-%m).jsonl"
  run_zsh ':' >/dev/null
  assert_file_missing "$DD/history-2020-01.jsonl" "S25 ancient file deleted"
  assert_file_exists  "$DD/history-$(date +%Y-%m).jsonl" "S25 current file kept"
  cleanup

  # "off" keeps everything
  sandbox
  mkdir -p "$DD"
  : > "$DD/history-2020-01.jsonl"
  write_config <<<'{ "shell": { "historyRetainMonths": "off" } }'
  run_zsh ':' >/dev/null
  assert_file_exists "$DD/history-2020-01.jsonl" "S25 off keeps ancient file"
  cleanup

  # invalid value warns and falls back to the default
  sandbox
  local out
  out=$( { write_config <<<'{ "shell": { "historyRetainMonths": "soon" } }'; run_zsh ':'; } 2>&1 )
  assert_contains "S25 invalid warns" "$out" "historyRetainMonths 'soon' invalid"
  cleanup
}

t_S26_unclaimed_hint() {
  # A stroke logged >=3 times produces exactly one hint per shell; the hint
  # names both fixes. jq mangles nothing here — the log is written by the
  # fork, we only read it.
  sandbox
  mkdir -p "$DD"
  # The plugin derives the log name from ZOM_PASSTHROUGH_FILE, so write a
  # fixture log and point the variable at it inside the sandboxed shell.
  local out
  out=$(run_zsh "ZOM_PASSTHROUGH_FILE='$DD/pt'; { for i in 1 2 3; do print -r -- '{\"stroke\":\"ctrl+q\"}'; done; print -r -- '{\"stroke\":\"f9\"}' } > '$DD/pt.keys.log'; __zom_unclaimed_hint; __zom_unclaimed_hint" 2>&1)
  assert_eq "S26 hint fires once" "$(print -r -- "$out" | grep -c 'unclaimed')" "1"
  assert_contains "S26 hint names the stroke" "$out" 'ctrl+q'
  assert_contains "S26 hint names the fixes" "$out" 'passthroughKeys'
  cleanup
}

# S27: spawn hooks receive the spawn context; zom-bg's hook-visible sid is the
# real spawned sid (wezterm-attention binds background activity with it).
t_S27_hook_context() {
  sandbox
  run_zsh 'zsh_hook_probe() { print -r -- "$ZOM_HOOK_KIND|$ZOM_HOOK_SID|$ZOM_HOOK_CWD" >> "'$DD'/hooks.txt" }
    ZOM_SPAWN_HOOKS=(zsh_hook_probe)
    zom-bg "say hi"'
  local bg_line hook_sid spawn_sid tries=0
  while (( tries < 200 )) && ! grep -q "argv=run" "$ZOM_MOCK_LOG" 2>/dev/null; do
    sleep 0.1
    tries=$(( tries + 1 ))
  done
  bg_line=$(grep '^bg|' "$DD/hooks.txt")
  hook_sid=${bg_line#bg|}; hook_sid=${hook_sid%%|*}
  spawn_sid=$(grep -o 'ses_zom-bg-[0-9-]*' "$ZOM_MOCK_LOG" | head -n1)
  assert_eq "S27 hook sid equals spawned sid" "$hook_sid" "$spawn_sid"
  assert_contains "S27 hook sees cwd" "$bg_line" "|$PWD"
  # mini path with resume=main exposes the dedicated main session id
  ZOM_CFG_BLOB='{"shell":{"resume":"main"}}' run_zsh 'zsh_hook_probe() { print -r -- "$ZOM_HOOK_KIND|$ZOM_HOOK_SID" >> "'$DD'/hooks2.txt" }
    ZOM_SPAWN_HOOKS=(zsh_hook_probe)
    __zom_launch_mini >/dev/null 2>&1'
  assert_eq "S27 mini resume=main exposes main sid" "$(cat "$DD/hooks2.txt")" "mini|ses_zom-main"
  cleanup
}

# S28: an external executable works as a spawn hook and inherits the exported
# context (hook externalization: the consumer need not be a zsh function).
t_S28_external_hook() {
  sandbox
  cat > "$TD/ext-hook" <<'EOF'
#!/bin/zsh
print -r -- "$ZOM_HOOK_KIND|$ZOM_HOOK_SID" >> "$ZOM_TEST_HOOK_OUT"
EOF
  chmod +x "$TD/ext-hook"
  ZOM_TEST_HOOK_OUT="$DD/ext.txt" run_zsh 'ZOM_SPAWN_HOOKS=("'"$TD"'/ext-hook"); zom-bg "hi"'
  local tries=0
  while (( tries < 200 )) && [[ ! -s "$DD/ext.txt" ]]; do
    sleep 0.1; tries=$(( tries + 1 ))
  done
  assert_contains "S28 external hook ran with kind" "$(cat "$DD/ext.txt")" "bg|"
  assert_contains "S28 external hook got sid" "$(cat "$DD/ext.txt")" "ses_zom-bg-"
  cleanup
}

# S29: pathological-growth sentinel warns about an oversized history file.
t_S29_size_sentinel() {
  sandbox
  mkdir -p "$DD"
  # 10 MB + 1 byte of junk — dd from /dev/zero, fast enough at this size
  dd if=/dev/zero of="$DD/history-2026-10.jsonl" bs=1048576 count=11 2>/dev/null
  local out
  out=$(run_zsh ':' 2>&1)
  assert_contains "S29 oversized history warned" "$out" 'over 10 MB'
  assert_contains "S29 warning names the file" "$out" 'history-2026-10.jsonl'
  cleanup
}

# S30: shell-side notices — a failing spawn hook appends one notice per shell
# (deduped), and the size sentinel drops a notice beside its stderr warning.
t_S30_notices() {
  sandbox
  mkdir -p "$DD"
  run_zsh 'failing_hook() { return 7 }
    ZOM_SPAWN_HOOKS=(failing_hook)
    zom-bg "one"
    zom-bg "two"'
  local nf="$DD/notices.jsonl"
  [[ -f "$nf" ]] || { (( FAIL++ )); print -r -- "  FAIL  S30 notice written: file missing"; cleanup; return }
  local lines
  lines=$(grep -c 'hook-failure' "$nf")
  assert_eq "S30 hook failure deduped per shell" "$lines" "1"
  assert_contains "S30 notice names hook and rc" "$(cat "$nf")" 'failing_hook exited 7'
  assert_contains "S30 notice carries kind" "$(cat "$nf")" 'kind=bg'
  # sentinel notice beside the stderr warning
  dd if=/dev/zero of="$DD/history-2026-10.jsonl" bs=1048576 count=11 2>/dev/null
  run_zsh ':'
  assert_contains "S30 sentinel drops a notice" "$(cat "$nf")" 'history-oversized'
  cleanup
}

# S31: every spawn appends one usage-measurement line to spawns.jsonl.
t_S31_spawn_measurement() {
  sandbox
  mkdir -p "$DD"
  run_zsh 'zom-bg "one"
    zom-bg "two"'
  local sf="$DD/spawns.jsonl"
  [[ -f "$sf" ]] || { (( FAIL++ )); print -r -- "  FAIL  S31 spawns.jsonl written: file missing"; cleanup; return }
  assert_eq "S31 one line per spawn" "$(grep -c '' "$sf")" "2"
  assert_eq "S31 kind recorded" "$(grep -c '"kind":"bg"' "$sf")" "2"
  cleanup
}

# S32: a failure prefills once — seen is consumed, sent or not. A new
# failure (new epoch) prefills again.
t_S32_prefill_consumed_once() {
  sandbox
  run_command 'git push --force' 'false'
  run_zsh 'zom x' >/dev/null 2>&1
  run_zsh 'zom x' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_eq "S32 prefill consumed once" "$(grep -c -- '--prefill' <<<"$log")" "1"
  sleep 1   # epochs are second-granular; a same-second failure shares the epoch
  run_command 'git push --force' 'false'
  run_zsh 'zom x' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_eq "S32 new failure prefills again" "$(grep -c -- '--prefill' <<<"$log")" "2"
  cleanup
}

# S33: hooks read stdin from $TTY (the real terminal device), never /dev/tty —
# the ctty alias's ttyname(3) is the literal string "/dev/tty" on macOS and
# breaks consumers that identify their terminal by path (wezterm-attention's
# claim refused with "WEZTERM_PANE was inherited" until this). An unusable TTY
# falls back to the inherited stdin instead of skipping the hook.
t_S33_hook_stdin_tty() {
  sandbox
  print -r -- "REALTTY-MARK" > "$TD/fake-tty"
  run_zsh 'zsh_hook_stdin() { cat > "'$DD'/stdin.txt" }
    TTY="'$TD'/fake-tty" ZOM_SPAWN_HOOKS=(zsh_hook_stdin)
    zom-bg "hi"' </dev/null
  assert_eq "S33 hook stdin comes from TTY" "$(cat "$DD/stdin.txt")" "REALTTY-MARK"
  run_zsh 'zsh_hook_stdin() { cat > "'$DD'/stdin2.txt" }
    TTY="'$TD'/gone" ZOM_SPAWN_HOOKS=(zsh_hook_stdin)
    zom-bg "hi"' </dev/null
  assert_eq "S33 unusable TTY falls back to inherited stdin" "$(cat "$DD/stdin2.txt")" ""
  cleanup
}

for t in t_S1_recording t_S2_escaping t_S3_failure_signal t_S4_datetime_selfload \
         t_S5_osc_frame t_S6_zom_launch t_S7_zom_last t_S8_keybind \
         t_S9_config_dataDir t_S10_companion_contract t_S11_keybind_conflict \
         t_S12_err_return_survival t_S13_broken_config t_S14_concurrent_append \
         t_S15_zom_last_empty t_S16_outbox_cursor t_S16_outbox_malformed t_S17_zom_bg \
         t_S18_zom_config t_S19_agent_md_frontmatter t_S20_widget_always_cold_start t_S21_resource_idempotent \
         t_S22_argv_probe t_S23_sequence_conflict t_S24_regression_fixes \
         t_S25_history_retention t_S26_unclaimed_hint t_S27_hook_context \
         t_S28_external_hook t_S29_size_sentinel t_S30_notices t_S31_spawn_measurement \
         t_S32_prefill_consumed_once t_S33_hook_stdin_tty; do
  print -r -- "[$t]"
  $t
done
print -r -- "----------------------------------------"
print -r -- "total: $(( PASS + FAIL ))  pass: $PASS  fail: $FAIL"
(( FAIL == 0 )) || exit 1
