// A background session finishing is a fact the shell prompt would otherwise
// show once, in a log the user scrolled past. The host reports every execution
// event; deciding that this one was a background session the user is waiting
// on — and that it is worth a line in the next context — is here.
export default {
  id: "bg-done",
  setup(ctx, host) {
    // sid -> {sid, cwd, ok, ts} waiting for the next context hook. In-memory
    // on purpose: the hint lives as long as the process, the outbox copy
    // already reached the shell prompt.
    const queue = []
    host.onSessionExecution(({ sid, ok }) => {
      const ledger = host.files.bgLedger()
      if (!ledger.has(sid)) return
      // One notification per sid across processes: every server instance
      // re-delivers the same event id, and an attached session emits a new
      // execution per turn. The claim file is the cross-process half.
      if (!host.files.claim(`bg-notice-${sid}`)) return
      host.outbox.append({
        kind: "bg-done",
        sid,
        ok,
        text: `background session ${sid} finished${ok ? "" : " with error"}`,
      })
      // Queued for the next context hook, which also records the sid so the
      // zsh drain skips the outbox copy for it.
      queue.push({ sid, cwd: ledger.get(sid) ?? "", ok, ts: Math.floor(Date.now() / 1000) })
    })

    ctx.session.hook("context", (event) => {
      const now = Math.floor(Date.now() / 1000)
      const done = []
      while (queue.length > 0) {
        const item = queue.shift()
        // Older than the failure TTL: the shell prompt already showed it, and
        // a relayed notice for a session from an hour ago is noise.
        if (now - item.ts > host.config.failureTtlSeconds) continue
        done.push(item)
        host.files.markBgInjected(item.sid)
      }
      if (done.length === 0) return
      host.inject(
        event,
        `[zsh-opencode-mini] background session(s) finished (the shell ` +
          `prompt will not repeat these):\n` +
          done
            .map((b) => `- ${b.sid}${b.ok ? "" : " (with error)"} in ${b.cwd || "unknown cwd"}`)
            .join("\n"),
      )
    })
  },
}
