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
#   Launcher (mock opencode in tests/bin):
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
  local before
  before=$(cat "$f")
  run_command 'true-cmd' 'true'
  assert_eq "S3 zero-exit leaves signal" "$(cat "$f")" "$before"
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
  run_command 'git push --force' 'false'
  printf '{"ts":"2020-01-01T00:00:00+0000","epoch":1,"cwd":"/tmp","exit":1,"cmd":"git push --force"}\n' \
    > "$DD/last-failure.json"   # stale beyond any TTL (epoch inside the payload)
  run_zsh 'zom extra-arg' >/dev/null 2>&1
  log=$(cat "$ZOM_MOCK_LOG")
  assert_not_contains "S6 stale failure does not prefill" "$log" "--prefill"
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
  # the run is backgrounded; give the mock binary up to 5s to log its argv
  local tries=0
  while (( tries < 50 )) && ! grep -q "argv=run" "$ZOM_MOCK_LOG" 2>/dev/null; do
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
for t in t_S1_recording t_S2_escaping t_S3_failure_signal t_S4_datetime_selfload \
         t_S5_osc_frame t_S6_zom_launch t_S7_zom_last t_S8_keybind \
         t_S9_config_dataDir t_S10_companion_contract t_S11_keybind_conflict \
         t_S12_err_return_survival t_S13_broken_config t_S14_concurrent_append \
         t_S15_zom_last_empty t_S16_outbox_cursor t_S17_zom_bg; do
  print -r -- "[$t]"
  $t
done
print -r -- "----------------------------------------"
print -r -- "total: $(( PASS + FAIL ))  pass: $PASS  fail: $FAIL"
(( FAIL == 0 )) || exit 1
