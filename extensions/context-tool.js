// The zom_context tool: the agent's door to the shell history the zsh side
// records. What it returns, how it ranks, and what counts as "this terminal"
// are all judgement calls about records the host only knows how to parse.
export default {
  id: "context-tool",
  setup(ctx, host) {
    // "" on either side means "cannot tell" (legacy records, tty-less shells):
    // degrade to global-latest instead of hiding a real failure from everyone.
    const owned = (sigTty, summonTty) => !sigTty || !summonTty || sigTty === summonTty
    host.tool.add({
      name: "zom_context",
      description:
        "Read the user's zsh command history store (JSONL, recorded by the " +
        "zsh-opencode-mini plugin). query=last_failure returns the most recent " +
        "failed command recorded by THIS terminal (failures from other " +
        "terminal panes are not surfaced); query=recent returns the last N " +
        "commands, re-ranked so commands from the summoning directory come " +
        "first (exact cwd match, then its subdirectories, then the rest — " +
        "newest first within each group). Use when the user refers to 'the " +
        "command I just ran' or a failure they just saw. last_failure returns " +
        "the most recent failure regardless of age — check ts/ageSeconds/fresh " +
        "before assuming it is what the user means.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", enum: ["last_failure", "recent"] },
          n: { type: "number", description: "lines for query=recent" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input) => {
        // The newest spawn record is our best guess at this terminal; the host
        // hands over the facts, the guess is ours.
        const summon = host.files.spawns().at(-1)
        if (input.query === "last_failure") {
          const sig = host.files.lastFailure()
          if (!sig) return { content: "no failed command on record" }
          // Terminal scope: another pane's failure is not this summon's
          // business. No summon record at all (spawns.jsonl missing or
          // pre-tty) degrades to global-latest — the only honest answer
          // when the summoning terminal cannot be known.
          if (summon && !owned(sig.tty ?? "", summon.tty)) {
            return { content: "no failed command in this terminal" }
          }
          return {
            content: JSON.stringify({
              ...sig,
              fresh:
                sig.ageSeconds !== undefined &&
                sig.ageSeconds <= host.config.failureTtlSeconds,
            }),
          }
        }
        const n =
          Number(input.n) > 0 ? Math.floor(Number(input.n)) : host.config.recentDefaultN
        const records = host.files.historyTail(n)
        if (records.length === 0) return { content: "no history for the current month" }
        // Pool stays "N most recent"; ranking is read-time only. The summoning
        // directory's commands surface first (exact match, then its
        // subdirectories — segment-aware so /proj does not claim /project),
        // newest first within each group. No summon cwd on record → unchanged
        // order.
        let ordered = records
        if (summon?.cwd) {
          const root = summon.cwd.endsWith("/") ? summon.cwd : summon.cwd + "/"
          const rank = (cwd) => (cwd === summon.cwd ? 0 : cwd.startsWith(root) ? 1 : 2)
          ordered = records
            .map((r, i) => ({ ...r, i, rank: rank(r.cwd) }))
            .sort((a, b) => a.rank - b.rank || b.i - a.i)
        }
        return { content: ordered.map((r) => r.raw).join("\n") }
      },
    })
  },
}
