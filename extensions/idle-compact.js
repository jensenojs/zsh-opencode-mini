// Idle compaction for the mini's own conversation.
//
// The mini keeps one conversation for weeks: a task finishes, the shell sits
// idle, and the history of that finished task still rides every later request.
// Almost none of it can matter a day later — except the traps it discovered.
// This extension compacts that conversation once it has been idle, so the next
// summon starts from a short summary instead of the full transcript.
//
// Only the conversation the user returns to is touched: subagent sessions and
// sessions belonging to another agent are left alone.

const DEFAULT_IDLE_MINUTES = 30
// Idleness alone is not a reason to compact: below this size the conversation
// is cheaper to carry than to summarize, because the compaction request reads
// the whole transcript once and the summary rewrites the cached prefix on the
// next turn. The floor also bounds the idle loop from the other side — what a
// compaction leaves behind is always under it, so the summary is never
// summarized again while the session sits untouched.
const DEFAULT_MIN_CONTEXT_TOKENS = 200_000
// Compaction reports usage of its own. A delta that re-armed the timer would
// compact again and again with the user never sending a prompt, so the extension
// stays deaf for a while after firing and waits for real activity.
const QUIET_AFTER_COMPACT_MS = 5 * 60_000
const DEDUPE_MS = 10 * 60_000

// The session's own clock, in the shapes the wire can hand over: the schema is
// epoch millis, the SDK may already have decoded it to a Date or a DateTime,
// and a server build without `updated` still reports when the last run ended.
const activityAt = (session) => {
  const raw = session?.time?.updated ?? session?.time?.idle ?? session?.time_updated
  if (raw == null) return 0
  if (typeof raw === "number") return raw
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw.getTime === "function") return raw.getTime()
  if (typeof raw.epochMilliseconds === "number") return raw.epochMilliseconds
  return 0
}

// "Nothing to compact yet" is the server's verdict, not a failure: the history
// outside the keep window is already gone. The SDK surfaces it as an error, so
// match the message and the typed fields the wire may carry instead.
const nothingToCompact = (e) =>
  /nothing to compact/i.test(String(e?.message ?? "")) ||
  e?.data?.type === "compaction.unavailable" ||
  e?.error?.type === "compaction.unavailable"

const INSTRUCTION = [
  "This conversation is being compacted for a terminal assistant that keeps one session for months.",
  "Keep only what is still true: standing preferences and constraints, decisions already made,",
  "project facts and paths worth remembering, traps hit and how they were avoided,",
  "and the state of work that is still unfinished.",
  "Drop the process of finished tasks: commands run, output read, intermediate steps, retries, plans that played out.",
  "Do not recap the conversation in order; write for the next task, not for a reader of this one.",
].join(" ")

