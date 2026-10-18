// "The third time this command failed today" is an aggregation a human cannot
// do from the seat: each failure is visible, the pattern is not. The host
// reports every recorded failure; deciding that a count is worth interrupting
// for — and how to phrase it — belongs here.
export default {
  id: "repeat-failure",
  setup(ctx, host) {
    const threshold = host.config.repeatFailureThreshold
    if (!(threshold > 0)) return
    // Every server instance sharing this data dir runs this listener, so one
    // failure would queue one hint per live process. The hint's identity is
    // (command, day): at most one per outbox per day, whoever gets there first.
    const queuedToday = (cmd, day) =>
      host.outbox
        .records()
        .some((r) => r.kind === "repeat-failure" && r.day === day && r.cmd === cmd)

    // Local calendar day, not UTC: the history file is named by local month,
    // and "today" in the user's head is their own date.
    const today = () => {
      const d = new Date()
      return (
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` +
        `-${String(d.getDate()).padStart(2, "0")}`
      )
    }
    const countToday = (cmd, day) =>
      host.files
        .failureRecords()
        .filter((r) => r.cmd === cmd && r.exit !== 0 && String(r.ts ?? "").startsWith(day))
        .length

    host.onFailure((sig) => {
      const day = today()
      if (countToday(sig.cmd, day) !== threshold) return
      if (queuedToday(sig.cmd, day)) return
      host.outbox.append({
        kind: "repeat-failure",
        day,
        cmd: sig.cmd,
        text: `'${sig.cmd}' has failed ${threshold} times today — worth a closer look before retrying again`,
      })
    })
  },
}
