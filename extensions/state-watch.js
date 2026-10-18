// zsh-opencode-mini's state-dir watcher (policy only).
//
// The shell data dir holds one unbounded append-only writer the plugin
// itself documents as a knockout (bg.jsonl, ~60B/line spawn ledger) plus
// per-pid passthrough key logs that outlive their processes. History rotates
// monthly with cleanup, notices.jsonl drains destructively, last-failure.json
// is overwritten in place. Two files need a periodic cutter: bg.jsonl and the
// outbox (rotated here rather than on the append path, where it would read the
// whole file per record and race another process's append).
//
// Trim semantics follow the outbox rotation philosophy: keep the tail,
// cut at a newline, tmp+mv; consumers tolerate at-least-once.

import { join } from "node:path"

const BG_MAX_BYTES = 1024 * 1024 // trim bg.jsonl once past 1MB
const OUTBOX_MAX_BYTES = 1024 * 1024
const KEEP_TAIL_BYTES = 64 * 1024
const KEYLOG_AGE_MS = 7 * 24 * 60 * 60 * 1000 // keys.log older than a week
const CLAIM_AGE_MS = 60 * 60 * 1000 // a claim only has to outlive the race
const SCAN_EVERY_N_DELTAS = 50 // one scan per ~50 requests, not per event
const NOTICES_MAX_BYTES = 256 * 1024
// One-shot markers: per-pid key logs and the claims that make "fire once"
// hold across processes. Both are useless once the process that wrote them is
// long gone.
const STALE = [
  [/^passthrough\.\d+\.keys\.log$/, KEYLOG_AGE_MS],
  [/^claim-/, CLAIM_AGE_MS],
]
const TRIMMED = {
  "bg.jsonl": BG_MAX_BYTES,
  "outbox.jsonl": OUTBOX_MAX_BYTES,
  // Normally drained by notices.js; if that extension is not loaded the file
  // only ever grows, so the scanner caps it too (oldest dropped, which the
  // drain already tolerates).
  "notices.jsonl": NOTICES_MAX_BYTES,
}

export default {
  id: "zom-state-watch",
  async setup(ctx, host = {}) {
    if (typeof host.onUsageDelta !== "function" || !host.dataDir) {
      host.report?.("host missing onUsageDelta/dataDir — companion build is too old")
      return
    }
    let pendingScans = 0
    host.onUsageDelta(() => {
      if (++pendingScans < SCAN_EVERY_N_DELTAS) return
      pendingScans = 0
      scan()
    })

    function scan() {
      // Filesystem facts come from the host; which file, how big, how old is
      // the choice made here.
      for (const entry of host.files.entries()) {
        if (!entry.isFile) continue
        const cap = TRIMMED[entry.name]
        if (cap !== undefined) {
          if (entry.size > cap) trimTail(join(host.dataDir, entry.name), entry.size, cap)
        } else if (STALE.some(([re, age]) => re.test(entry.name) && Date.now() - entry.mtimeMs > age)) {
          // gone by itself already is not an error
          host.files.remove(entry.name)
        }
      }
    }

    function trimTail(p, size, cap) {
      try {
        const cut = host.files.trimTail(p, {
          capBytes: cap,
          keepBytes: KEEP_TAIL_BYTES,
        })
        if (!cut) return
        const name = p.slice(p.lastIndexOf("/") + 1)
        host.report(`${name} grew past ${Math.round(size / 1024)}KB — trimmed to its last 64KB`)
      } catch {
        host.report?.(
          `failed to trim ${p.slice(p.lastIndexOf("/") + 1)} — it keeps growing past its cap`,
        )
      }
    }
  },
}
