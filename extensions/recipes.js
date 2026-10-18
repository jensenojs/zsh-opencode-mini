// Recipes: declarative model calls fired from shell signals. Everything here
// is judgement — which signal fires which recipe, which triggers and delivery
// modes are legal, what the prompt says, when the rate gate closes, where the
// answer is delivered. The host only hands over the raw config table, parsed
// shell records, a model, a tool registry and the outbox.
const TRIGGERS = {
  failure: ["cmd", "exit", "cwd", "stderr"],
  manual: ["cmd", "exit", "cwd"],
  "bg-done": ["sid", "cwd"],
}
const DELIVER = ["next-session", "outbox"]
const NAME = /^[a-zA-Z0-9_-]+$/
const SLOT = /\{(\w+)\}/g

// A recipe whose `on` has no trigger, or whose prompt names a slot its trigger
// never supplies, would fire half-wired. Refuse the whole table loudly: one
// bad entry means the config author and the runtime disagree about the shape.
function compile(raw, defaultTtl, parseModel) {
  const out = {}
  for (const [name, r] of Object.entries(raw ?? {})) {
    if (!NAME.test(name)) {
      throw new Error(
        `recipe name ${JSON.stringify(name)} must match ${NAME} ` +
          `(it becomes a tool name and a storage/outbox key component).`,
      )
    }
    const slots = TRIGGERS[r?.on]
    if (!slots) {
      throw new Error(
        `recipe "${name}": unknown on value ${JSON.stringify(r?.on)} ` +
          `(expected one of ${Object.keys(TRIGGERS).join(", ")}).`,
      )
    }
    const unknown = [...new Set([...String(r?.prompt ?? "").matchAll(SLOT)].map((m) => m[1]))].filter(
      (s) => !slots.includes(s),
    )
    if (unknown.length > 0) {
      throw new Error(
        `recipe "${name}": prompt slot(s) ${unknown.map((s) => `{${s}}`).join(" ")} ` +
          `not provided by the ${JSON.stringify(r.on)} trigger (provides: ${slots.join(", ")}).`,
      )
    }
    if (!DELIVER.includes(r?.deliver)) {
      throw new Error(
        `recipe "${name}": unknown deliver value ${JSON.stringify(r?.deliver)} ` +
          `(expected one of ${DELIVER.join(", ")}).`,
      )
    }
    parseModel(r.model) // a bad model spec must not wait until fire time
    if (r.exitFilter !== undefined && !(Array.isArray(r.exitFilter) && r.exitFilter.every(Number.isInteger))) {
      throw new Error(`recipe "${name}": exitFilter must be an array of integers.`)
    }
    out[name] = { ...r, ttlSeconds: r.ttlSeconds ?? defaultTtl }
  }
  return out
}

