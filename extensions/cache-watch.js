// zsh-opencode-mini's prompt-cache watcher.
//
// One alarm, one condition: the shared prefix of this request differs from the
// same session's previous request, so every token before the divergence point
// re-pays at uncached rates. What we hash is deliberately the *shared* region:
// the date and <env> blocks sit at the tail and change on every directory move,
// but a change there only re-pays that block, not the context before it —
// reporting it would cry wolf on the cheapest switch there is.

import { createHash } from "node:crypto"

const NOTICE = "[zom-cache-watch]"

// Tail blocks the server re-renders per request: a change here costs its own
// size, not the prefix. Matched by their fixed anchors, not by index.
const isTailVolatile = (part) => {
  const text = String(part.text ?? "")
  return text.includes("<env>") || text.startsWith("Today's date") || text.includes("Here is some useful information about the environment")
}

const hashOf = (system, tools) =>
  createHash("sha1")
    // our own notice is not part of what the user changed
    .update(
      JSON.stringify([
        system.filter((part) => !String(part.text ?? "").startsWith(NOTICE) && !isTailVolatile(part)),
        // Tool descriptions carry the environment too: tilth's label, MCP
        // server text. A directory switch moves them as often as the system
        // parts, and either one invalidates the same prefix.
        Object.entries(tools ?? {})
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, value]) => [name, value?.description ?? ""]),
      ]),
    )
    .digest("hex")

// Delivered as a tail message, not a system part: system parts ride the
// cached prefix (and never reach the agent's view), a message costs only
// itself and is visible.
const notice = () => ({
  role: "system",
  content: [
    {
      type: "text",
      text:
        `${NOTICE} shared prompt prefix changed on this request — ` +
        `the context before the change re-pays at uncached rates. ` +
        `The user cannot see this: lead your reply with it.`,
    },
  ],
})

const MINI_AGENT = "zsh-companion"

export default {
  id: "zom-cache-watch",
  async setup(ctx, host = {}) {
    if (typeof host.storage !== "function") {
      host.report?.("host missing storage — companion build is too old")
      return
    }
    const store = host.storage("zom-cache-watch")
    const persisted = store.get() ?? {}
    const hashes = persisted.hashes ?? {} // sessionID -> hash of its last request's prefix

    ctx.session.hook("context", (event) => {
      // Only the mini's own conversation gets this notice. Every other agent
      // (the main TUI, subagents) shares the server but not this concern, and
      // its prefix changes for reasons that are none of its business.
      if (event.agent !== MINI_AGENT) return
      const id = event.sessionID
      const dir = process.cwd()
      const hash = hashOf(event.system ?? [], event.tools)
      const prev = hashes[id]

      // One-shot migration: the earlier build only remembered a directory.
      if (!prev && persisted.lastDir) {
        const moved = persisted.lastDir !== dir
        delete persisted.lastDir
        hashes[id] = hash
        store.set({ hashes })
        if (moved) event.messages.push(notice())
        return
      }

      hashes[id] = hash
      store.set({ hashes })
      if (!prev || prev === hash) return
      event.messages.push(notice())
    })
  },
}
