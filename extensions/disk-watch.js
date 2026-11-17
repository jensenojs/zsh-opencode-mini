// Disk-full is the one failure this stack converts into lost sessions: on a
// genuinely full volume the server can no longer persist session state, and
// backgrounding a blocking tool crashes the mini TUI outright (observed
// 2026-10-18: ctrl+b on a full disk killed the process). The user cannot see
// free space shrinking in daily use; noticing it is this extension's call.
//
// Measured on the volume of the data dir, which is the same volume as
// ~/.local/share/opencode's database. The predicate is absolute free bytes,
// not a used percentage: writes fail when few bytes remain, and a percentage
// of a large volume warns years before anything is wrong (92% of 494GB is
// 39GB free). APFS purgeable space is not credited (statfs bavail matches
// df's Avail), so the estimate errs early — acceptable for a warning.

import { statfsSync } from "node:fs"

// One alarm, one condition: fewer than 10GB free. Re-warn no more often than
// the cooldown; if the condition holds past the cooldown, reminding is
// correct — the disk is still nearly full.
export const WARN_BELOW_BYTES = 10n * 1024n ** 3n
export const COOLDOWN_MS = 6 * 60 * 60 * 1000

export function shouldWarn(availBytes, lastWarnAt, now) {
  if (availBytes >= WARN_BELOW_BYTES) return false
  return lastWarnAt === undefined || now - lastWarnAt >= COOLDOWN_MS
}

const gb = (bytes) => Math.round(Number(bytes) / 1024 ** 3)

const noticeText = (availBytes) =>
  `[zom-disk-watch] the volume holding opencode's data is down to ${gb(availBytes)}GB free. ` +
  `Surface this proactively and suggest reclaiming space (build dirs such as ` +
  `target/ and node_modules are common wins).`

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
      let avail
      try {
        const s = (host.statfs ?? statfsSync)(dir)
        avail = Number(s.bavail) * Number(s.bsize)
      } catch {
        // An unreadable volume must never disturb the composer; the next
        // context retries.
        return
      }
      const now = Date.now()
      if (!shouldWarn(BigInt(avail), state.lastWarnAt, now)) return
      state.lastWarnAt = now
      store.set(state)
      host.inject(event, noticeText(BigInt(avail)))
    })
  },
}
