// zsh-opencode-mini's session-title watcher.
//
// The server names a session from its first message and never again. When that
// first message is a greeting, the name stays a greeting ("问候打招呼") for the
// whole session, and mini's status line keeps showing it because the status
// line reads the session title.
//
// The boundary that matters is silence, not volume: a prompt that arrives after
// a long gap is usually the next task, and that is the moment the old name stops
// describing the session. So the trigger is "first prompt after ≥ autoTitleIdle
// minutes of quiet", not "the conversation got long". The default matches
// opencode-idle-compaction's 54 minutes, the same notion of "long enough that
// what comes next is a new task".
//
// The rename asks the server to regenerate from its bounded history
// (session.update with an empty title), so the name comes from the model that
// already knows how to name sessions.

const DEFAULT_IDLE_MINUTES = 54
const KEEP_MS = 7 * 24 * 3600 * 1000

export default {
  id: "zom-session-title",
  async setup(ctx, host = {}) {
    const store = host.storage?.("zom-session-title")
    if (!store) {
      host.report?.("host missing storage — companion build is too old")
      return
    }
    const cfg = host.config ?? {}
    const mode = String(cfg.autoTitle ?? "idle").toLowerCase()
    if (mode === "off") return
    const minutes = Number.isFinite(cfg.autoTitleIdleMinutes) && cfg.autoTitleIdleMinutes > 0
      ? cfg.autoTitleIdleMinutes
      : DEFAULT_IDLE_MINUTES
    const idleMs = minutes * 60_000

    const state = store.get() ?? {}
    const last = state.last ?? {} // sessionID -> timestamp of its previous request
    const renamed = state.renamed ?? {} // sessionID -> timestamp of the last regeneration

    const save = (now) => {
      for (const map of [last, renamed]) {
        for (const [key, ts] of Object.entries(map)) {
          if (now - ts > KEEP_MS) delete map[key]
        }
      }
      store.set({ last, renamed })
    }

    ctx.session.hook("context", (event) => {
      if (event.agent !== host.agent) return
      const id = event.sessionID
      if (!id) return
      const now = Date.now()
      const previous = last[id]
      last[id] = now
      // Persist the clock on every request: a server restart that lost it would
      // read the first prompt as "new session" and never notice the silence.
      save(now)
      // First sighting seeds the clock: the opening message is already covered
      // by the server's own initial title.
      if (previous === undefined || now - previous < idleMs) return
      if ((renamed[id] ?? 0) >= previous) return
      renamed[id] = now
      save(now)

      // Fire-and-forget: title generation is a model call, and the request this
      // hook belongs to must not wait for it.
      const run = async () => {
        // An empty title is the "regenerate from history" path, the same
        // semantics as the HTTP endpoint (session.update).
        await ctx.session.update({ sessionID: id, title: "" })
      }
      run().catch((e) => host.report?.(`title regenerate failed: ${e?.message ?? e}`))
    })
  },
}
