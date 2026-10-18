// A broken extension is a fact about this host, not about the session the user
// opened. The host queues the raw report (it is the only place that sees a
// load fail); how often to repeat it, how long it stays relevant, and what the
// user reads are decisions that belong here.
const COOLDOWN_MS = 10 * 60 * 1000
const MAX_AGE_SECONDS = 60 * 60

export default {
  id: "extension-health",
  setup(ctx, host) {
    // name+msg -> last time we said it. In memory on purpose: a restart is a
    // fresh chance to surface a still-broken extension.
    const said = new Map()
    ctx.session.hook("context", (event) => {
      const pending = host.files.drainProblems()
      if (pending.length === 0) return
      const now = Date.now()
      const fresh = []
      for (const p of pending) {
        if (now / 1000 - p.ts > MAX_AGE_SECONDS) continue // an hour-old complaint is noise
        const key = `${p.name}\u0000${p.msg}`
        if (now - (said.get(key) ?? 0) < COOLDOWN_MS) continue
        said.set(key, now)
        fresh.push(p)
      }
      if (fresh.length === 0) return
      host.inject(
        event,
        "[zom] extension problem — surface this to the user:\n" +
          fresh.map((p) => `- ${p.name}: ${p.msg}`).join("\n"),
      )
    })
  },
}
