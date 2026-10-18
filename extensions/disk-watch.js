// Disk-full is the one failure this stack converts into lost sessions: the
// server persists session state through SQLite, and when the volume backing
// that database runs out, writes fail — sessions stop draining, and
// backgrounding a blocking tool crashes the mini TUI outright (observed
// 2026-10-18: ctrl+b on a full disk killed the process). The user cannot see
// free space shrinking in daily use; noticing it is this extension's call.
//
// Measured on the volume of the data dir, which is the same volume as
// ~/.local/share/opencode's database. APFS purgeable space is not credited
// (statfs bavail matches df's Avail), so the estimate errs early — acceptable
// for a warning.

import { statfsSync } from "node:fs"

// One alarm, one condition: free space at or below 10% of volume capacity.
// Re-warn no more often than the cooldown so a context that sits at 91% does
// not nag on every turn; if the condition holds past the cooldown, reminding
// is correct — the disk is still full.
export const WARN_AT = 0.9
export const COOLDOWN_MS = 6 * 60 * 60 * 1000

export function shouldWarn(usedPct, lastWarnAt, now) {
  if (usedPct < WARN_AT) return false
  return lastWarnAt === undefined || now - lastWarnAt >= COOLDOWN_MS
}

const noticeText = (pct) =>
  `[zom-disk-watch] the volume holding opencode's data is ${pct}% full — ` +
  `session persistence writes are failing or about to. Consequences the user ` +
  `may already be seeing: sessions fail to drain, and backgrounding a blocking ` +
  `tool (ctrl+b) crashes the mini TUI. Surface this proactively and suggest ` +
  `reclaiming space (caches such as go-build, playwright, wezterm are common wins).`

export default {
  id: "zom-disk-watch",
  async setup(ctx, host = {}) {
    const dir = host.dataDir
    if (typeof dir !== "string") {
      host.report?.("host missing dataDir — companion build is too old")
      return
    }
    const store = host.storage("zom-disk-watch")
    const state = store.get() ?? {}

    ctx.session.hook("context", (event) => {
      if (event.agent !== host.agent) return
      // host.statfs is a test seam; the real host never sets it.
      let pct
      try {
        const s = (host.statfs ?? statfsSync)(dir)
        const total = Number(s.blocks) * Number(s.bsize)
        const avail = Number(s.bavail) * Number(s.bsize)
        if (total <= 0) return
        pct = Math.round((1 - avail / total) * 100)
      } catch {
        // An unreadable volume must never disturb the composer; the next
        // context retries.
        return
      }
      const now = Date.now()
      if (!shouldWarn(pct / 100, state.lastWarnAt, now)) return
      state.lastWarnAt = now
      store.set(state)
      host.inject(event, noticeText(pct))
    })
  },
}
