#!/usr/bin/env zsh
# Instrumented flake hunter (scratch, delete after the hunt).
# Same harness and scenario bodies as tests/run.zsh (extracted live), with:
#   - scenarios taken from argv (or "all-except-S10" via the token ALL_BUT_S10)
#   - bad() instrumented: on any failing assertion it dumps scenario name,
#     assertion text, got/expected, current sandbox path, data-dir listing,
#     mock log, and a nanosecond timestamp into /tmp/zom-flake-evidence/

emulate -L zsh
setopt err_return no_unset

ROOT=/Users/oujinsai/Projects/wez-ai/zsh-opencode-mini
PLUGIN="$ROOT/zsh-opencode-mini.plugin.zsh"
MOCKBIN="$ROOT/tests/bin"
EVID=/tmp/zom-flake-evidence
mkdir -p "$EVID"
PASS=0
FAIL=0
TD=
CURRENT_SCENARIO=unknown

ok()   { print -r -- "  PASS  $1"; PASS=$(( PASS + 1 )) }
bad()  {
  print -r -- "  FAIL  $1: $2"; FAIL=$(( FAIL + 1 ))
  local f="$EVID/fail-$EPOCHSECONDS-$RANDOM.log"
  {
    print -r -- "scenario: $CURRENT_SCENARIO"
    print -r -- "assertion: $1"
    print -r -- "detail: $2"
    print -r -- "date: $(date +%Y-%m-%dT%H:%M:%S.%N)"
    print -r -- "EPOCHREALTIME: $EPOCHREALTIME"
    print -r -- "sandbox TD: $TD"
    print -r -- "DD: $DD"
    print -r -- "--- data dir ---"
    ls -la "$DD" 2>&1
    print -r -- "--- history files ---"
    for j in "$DD"/history-*.jsonl; do [[ -f "$j" ]] && { print -r -- "[$j]"; cat "$j"; }
    done
    print -r -- "--- last-failure.json ---"
    cat "$DD/last-failure.json" 2>&1
    print -r -- "--- outbox files ---"
    cat "$DD/outbox.jsonl" 2>&1
    cat "$DD/outbox.cursor" 2>&1
    print -r -- "--- bg.jsonl ---"
    cat "$DD/bg.jsonl" 2>&1
    print -r -- "--- mock log ---"
    cat "$ZOM_MOCK_LOG" 2>&1
    print -r -- "--- config ---"
    cat "$XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc" 2>&1
  } > "$f" 2>&1
}
assert_eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1" "expected [$3], got [$2]" }
assert_contains() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1" "[$2] lacks [$3]" }
assert_not_contains() { [[ "$2" != *"$3"* ]] && ok "$1" || bad "$1" "[$2] unexpectedly contains [$3]" }
assert_file_exists() { [[ -f "$1" ]] && ok "$2" || bad "$2" "missing file $1" }

sandbox() {
  TD=$(mktemp -d)
  export HOME="$TD/home"
  export XDG_CONFIG_HOME="$TD/home/.config"
  export XDG_DATA_HOME="$TD/home/.local/share"
  DD="$XDG_DATA_HOME/zsh-opencode-mini"
  export ZOM_MOCK_LOG="$TD/mock.log"
  : > "$ZOM_MOCK_LOG"
}
cleanup() { [[ -n "$TD" ]] && mv "$TD" /tmp/zom-suite-scratch-$$ 2>/dev/null; TD= }

write_config() { mkdir -p "$XDG_CONFIG_HOME/zsh-opencode-mini"; cat > "$XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc"; }

run_zsh() { PATH="$MOCKBIN:$PATH" zsh -f -c "source '$PLUGIN'; $1" }

run_command() { run_zsh "__zom_preexec '$1'; $2; __zom_precmd" }

sed -n '/^# --- scenarios/,/^# --- runner/p' "$ROOT/tests/run.zsh" | sed '$d' | sed '$d' > /tmp/zom-scenarios-$$.zsh
source /tmp/zom-scenarios-$$.zsh
rm -f /tmp/zom-scenarios-$$.zsh

print -r -- "instrumented flake hunt"
if [[ "$1" == "ALL_BUT_S10" ]]; then
  set -- t_S1_recording t_S2_escaping t_S3_failure_signal t_S4_datetime_selfload \
         t_S5_osc_frame t_S6_zom_launch t_S7_zom_last t_S8_keybind \
         t_S9_config_dataDir t_S11_keybind_conflict t_S12_err_return_survival \
         t_S13_broken_config t_S14_concurrent_append t_S15_zom_last_empty \
         t_S16_outbox_cursor t_S17_zom_bg
fi
for t in "$@"; do
  print -r -- "[$t]"
  CURRENT_SCENARIO=$t
  $t
done
print -r -- "----------------------------------------"
print -r -- "total: $(( PASS + FAIL ))  pass: $PASS  fail: $FAIL"
(( FAIL == 0 )) || exit 1
