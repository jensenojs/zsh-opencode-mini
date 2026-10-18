// The zsh side appends degraded-state facts (hook failures, oversized history)
// to notices.jsonl — states the user cannot perceive in daily use. Surfacing
// them at a natural point in the conversation is this extension's call; the
// host only knows how to read the file and consume it once.
export default {
  id: "notices",
  setup(ctx, host) {
    ctx.session.hook("context", (event) => {
      const notices = host.files.drainNotices()
      if (notices.length === 0) return
      // The producer may repeat a notice across shells; the same fact said
      // twice is one fact. Which repeats collapse is this extension's call.
      const unique = [...new Map(notices.map((n) => [`${n.kind} ${n.text}`, n])).values()]
      host.inject(
        event,
        `[zsh-opencode-mini] shell-side notices pending — degraded states the ` +
          `user cannot see in daily use; surface them proactively at a natural ` +
          `point in the conversation:\n` +
          unique.map((n) => `- [${n.kind}] ${n.text}`).join("\n"),
      )
    })
  },
}