export default {
  id: "zom-idle-compact",
  async setup(ctx, host = {}) {
    if (typeof host.session?.get !== "function" || typeof host.session?.compact !== "function") {
      host.report?.("host missing session.get/compact — companion build is too old")
      return
    }
    if (typeof host.onUsageDelta !== "function") {
      host.report?.("host missing onUsageDelta — companion build is too old")
      return
    }
    // The summarizer is told what this conversation is for; without it the
    // default summary recaps finished work in detail, which is exactly the part
    // that has no value here.
    host.compactionPrompt?.(INSTRUCTION)

    const settings = host.config?.idleCompact ?? {}
    const idleMs = (Number.isFinite(settings.idleMinutes) ? settings.idleMinutes : DEFAULT_IDLE_MINUTES) * 60_000
    const minContext = Number.isFinite(settings.minContextTokens) ? settings.minContextTokens : DEFAULT_MIN_CONTEXT_TOKENS
    const timers = new Map()
    const lastFire = new Map()
    const muted = new Map()
    // Size at which the server last said there was nothing to fold. Asking again
    // at that size is asking the same question twice; the timer stays off until
    // the conversation has grown past the point where the answer was no.
    const refusedAt = new Map()
    // The last size each session reported; the refusal floor is compared
    // against it, and fire() needs it without a delta in hand.
    const lastSize = new Map()
    const firing = new Set()
    let reportedNoSize = false
    // When each session last reported usage. A subagent runs as its own
    // session, and nothing on the parent moves while it works — this map is the
    // only place that activity is visible. Insertion order is recency.
    const lastSeen = new Map()
    const ACTIVITY_CAP = 64

    const noteActivity = (sid) => {
      lastSeen.delete(sid)
      lastSeen.set(sid, Date.now())
      while (lastSeen.size > ACTIVITY_CAP) lastSeen.delete(lastSeen.keys().next().value)
    }

    // The newest usage among the sessions that name `sid` as their parent.
    // Sessions are asked for their own record: the alternative, remembering the
    // parent at delta time, would put an async lookup in the hot path and trust
    // a value a resumed session may have outgrown.
    const newestChildActivity = async (sid) => {
      const since = Date.now() - idleMs
      let newest = 0
      for (const [other, ts] of lastSeen) {
        if (other === sid || ts < since) continue
        const otherSession = await host.session.get(other)
        if (otherSession?.parentID === sid && ts > newest) newest = ts
      }
      return newest
    }

    const disarm = (sid) => {
      clearTimeout(timers.get(sid))
      timers.delete(sid)
    }

    const arm = (sid, delay) => {
      disarm(sid)
      const timer = setTimeout(() => void fire(sid), delay)
      // A pending compaction must not keep a shutting-down host alive.
      timer.unref?.()
      timers.set(sid, timer)
    }

    const fire = async (sid) => {
      timers.delete(sid)
      if (firing.has(sid)) return
      firing.add(sid)
      try {
        const session = await host.session.get(sid)
        // A subagent's history is never summoned again; compacting it is waste.
        if (!session || session.parentID) return
        if (session.agent !== host.agent) return
        // The timer is a hint, the session is the authority. It outlives the
        // generation that armed it, and it never sees activity that produced no
        // usage delta, so it can come due while the conversation is in use.
        // Re-check against the session's own clock and wait out whatever part
        // of the idle window is left.
        const quiet = Date.now() - activityAt(session)
        if (quiet < idleMs) {
          arm(sid, idleMs - quiet)
          return
        }
        // A child's work is the parent's work: nothing on the parent moves
        // while a subagent runs, so its own clock reads idle. Measure the
        // window from the newest child activity instead.
        const childAt = await newestChildActivity(sid)
        if (Date.now() - childAt < idleMs) {
          arm(sid, idleMs - (Date.now() - childAt))
          return
        }
        if (Date.now() - (lastFire.get(sid) ?? 0) < DEDUPE_MS) return
        const size = lastSize.get(sid) ?? 0
        lastFire.set(sid, Date.now())
        muted.set(sid, Date.now() + QUIET_AFTER_COMPACT_MS)
        try {
          await host.session.compact(sid)
          refusedAt.delete(sid)
        } catch (e) {
          if (!nothingToCompact(e)) throw e
          // The fold found nothing to summarize. Record the size so the next
          // window can tell "still nothing" from "grown since", and stay quiet:
          // a no-op is not something the user has to hear about.
          refusedAt.set(sid, size)
        }
      } catch (e) {
        host.report?.(`compaction failed for ${sid}: ${e?.message ?? e}`)
      } finally {
        firing.delete(sid)
      }
    }

    // A reload drops this generation's listener but not its timers; without
    // this they fire into the next generation, which cannot clear them.
    host.onDispose?.(() => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    })

    host.onUsageDelta(({ sid, dInput, dRead, dWrite }) => {
      if (!sid) return
      noteActivity(sid)
      // One request's input is the conversation it carried: fresh tokens plus
      // the cache it read and wrote. The host reports them as deltas of the
      // session's cumulative counters.
      const size = [dInput, dRead, dWrite].every((n) => typeof n === "number")
        ? dInput + dRead + dWrite
        : null
      if (size == null) {
        if (!reportedNoSize) {
          reportedNoSize = true
          host.report?.("usage delta carries no token size — idle compaction stays off")
        }
        return
      }
      if ((muted.get(sid) ?? 0) > Date.now()) return
      // Only a request that is not the fold itself describes what the
      // conversation carries; the quiet window keeps the fold's own bill out.
      lastSize.set(sid, size)
      // Nothing worth compacting: drop whatever timer the previous, larger
      // conversation armed.
      if (size < minContext) {
        disarm(sid)
        return
      }
      // Already asked at this size and the server had nothing to fold. Growth
      // past that point is the only thing that makes the question new again.
      const refused = refusedAt.get(sid)
      if (refused !== undefined) {
        if (size <= refused) {
          disarm(sid)
          return
        }
        refusedAt.delete(sid)
      }
      arm(sid, idleMs)
    })
  },
}
