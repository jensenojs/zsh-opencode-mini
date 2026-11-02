// zsh-opencode-mini's prompt-cache watcher.
//
// One alarm, one condition: in the same directory, the shared prefix of this
// request differs from the same session's previous request, so every token
// before the divergence point re-pays at uncached rates.
//
// The environment is compared by identity, not by text. A prompt renders the
// project name many times over — instruction files, MCP server labels, tool
// descriptions — and recognising any of them would tie this extension to one
// user's configuration. A different directory replaces the baseline instead:
// a new environment has nothing to compare against, and whatever moved is that
// environment's rendering, not a change to this conversation.

import { createHash } from "node:crypto"

const NOTICE = "[zom-cache-watch]"

const hashOf = (system, tools) =>
  createHash("sha1")
    // our own notice is not part of what the user changed
    .update(
      JSON.stringify([
        system.filter((part) => !String(part.text ?? "").startsWith(NOTICE)),
        // Tool descriptions are part of the same prefix: an MCP server's
        // schema edit re-pays everything after it even when no prose moved.
        // Hashing only the system text would stay quiet through that.
        Object.entries(tools ?? {})
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, value]) => [
            name,
            value?.description ?? "",
            value?.parameters ?? value?.inputSchema ?? value?.schema ?? null,
          ]),
      ]),
    )
    .digest("hex")

// Delivered as a tail message, not a system part: system parts ride the
// cached prefix (and never reach the agent's view), a message costs only
// itself and is visible.
// The text is delivered through host.inject (a tail message), not pushed onto
// the event by hand: one channel, so "where does this land" has one answer.
const noticeText = () =>
  `${NOTICE} shared prompt prefix changed on this request — ` +
  `the context before the change re-pays at uncached rates. ` +
  `The user cannot see this: lead your reply with it.`


export default {
  id: "zom-cache-watch",
  async setup(ctx, host = {}) {
    if (typeof host.storage !== "function") {
      host.report?.("host missing storage — companion build is too old")
      return
    }
    // The environment's identity comes from the host, not from the prompt and
    // not from process.cwd(): the plugin runs in a shared server whose working
    // directory is wherever it was launched, not the session's.
    if (typeof host.directory !== "string") {
      host.report?.("host missing directory — companion build is too old")
      return
    }
    const store = host.storage("zom-cache-watch")
    const persisted = store.get() ?? {}
    // sessionID -> { dir, hash }: the baseline is only valid inside the
    // directory it was taken in.
    const baselines = persisted.baselines ?? {}
    // One key per session, never removed: a long-lived install accumulates
    // sessions it will never see again. JSON preserves insertion order, so the
    // front is least recently touched.
    const HASH_CAP = 128
    const remember = (id, dir, hash) => {
      delete baselines[id]
      baselines[id] = { dir, hash }
      const keys = Object.keys(baselines)
      for (const k of keys.slice(0, Math.max(0, keys.length - HASH_CAP))) delete baselines[k]
      store.set({ baselines })
    }

    ctx.session.hook("context", (event) => {
      // Only the mini's own conversation gets this notice. Every other agent
      // (the main TUI, subagents) shares the server but not this concern, and
      // its prefix changes for reasons that are none of its business.
      if (event.agent !== host.agent) return
      const id = event.sessionID
      const dir = host.directory
      const hash = hashOf(event.system ?? [], event.tools)
      const prev = baselines[id]

      // A different directory is a different environment. The parts that
      // moved are that environment's rendering, so there is no baseline to
      // compare this request against, and nothing to tell the user.
      if (!prev || prev.dir !== dir) {
        remember(id, dir, hash)
        return
      }
      if (prev.hash === hash) return
      remember(id, dir, hash)
      host.inject(event, noticeText())
    })
  },
}
