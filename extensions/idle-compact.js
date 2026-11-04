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
// Compaction reports usage of its own. A delta that re-armed the timer would
// compact again and again with the user never sending a prompt, so the extension
// stays deaf for a while after firing and waits for real activity.
const QUIET_AFTER_COMPACT_MS = 5 * 60_000
const DEDUPE_MS = 10 * 60_000

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
    const timers = new Map()
    const lastFire = new Map()
    const muted = new Map()
    const firing = new Set()

    const disarm = (sid) => {
      clearTimeout(timers.get(sid))
      timers.delete(sid)
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
        if (Date.now() - (lastFire.get(sid) ?? 0) < DEDUPE_MS) return
        lastFire.set(sid, Date.now())
        muted.set(sid, Date.now() + QUIET_AFTER_COMPACT_MS)
        await host.session.compact(sid)
      } catch (e) {
        host.report?.(`compaction failed for ${sid}: ${e?.message ?? e}`)
      } finally {
        firing.delete(sid)
      }
    }

    host.onUsageDelta(({ sid }) => {
      if (!sid) return
      if ((muted.get(sid) ?? 0) > Date.now()) return
      disarm(sid)
      const timer = setTimeout(() => void fire(sid), idleMs)
      // A pending compaction must not keep a shutting-down host alive.
      timer.unref?.()
      timers.set(sid, timer)
    })
  },
}
