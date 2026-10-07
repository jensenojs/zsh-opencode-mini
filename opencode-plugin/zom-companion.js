// zsh-opencode-mini's opencode-side plugin ("companion").
//
// Platform: OpenCode V2 plugin API. This file's API surface was verified
// against https://opencode.ai/v2/docs/build/plugins on 2026-10-02:
//   - default export { id, setup(ctx) } (no import needed, works as a
//     single-file plugin in .opencode/plugins/ or via opencode.jsonc plugins[])
//   - ctx.app.version                      -> contract anchor
//   - ctx.tool.transform(editor => ...)    -> custom tool registration
//   - ctx.session.hook("context", ...)     -> system-prompt injection
//   - ctx.storage get/set/scan(key-based)  -> durable counters (rate limiting)
//   - ctx.generate.text({model, prompt})   -> session-less generation
//   - ctx.event.subscribe({signal})        -> AsyncIterable of server events
// If OpenCode ships a breaking plugin-API change, assertContract() below
// refuses to load with an explicit error instead of failing silently.
//
// Responsibilities (the zsh side owns recording; this file only consumes):
//   - zom_context tool: pull history lines / the last failure on demand
//   - context hook: inject a one-line hint ONLY while the last failure is
//     fresh (lazy loading — no history is pushed into context by default),
//     plus finished recipe outputs, each tagged with its [zom:<name>] origin
//   - recipes: declarative model calls fired from shell signals (watching
//     last-failure.json), delivered into next-session injection or the
//     outbox — the zsh side reads outbox.jsonl via its byte cursor
//   - zom-bg notifications: watch session.execution.* for background sessions
//     recorded in bg.jsonl and append {kind:"bg-done"} lines to the outbox

import {
  readFileSync,
  existsSync,
  watch,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULTS = {
  failureTtlSeconds: 600,
  recentDefaultN: 20,
  recipeTtlSeconds: 900,
}

// The three trigger sources and the template slots each one actually
// substitutes at its fire site: failure -> fireFailureRecipes (the
// last-failure.json watcher), manual -> the zom_recipe_<name> tools (the
// input schema at registration), bg-done -> the session.execution.* event
// loop. The keys are the entire legal `on` vocabulary: a recipe whose `on`
// has no entry here could never fire, and a template slot outside its
// trigger's set would render as "" at fire time — compileRecipes refuses
// both loudly instead of wiring either half-silent.
const TRIGGERS = {
  failure: { slots: ["cmd", "exit", "cwd"] },
  manual: { slots: ["cmd", "exit", "cwd"] },
  "bg-done": { slots: ["sid", "cwd"] },
}
const RECIPE_DELIVER = ["next-session", "outbox"]
const RECIPE_NAME = /^[a-zA-Z0-9_-]+$/

// Whole-line comments only — same parsing convention as the zsh side.
// (Deliberately not a full jsonc parser: the config contract forbids "//"
// inside string values, stated in config.example.jsonc.)
function parseConfig(text) {
  return JSON.parse(text.replace(/^[ \t]*\/\/.*$/gm, ""))
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "zsh-opencode-mini", "config.jsonc")
}

function loadConfig() {
  const p = configPath()
  if (!existsSync(p)) return {}
  try {
    return parseConfig(readFileSync(p, "utf8"))
  } catch (e) {
    throw new Error(
      `[zsh-companion] failed to parse ${p}: ${e.message}. ` +
        `Fix the file or remove it to run on defaults.`,
    )
  }
}

function shellDataDir(cfg) {
  const fromConfig = cfg?.shell?.dataDir
  if (typeof fromConfig === "string" && fromConfig.length > 0) {
    return fromConfig.startsWith("~") ? join(homedir(), fromConfig.slice(1)) : fromConfig
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "zsh-opencode-mini")
}

// "provider/model-id" — the config-facing shape — becomes the API object.
function parseModel(spec) {
  const idx = String(spec ?? "").indexOf("/")
  if (idx <= 0 || idx === String(spec).length - 1) {
    throw new Error(
      `[zsh-companion] recipe model must be "provider/model-id", got: ${JSON.stringify(spec)}`,
    )
  }
  return { providerID: spec.slice(0, idx), id: spec.slice(idx + 1) }
}

