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
//     recorded in bg.jsonl; each finish is appended to the outbox AND queued
//     for in-session injection at the next context hook. The zsh drain skips
//     outbox records already injected (bg-injected.json is the handshake).
//   - notices: drain shell-side degraded-state facts (notices.jsonl) into the
//     context injection so the next session surfaces them to the user

import {
  readFileSync,
  existsSync,
  watch,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULTS = {
  failureTtlSeconds: 600,
  recentDefaultN: 20,
  recipeTtlSeconds: 900,
  // Identical failures of one command within a day that trigger a single
  // outbox hint. 0 disables.
  repeatFailureThreshold: 3,
}

// The three trigger sources and the template slots each one actually
// substitutes at its fire site: failure -> fireFailureRecipes (the
// last-failure.json watcher), manual -> the zom_recipe_<name> tools (the
// input schema at registration), bg-done -> the session.execution.* event
// loop. The keys are the entire legal `on` vocabulary: a recipe whose `on`
// has no entry here could never fire, and a template slot outside its
// trigger's set would render as "" at fire time — compileRecipes refuses
// both loudly instead of wiring either half-silent. failure.stderr is the
// bounded stderr tail the zsh side stores into last-failure.json (may be ""
// when stderr capture is off or nothing was written).
const TRIGGERS = {
  failure: { slots: ["cmd", "exit", "cwd", "stderr"] },
  manual: { slots: ["cmd", "exit", "cwd"] },
  "bg-done": { slots: ["sid", "cwd"] },
}
const RECIPE_DELIVER = ["next-session", "outbox"]
const RECIPE_NAME = /^[a-zA-Z0-9_-]+$/

// The config is TOML, parsed by python's tomllib — the same parser the zsh
// launcher uses, so the two halves can never disagree about the document.
const TOML_JSON = [
  "import json, sys, tomllib",
  "try:",
  "    with open(sys.argv[1], 'rb') as handle:",
  "        data = tomllib.load(handle)",
  "except Exception as exc:",
  "    sys.stderr.write(str(exc))",
  "    raise SystemExit(1)",
  "json.dump(data, sys.stdout)",
].join("\n")

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "zsh-opencode-mini", "config.toml")
}

// tomllib is 3.11+; the first python3 on PATH can be an older interpreter
// (project virtualenv, distro python3.10) and then every read looks like a
// broken config. Mirror the zsh side: try, in order, and cache the winner.
let python
function tomlPython() {
  if (python) return python
  const candidates = [process.env.ZOM_PYTHON, "python3", "python3.14", "python3.13", "python3.12", "python3.11"]
  for (const candidate of candidates) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ["-c", "import tomllib"], { encoding: "utf8" })
    if (probe.status === 0) {
      python = candidate
      return python
    }
  }
  return undefined
}

function loadConfig() {
  const p = configPath()
  if (!existsSync(p)) return {}
  const interpreter = tomlPython()
  if (!interpreter) {
    throw new Error(
      `[zsh-companion] no python3 with tomllib (3.11+) found for ${p}. ` +
        `Set ZOM_PYTHON=/path/to/python3 or install one.`,
    )
  }
  const run = spawnSync(interpreter, ["-c", TOML_JSON, p], { encoding: "utf8" })
  if (run.error) throw new Error(`[zsh-companion] failed to run ${interpreter} for ${p}: ${run.error.message}`)
  if (run.status !== 0) {
    throw new Error(
      `[zsh-companion] failed to parse ${p}: ${(run.stderr || "").trim()}. ` +
        `Fix the file or remove it to run on defaults.`,
    )
  }
  return JSON.parse(run.stdout)
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

// The zom fork stamps its own builds as 0.0.0-zom-<build>, so the semver
// major carries no information about the plugin API generation. Treat that
// channel as V2 and let the surface probes below be the real gate — a
// breaking upstream change still trips them.
const CHANNEL_BUILD = /^0\.0\.0-zom(?:-|$)/

function assertContract(ctx, extraSurfaces = []) {
  const version = String(ctx?.app?.version ?? "")
  const major = Number(version.split(".")[0])
  if (major !== CONTRACT.major && !CHANNEL_BUILD.test(version)) {
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

// The summon identity: which shell (tty, cwd) spawned the session now asking.
// The zsh side stamps every spawn into spawns.jsonl; the last mini/last line
// is this session's summon — last-summon-wins, the same accepted imprecision
// as the failure signal itself (two minis in two panes share one server and
// one data dir). No file or no usable line (old mini builds wrote neither
// tty nor cwd): undefined, and every consumer degrades to global-latest.
function readLastSummon(dataDir) {
  const p = join(dataDir, "spawns.jsonl")
  if (!existsSync(p)) return undefined
  let last
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.kind === "mini" || r.kind === "last") last = r
      } catch {} // torn line, same tolerance as every other jsonl read here
    }
  } catch {
    return undefined
  }
  return last ? { tty: String(last.tty ?? ""), cwd: String(last.cwd ?? "") } : undefined
}