export default {
  id: "recipes",
  setup(ctx, host) {
    let recipes
    try {
      recipes = compile(host.config.recipes, host.config.recipeTtlSeconds, host.model.parse)
    } catch (e) {
      // One bad recipe kills the whole table: half-wired is worse than absent,
      // and the reason has to reach the user through the usual channel.
      host.report(`config: ${e?.message ?? e}`)
      return
    }
    // Finished outputs waiting for the next session: minute-scale hints whose
    // lifetime is this process. In-memory because the context hook is
    // synchronous and no other process reads them.
    const pending = new Map()
    // One fire per background session, across processes: the claim file is
    // what makes "one" true beyond this instance.

    // Same renderer the config validator checked the slots against: a recipe
    // whose template changed shape between compile and fire cannot happen.
    const fill = (template, slots) => host.render(template, slots)

    // The one pipeline every trigger funnels through: rate gate, generate,
    // deliver. The gate sits before the call on purpose — a recipe's budget is
    // "this many model calls per hour", not "this many suggestions".
    const fire = async (name, recipe, slots) => {
      if (recipe.ratePerHour !== undefined) {
        const hour = Math.floor(Date.now() / 3_600_000)
        // One key per recipe, not one per hour: an hourly key is a new entry
        // every hour and nothing ever removes it. The bucket rolls over in
        // place instead.
        const key = `zom/rate/${name}`
        // One read-modify-write, and a failed write is loud: a gate that
        // cannot persist its count is off, not "probably fine". Two processes
        // racing two different events can still both pass the boundary — the
        // epoch claim keeps that to distinct events, not duplicated ones.
        let allowed
        try {
          allowed = host.kv.update(key, (prev) => {
            const used = prev && prev.hour === hour ? Number(prev.used ?? 0) : 0
            return used >= recipe.ratePerHour ? null : { hour, used: used + 1 }
          })
        } catch (e) {
          host.report(`rate gate could not be written: ${e?.message ?? e}`)
          return
        }
        if (allowed === null) return
      }
      let text
      try {
        text = await host.model.generate(
          host.model.parse(recipe.model),
          fill(recipe.prompt, slots),
        )
      } catch (e) {
        // A missing suggestion with no reason looks like a broken plugin:
        // failures travel the same channel as results.
        host.outbox.append({
          recipe: name,
          kind: "recipe-error",
          text: `recipe ${name} failed: ${e?.message ?? e}`,
        })
        return
      }
      if (recipe.deliver === "outbox") {
        host.outbox.append({ recipe: name, kind: "recipe", text })
      } else {
        pending.set(name, {
          text,
          ts: Math.floor(Date.now() / 1000),
          ttlSeconds: recipe.ttlSeconds,
        })
      }
    }

    // One shell failure can surface as several fs events (the file is replaced
    // atomically and the watcher sees both names). The epoch is the identity of
    // one failure — fire once per epoch, judged here because how many model
    // calls a failure is worth is a recipe decision.
    host.onFailure((sig) => {
      // The epoch is one failure; claiming it is what makes that true across
      // processes, not just inside this one.
      if (!host.files.claim(`failure-${sig.epoch}`)) return
      for (const [name, recipe] of Object.entries(recipes)) {
        if (recipe.on !== "failure") continue
        if (recipe.exitFilter && !recipe.exitFilter.includes(sig.exit)) continue
        void fire(name, recipe, {
          cmd: sig.cmd,
          exit: sig.exit,
          cwd: sig.cwd,
          stderr: sig.stderr ?? "",
        }).catch(() => {})
      }
    })

    host.onSessionExecution(({ sid }) => {
      const bg = Object.entries(recipes).filter(([, r]) => r.on === "bg-done")
      if (bg.length === 0) return
      const ledger = host.files.bgLedger()
      if (!ledger.has(sid)) return
      if (!host.files.claim(`bg-${sid}`)) return
      for (const [name, recipe] of bg) {
        void fire(name, recipe, { sid, cwd: ledger.get(sid) ?? "" }).catch(() => {})
      }
    })

    // Manual recipes are tools: the agent decides when to fire them.
    for (const [name, recipe] of Object.entries(recipes)) {
      if (recipe.on !== "manual") continue
      host.tool.add({
        name: `zom_recipe_${name}`,
        description: recipe.description || `Run the "${name}" recipe: ${fill(recipe.prompt, {})}`,
        input: {
          type: "object",
          properties: {
            cmd: { type: "string" },
            exit: { type: "number" },
            cwd: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          await fire(name, recipe, input)
          return { content: `recipe ${name} delivered via ${recipe.deliver}` }
        },
      })
    }

    ctx.session.hook("context", (event) => {
      const now = Math.floor(Date.now() / 1000)
      for (const [name, out] of pending) {
        if (now - out.ts > out.ttlSeconds) {
          pending.delete(name)
          continue
        }
        // The [zom:<name>] tag marks provenance: a plugin-generated heuristic
        // derived from shell events, not a user instruction.
        host.inject(event, `[zom:${name}] ${out.text}`)
      }
    })
  },
}