function compileRecipes(raw) {
  const out = {}
  for (const [name, r] of Object.entries(raw ?? {})) {
    if (!RECIPE_NAME.test(name)) {
      throw new Error(
        `[zsh-companion] recipe name ${JSON.stringify(name)} must match ${RECIPE_NAME} ` +
          `(it becomes a tool name and a storage/outbox key component).`,
      )
    }
    const trigger = TRIGGERS[r?.on]
    if (!trigger) {
      throw new Error(
        `[zsh-companion] recipe "${name}": unknown on value ${JSON.stringify(r?.on)} ` +
          `(expected one of ${Object.keys(TRIGGERS).join(", ")}).`,
      )
    }
    // Same slot syntax fill() substitutes — validating the exact pattern the
    // runtime will replace keeps compile and fire from drifting apart.
    const unknownSlots = [
      ...new Set(
        [...String(r?.prompt ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      ),
    ].filter((s) => !trigger.slots.includes(s))
    if (unknownSlots.length > 0) {
      throw new Error(
        `[zsh-companion] recipe "${name}": prompt slot(s) ` +
          `${unknownSlots.map((s) => `{${s}}`).join(" ")} not provided by the ` +
          `${JSON.stringify(r.on)} trigger (provides: ${trigger.slots.join(", ")}).`,
      )
    }
    if (!RECIPE_DELIVER.includes(r?.deliver)) {
      throw new Error(
        `[zsh-companion] recipe "${name}": unknown deliver value ${JSON.stringify(r?.deliver)} ` +
          `(expected one of ${RECIPE_DELIVER.join(", ")}).`,
      )
    }
    parseModel(r.model) // validate now; recipes never fire with a bad model spec
    if (r.exitFilter !== undefined && !(Array.isArray(r.exitFilter) && r.exitFilter.every(Number.isInteger))) {
      throw new Error(`[zsh-companion] recipe "${name}": exitFilter must be an array of integers.`)
    }
    out[name] = { ...r, ttlSeconds: r.ttlSeconds ?? DEFAULTS.recipeTtlSeconds }
  }
  return out
}

// --- API contract ----------------------------------------------------------
// Built for plugin API major version 2. Anchor on the running version and
// probe every surface we call, so a breaking upstream change fails loudly
// at load time with a message that says what to re-check.
const CONTRACT = {
  major: 2,
  verified: "2026-10-02",
  docs: "https://opencode.ai/v2/docs/build/plugins",
  surfaces: [
    ["ctx.app.version", (ctx) => typeof ctx?.app?.version === "string"],
    ["ctx.tool.transform", (ctx) => typeof ctx?.tool?.transform === "function"],
    ["ctx.session.hook", (ctx) => typeof ctx?.session?.hook === "function"],
  ],
}

function assertContract(ctx, extraSurfaces = []) {
  const version = String(ctx?.app?.version ?? "")
  const major = Number(version.split(".")[0])
  if (major !== CONTRACT.major) {
    throw new Error(
      `[zsh-companion] plugin API mismatch: built for V${CONTRACT.major}, ` +
        `running on OpenCode ${version || "<version unreadable>"}. ` +
        `Refusing to load half-working. Re-verify against ${CONTRACT.docs} ` +
        `(last verified ${CONTRACT.verified}).`,
    )
  }
  for (const [name, probe] of [...CONTRACT.surfaces, ...extraSurfaces]) {
    if (!probe(ctx)) {
      throw new Error(
        `[zsh-companion] missing plugin API surface: ${name} (OpenCode ${version}). ` +
          `The V2 plugin API shape has changed — re-verify against ${CONTRACT.docs}.`,
      )
    }
  }
}

// --- failure signal --------------------------------------------------------

function readFailureSignal(dataDir, ttlSeconds) {
  const p = join(dataDir, "last-failure.json")
  if (!existsSync(p)) return undefined
  try {
    const sig = JSON.parse(readFileSync(p, "utf8"))
    const age = Math.floor(Date.now() / 1000) - Number(sig.epoch)
    if (!Number.isFinite(age) || age < 0 || age > ttlSeconds) return undefined
    return { ...sig, ageSeconds: age, fresh: age <= ttlSeconds }
  } catch {
    return undefined // unreadable signal file is not worth crashing a model call over
  }
}

// Unfiltered read for the explicit tool query: age is returned, never enforced —
// an old failure is still evidence when the user asks for it directly.
function readLastFailure(dataDir) {
  const p = join(dataDir, "last-failure.json")
  if (!existsSync(p)) return undefined
  try {
    const sig = JSON.parse(readFileSync(p, "utf8"))
    const age = Math.floor(Date.now() / 1000) - Number(sig.epoch)
    return { ...sig, ageSeconds: Number.isFinite(age) ? age : undefined }
  } catch {
    return undefined
  }
}

// --- plugin ----------------------------------------------------------------

export default {
  id: "zom-companion",
  setup(ctx) {
    // One parse per load (the config feeds contract probes, companion config,
    // dataDir and recipes alike).
    const fullCfg = loadConfig()
    const cfg = { ...DEFAULTS, ...fullCfg?.companion }
    const dataDir = shellDataDir(fullCfg)
    const recipes = compileRecipes(fullCfg?.recipes)
    const hasRecipes = Object.keys(recipes).length > 0
    const monthFile = () =>
      join(dataDir, `history-${new Date().toISOString().slice(0, 7)}.jsonl`)

    // Probe exactly what this configuration will touch: bg-done watching is
    // always on, generation/storage only when recipes can fire.
    const extraSurfaces = [
      ["ctx.event.subscribe", (c) => typeof c?.event?.subscribe === "function"],
    ]
    if (hasRecipes) {
      extraSurfaces.push(
        ["ctx.generate.text", (c) => typeof c?.generate?.text === "function"],
        [
          "ctx.storage",
          (c) =>
            typeof c?.storage?.get === "function" && typeof c?.storage?.set === "function",
        ],
      )
    }
    assertContract(ctx, extraSurfaces)

    // The watcher and the outbox writer both need the directory to exist; the
    // zsh side creates it too, so this is idempotent.
    mkdirSync(dataDir, { recursive: true })

    const outboxPath = join(dataDir, "outbox.jsonl")
    // Outbox growth is capped by rotation, not by a backup file: these are
    // minute-scale hints the drain prints once (DESIGN.md declares notices
    // tolerable to duplication and loss), so a rotated-out .1 file would be
    // a second owner of disposable data.
    const rotateOutbox = () => {
      if (!existsSync(outboxPath)) return
      const buf = readFileSync(outboxPath)
      if (buf.length <= 1_000_000) return
      // Keep complete lines only: drop a torn tail (a crashed append), then
      // cut the head at the first newline at/after the 64KB tail budget.
      let end = buf.length
      if (buf[end - 1] !== 0x0a) end = buf.lastIndexOf(0x0a) + 1
      let start = Math.max(0, end - 64 * 1024)
      if (start > 0) {
        const nl = buf.indexOf(0x0a, start)
        start = nl === -1 ? end : nl + 1
      }
      // tmp+mv replace (the last-failure.json protocol): a drain holding an
      // open fd finishes reading the old inode instead of a truncated file.
      const tmp = `${outboxPath}.tmp`
      writeFileSync(tmp, buf.subarray(start, end))
      renameSync(tmp, outboxPath)
    }
    // Rotation vs the zsh byte cursor (outbox.cursor, owned by zsh-side
    // __zom_outbox_drain): after rotating, the file is ≤64KB, so a cursor
    // beyond it trips the drain's "cursor > size → start over" reset and the
    // retained tail replays once — at-least-once, which the drain already
    // tolerates; only the dropped prefix is truly gone. The narrow window
    // where a cursor sits below the rotated size points into renamed content
    // and costs at most one unparsable-line warning (the drain skips it and
    // advances). The cursor stays zsh-owned; this side never writes it.
    const appendOutbox = (record) => {
      rotateOutbox()
      appendFileSync(
        outboxPath,
        JSON.stringify({ id: randomUUID(), ts: new Date().toISOString(), ...record }) + "\n",
      )
    }

    // Finished recipe outputs waiting for the next session. In-memory on
    // purpose: the context hook is synchronous (async hook handlers are an
    // unverified platform behavior), and these outputs are minute-scale hints
    // whose lifetime is the plugin process — there is no cross-process reader,
    // so durable storage would be a second owner of a disposable fact.
    const outputs = new Map()

    const fill = (template, slots) =>
      String(template ?? "").replace(/\{(\w+)\}/g, (m, key) => (slots[key] ?? ""))

    // The one recipe pipeline: gate on rate, generate, deliver. All trigger
    // sources (failure watch, bg-done event, manual tool) funnel through here.
    const fireRecipe = async (name, recipe, slots) => {
      if (recipe.ratePerHour !== undefined) {
        const hour = Math.floor(Date.now() / 3_600_000)
        const key = `zom/rate/${name}/${hour}`
        const fired = Number((await ctx.storage.get(key)) ?? 0)
        if (fired >= recipe.ratePerHour) return
        await ctx.storage.set(key, fired + 1)
      }
      let text
      try {
        const out = await ctx.generate.text({
          model: parseModel(recipe.model),
          prompt: fill(recipe.prompt, slots),
        })
        // The docs page pins the call shape but not the return shape (checked
        // 2026-10-02); accept either a bare string or a {text} envelope until
        // a real-runtime check settles it.
        text = typeof out === "string" ? out : String(out?.text ?? "")
      } catch (e) {
        // Recipe failures are user-visible through the same channel as their
        // results — a missing suggestion with no reason looks like a bug.
        appendOutbox({ recipe: name, kind: "recipe-error", text: `recipe ${name} failed: ${e.message}` })
        return
      }
      if (recipe.deliver === "outbox") {
        appendOutbox({ recipe: name, kind: "recipe", text })
      } else {
        outputs.set(name, { text, ts: Math.floor(Date.now() / 1000), ttlSeconds: recipe.ttlSeconds })
      }
    }

    // Recipes with on:"failure" share one trigger path: the watcher reads the
    // signal once and hands it over — exit filtering and slot filling happen
    // per recipe, generation is fireRecipe's job.
    const fireFailureRecipes = (sig) => {
      for (const [name, recipe] of Object.entries(recipes)) {
        if (recipe.on !== "failure") continue
        if (recipe.exitFilter && !recipe.exitFilter.includes(sig.exit)) continue
        void fireRecipe(name, recipe, { cmd: sig.cmd, exit: sig.exit, cwd: sig.cwd }).catch(() => {})
      }
    }

    // Custom tool: on-demand history access (lazy — the AI decides when to look).
    ctx.tool.transform((editor) => {
      editor.add({
        name: "zom_context",
        description:
          "Read the user's zsh command history store (JSONL, recorded by the " +
          "zsh-opencode-mini plugin). query=last_failure returns the most recent " +
          "failed command; query=recent returns the last N commands. Use when the " +
          "user refers to 'the command I just ran' or a failure they just saw. " +
          "last_failure returns the most recent failure regardless of age — check " +
          "ts/ageSeconds/fresh before assuming it is what the user means.",
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
          if (input.query === "last_failure") {
            const sig = readLastFailure(dataDir)
            if (!sig) return { content: "no failed command on record" }
            return {
              content: JSON.stringify({
                ...sig,
                fresh: sig.ageSeconds !== undefined && sig.ageSeconds <= cfg.failureTtlSeconds,
              }),
            }
          }
          const n = Number(input.n) > 0 ? Math.floor(Number(input.n)) : cfg.recentDefaultN
          const p = monthFile()
          if (!existsSync(p)) return { content: "no history for the current month" }
          const lines = readFileSync(p, "utf8").trim().split("\n").slice(-n)
          return { content: lines.join("\n") }
        },
      })

      // Manual recipes become tools: the agent is the trigger source.
      for (const [name, recipe] of Object.entries(recipes)) {
        if (recipe.on !== "manual") continue
        editor.add({
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
            await fireRecipe(name, recipe, input)
            return { content: `recipe ${name} delivered via ${recipe.deliver}` }
          },
        })
      }
    })

    // Heuristic injection: only when a failure signal is fresh, plus finished
    // recipe outputs still inside their TTL. Default (no signals) = zero
    // injection. One line max per signal — the tool above is the door to more.
    ctx.session.hook("context", (event) => {
      const now = Math.floor(Date.now() / 1000)
      const sig = readFailureSignal(dataDir, cfg.failureTtlSeconds)
      if (sig) {
        event.system.push({
          type: "text",
          text:
            `[zsh-opencode-mini] the user's last shell command failed ${sig.ageSeconds}s ago ` +
            `(exit ${sig.exit}, cwd ${sig.cwd}): ${sig.cmd}. ` +
            `The zom_context tool can pull more history if relevant.`,
        })
      }
      for (const [name, out] of outputs) {
        if (now - out.ts > out.ttlSeconds) { outputs.delete(name); continue }
        event.system.push({
          type: "text",
          // The [zom:<name>] tag marks provenance: this is a plugin-generated
          // heuristic derived from shell events, not a user instruction.
          text: `[zom:${name}] ${out.text}`,
        })
      }
    })

    // Failure watcher. last-failure.json is atomically replaced (tmp+mv), so
    // watch the directory and filter by filename — watching the file itself
    // would follow the old inode and go quiet after the first replace.
    let lastFiredEpoch
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename !== "last-failure.json") return
      const sig = readFailureSignal(dataDir, Infinity)
      // The same failure file can surface as several fs events; the epoch is
      // the identity of one shell failure — fire once per epoch.
      if (!sig || sig.epoch === lastFiredEpoch) return
      lastFiredEpoch = sig.epoch
      fireFailureRecipes(sig)
    })

    // zom-bg completion notifications: watch server events for sessions the
    // shell spawned into background (bg.jsonl is the zsh-side ledger).
    // One execution = one finished task. Verified against a real runtime
    // (opencode 2.0.21, 2026-10-01, full event dump): events arrive as
    // {id, created, type, durable, location?, data}, session.status does NOT
    // exist, and the terminal signal is session.execution.succeeded with
    // data = {sessionID}. session.execution.failed exists as a pair but its
    // data shape is unverified (no failure sample) — we notify only when a
    // sessionID is readable, otherwise silently skip (see README limits).
    const bgLedger = () => {
      const p = join(dataDir, "bg.jsonl")
      if (!existsSync(p)) return new Map()
      const map = new Map() // sid -> cwd at spawn time
      for (const line of readFileSync(p, "utf8").split("\n")) {
        try {
          if (line.trim()) { const r = JSON.parse(line); map.set(r.sid, r.cwd) }
        } catch {} // a torn ledger line is not worth failing the stream over
      }
      return map
    }
    const bgAbort = new AbortController()
    // A notification means "this background task finished" — one-shot per sid.
    // Events are re-delivered by every server instance (same evt id seen 4x),
    // and an attached session emits a new execution per turn; without this
    // set each of those would re-notify.
    const bgNotified = new Set()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: bgAbort.signal })) {
          // ev.data is the verified v2 envelope; ev.properties kept as
          // older-wire tolerance, bare ev as last resort.
          const p = ev?.data ?? ev?.properties ?? ev
          const failed = ev?.type === "session.execution.failed"
          if (ev?.type !== "session.execution.succeeded" && !failed) continue
          const sid = p?.sessionID
          if (!sid) continue // failed-path data shape unverified; stay silent
          const ledger = bgLedger()
          if (!ledger.has(sid)) continue
          if (bgNotified.has(sid)) continue
          bgNotified.add(sid)
          appendOutbox({
            kind: "bg-done",
            sid,
            ok: !failed,
            text: `background session ${sid} finished${failed ? " with error" : ""}`,
          })
          for (const [name, recipe] of Object.entries(recipes)) {
            if (recipe.on !== "bg-done") continue
            void fireRecipe(name, recipe, { sid, cwd: ledger.get(sid) ?? "" }).catch(() => {})
          }
        }
      } catch (e) {
        if (!bgAbort.signal.aborted) {
          console.error(`[zsh-companion] event stream ended unexpectedly: ${e?.message ?? e}`)
        }
      }
    })()

    return () => {
      watcher.close()
      bgAbort.abort()
    }
  },
}