// tty ownership, companion side — mirror of the zsh-side __zom_tty_owned so
// the two ends can never disagree about who owns a failure. "" on either side
// means "cannot tell" (legacy records without the field, missing
// spawns.jsonl, tty-less shells) and degrades to the old global-latest
// behaviour instead of hiding a real failure from everyone.
function ttyOwned(sigTty, summonTty) {
  return !sigTty || !summonTty || sigTty === summonTty
}

// --- shell-side notices ----------------------------------------------------
// The zsh side appends degraded-state facts (hook failures, oversized
// history) to notices.jsonl — states the user cannot perceive in daily use.
// Drained into the context injection on the next session: the model surfaces
// them naturally, no popup, no interruption. Consumption is destructive
// (tmp+mv truncate): the file self-cleans and there is no cursor to keep in
// sync. An append racing the truncate lands on the old inode and is lost —
// tolerated, same philosophy as the outbox.
function drainNotices(dataDir) {
  const p = join(dataDir, "notices.jsonl")
  if (!existsSync(p)) return []
  const raw = readFileSync(p, "utf8")
  const seen = new Map() // kind+text -> latest record (producer may repeat across shells)
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      seen.set(`${r.kind} ${r.text}`, r)
    } catch {} // a torn line is not worth failing the injection over
  }
  const tmp = `${p}.tmp`
  writeFileSync(tmp, "")
  renameSync(tmp, p)
  return [...seen.values()]
}

