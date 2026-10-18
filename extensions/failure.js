// The user's last shell command failing is worth one line — but only while it
// is fresh, and only in the terminal that owns it. Both are judgement calls
// about a record the shell wrote, so they live here rather than in the host
// that parses the file.
export default {
  id: "failure",
  setup(ctx, host) {
    // "" on either side means "cannot tell" (legacy records, tty-less shells):
    // degrade to global-latest instead of hiding a real failure from everyone.
    const owned = (sigTty, summonTty) => !sigTty || !summonTty || sigTty === summonTty
    ctx.session.hook("context", (event) => {
      const sig = host.files.lastFailure()
      if (!sig || !Number.isFinite(sig.ageSeconds) || sig.ageSeconds < 0) return
      if (sig.ageSeconds > host.config.failureTtlSeconds) return
      const summon = host.files.spawns().at(-1)
      if (summon && !owned(sig.tty ?? "", summon.tty)) return
      // No relative age in the text: "12s ago" would differ on every request
      // and buy nothing — the tail already re-pays only its own tokens.
      host.inject(
        event,
        `[zsh-opencode-mini] the user's last shell command failed ` +
          `(exit ${sig.exit}, cwd ${sig.cwd}): ${sig.cmd}. ` +
          `The zom_context tool can pull more history if relevant.`,
      )
    })
  },
}
