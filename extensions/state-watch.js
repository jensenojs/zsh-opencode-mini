// zsh-opencode-mini's state-dir watcher (policy only).
//
// The shell data dir holds one unbounded append-only writer the plugin
// itself documents as a knockout (bg.jsonl, ~60B/line spawn ledger) plus
// per-pid passthrough key logs that outlive their processes. Everything
// else is already bounded: history-*.jsonl rotates monthly with cleanup and
// an oversized-history notice, outbox.jsonl rotates at 64KB, notices.jsonl
// drains destructively, last-failure.json is overwritten in place.
//
// Trim semantics follow the outbox rotation philosophy: keep the tail,
// cut at a newline, tmp+mv; consumers tolerate at-least-once.

import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"

const BG_MAX_BYTES = 1024 * 1024 // trim bg.jsonl once past 1MB
const KEEP_TAIL_BYTES = 64 * 1024
const KEYLOG_AGE_MS = 7 * 24 * 60 * 60 * 1000 // keys.log older than a week
const SCAN_EVERY_N_DELTAS = 50 // one scan per ~50 requests, not per event

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
      let entries = []
      try {
        entries = readdirSync(host.dataDir)
      } catch {
        return
      }
      const now = Date.now()
      for (const f of entries) {
        const p = join(host.dataDir, f)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        if (f === "bg.jsonl") {
          if (st.size > BG_MAX_BYTES) trimTail(p, st.size)
        } else if (/^passthrough\.\d+\.keys\.log$/.test(f)) {
          if (now - st.mtimeMs > KEYLOG_AGE_MS) {
            try {
              unlinkSync(p)
            } catch {
              // gone by itself already — fine
            }
          }
        }
      }
    }

    function trimTail(p, size) {
      try {
        const buf = readFileSync(p)
        let start = Math.max(0, buf.length - KEEP_TAIL_BYTES)
        while (start < buf.length && buf[start] !== 0x0a) start++ // cut at a line boundary
        if (start < buf.length) start++
        const tmp = `${p}.${process.pid}.tmp`
        writeFileSync(tmp, buf.subarray(start))
        renameSync(tmp, p)
        host.report(`bg.jsonl grew past ${Math.round(size / 1024)}KB — trimmed to its last 64KB`)
      } catch {
        host.report?.("failed to trim bg.jsonl — it keeps growing past 1MB")
      }
    }
  },
}