// Repeated-failure awareness. Every non-zero exit already wakes the failure
// watcher, so counting costs one read of a bounded store. Exact-string match
// on the command — a changed argument is a different command; that is the
// documented granularity limit of this heuristic.
function countTodayFailures(monthPath, cmd) {
  if (!existsSync(monthPath)) return 0
  const d = new Date()
  const today =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` +
    `-${String(d.getDate()).padStart(2, "0")}`
  let n = 0
  for (const line of readFileSync(monthPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.cmd === cmd && r.exit !== 0 && typeof r.ts === "string" && r.ts.startsWith(today)) n++
    } catch {} // a torn line is skipped, same as everywhere else
  }
  return n
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
    // The zsh side names the file by local month (strftime); toISOString is
    // UTC and would read the wrong file in the hours after a local month
    // rollover.
    const monthFile = () => {
      const d = new Date()
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      return join(dataDir, `history-${m}.jsonl`)
    }

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

    // Background-session finish notices waiting for the next context hook.
    // Same lifetime argument as `outputs`: minute-scale hints consumed by the
    // in-process hook. The context hook only ever runs for a live session,
    // so the queue is consumed exactly when a session can hear it — that IS
    // the "active session" gate, no session registry needed. A notice that
    // arrives with no session open waits for the next one and is dropped
    // once older than the failure TTL (the outbox copy still reached the
    // shell prompt meanwhile).
    const bgDoneQueue = []
    // Cross-process handshake with the zsh side's __zom_outbox_drain: a
    // bg-done injected here must not ALSO print as `zom: ...` at the shell
    // prompt, so injection records {sid: epoch} in this file and the drain
    // skips records whose sid was injected within the failure TTL (the same
    // key both sides read for freshness). Written only when an injection
    // actually happened; a drain that ran earlier still prints — the accepted
    // duplication is documented on the zsh side.
    const bgInjectedPath = join(dataDir, "bg-injected.json")
    const markBgInjected = (sid) => {
      let cur = {}
      try { cur = JSON.parse(readFileSync(bgInjectedPath, "utf8")) } catch {}
      cur[sid] = Math.floor(Date.now() / 1000)
      const tmp = `${bgInjectedPath}.tmp`
      writeFileSync(tmp, JSON.stringify(cur))
      renameSync(tmp, bgInjectedPath)
    }

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
        void fireRecipe(name, recipe, { cmd: sig.cmd, exit: sig.exit, cwd: sig.cwd, stderr: sig.stderr ?? "" }).catch(() => {})
      }
    }

    // Custom tool: on-demand history access (lazy — the AI decides when to look).
    ctx.tool.transform((editor) => {
      editor.add({
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
          if (input.query === "last_failure") {
            const sig = readLastFailure(dataDir)
            if (!sig) return { content: "no failed command on record" }
            // Terminal scope: another pane's failure is not this summon's
            // business. No summon record at all (spawns.jsonl missing or
            // pre-tty) degrades to global-latest — the only honest answer
            // when the summoning terminal cannot be known.
            const summon = readLastSummon(dataDir)
            if (summon && !ttyOwned(sig.tty ?? "", summon.tty)) {
              return { content: "no failed command in this terminal" }
            }
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
          // Pool stays "N most recent"; ranking is read-time only. The
          // summoning directory's commands surface first (exact match, then
          // its subdirectories — segment-aware so /proj does not claim
          // /project), newest first within each group. No summon cwd on
          // record → unchanged order.
          let lines = readFileSync(p, "utf8").trim().split("\n").slice(-n)
          const summon = readLastSummon(dataDir)
          if (summon?.cwd) {
            const root = summon.cwd.endsWith("/") ? summon.cwd : summon.cwd + "/"
            const cwdOf = (line) => {
              try { return String(JSON.parse(line).cwd ?? "") } catch { return "" }
            }
            const rank = (cwd) => (cwd === summon.cwd ? 0 : cwd.startsWith(root) ? 1 : 2)
            lines = lines
              .map((line, i) => ({ line, i, rank: rank(cwdOf(line)) }))
              .sort((a, b) => a.rank - b.rank || b.i - a.i)
              .map((e) => e.line)
          }
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
      // Same terminal scope as the tool: another pane's failure must not enter
      // this summon's context. Without a summon record the injection keeps the
      // old global-latest behaviour (degradation, not a new gate to fail).
      const summon = readLastSummon(dataDir)
      if (sig && (!summon || ttyOwned(sig.tty ?? "", summon.tty))) {
        event.system.push({
          type: "text",
          text:
            `[zsh-opencode-mini] the user's last shell command failed ${sig.ageSeconds}s ago ` +
            `(exit ${sig.exit}, cwd ${sig.cwd}): ${sig.cmd}. ` +
            `The zom_context tool can pull more history if relevant.`,
        })
      }
      const notices = drainNotices(dataDir)
      if (notices.length > 0) {
        event.system.push({
          type: "text",
          text:
            `[zsh-opencode-mini] shell-side notices pending — degraded states the ` +
            `user cannot see in daily use; surface them proactively at a natural ` +
            `point in the conversation:\n` +
            notices.map((n) => `- [${n.kind}] ${n.text}`).join("\n"),
        })
      }
      // Background-session finishes (see the bgDoneQueue contract above).
      // One system entry per hook at most; stale entries are dropped without
      // a marker write — the outbox copy already reached the shell.
      const bgDone = []
      while (bgDoneQueue.length > 0) {
        const item = bgDoneQueue.shift()
        if (now - item.ts > cfg.failureTtlSeconds) continue
        bgDone.push(item)
        markBgInjected(item.sid)
      }
      if (bgDone.length > 0) {
        event.system.push({
          type: "text",
          text:
            `[zsh-opencode-mini] background session(s) finished (the shell ` +
            `prompt will not repeat these):\n` +
            bgDone.map((b) =>
              `- ${b.sid}${b.ok ? "" : " (with error)"} in ${b.cwd || "unknown cwd"}`,
            ).join("\n"),
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
      // Repeat-failure hint: counts are monotone within a day, so
      // count === threshold fires exactly once per command per day. This is
      // the aggregation a human cannot do from the seat — each failure is
      // visible, "the third one today" is not.
      const threshold = cfg.repeatFailureThreshold
      if (threshold > 0 && countTodayFailures(monthFile(), sig.cmd) === threshold) {
        appendOutbox({
          kind: "repeat-failure",
          text: `'${sig.cmd}' has failed ${threshold} times today — worth a closer look before retrying again`,
        })
      }
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
          // Queue for in-session injection; the next context hook delivers
          // it and marks the sid so the zsh drain skips the outbox copy.
          bgDoneQueue.push({
            sid,
            cwd: ledger.get(sid) ?? "",
            ok: !failed,
            ts: Math.floor(Date.now() / 1000),
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
