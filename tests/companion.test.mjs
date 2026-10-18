// Unit test for companion.js, driven on a mock plugin ctx.
// Run by tests/run.zsh (S10) via node; prints PASS/FAIL lines, exits 1 on any fail.
//
// What is covered:
//   - contract: a V2-shaped ctx loads, tool + context hook get registered
//   - context hook: fresh failure signal -> exactly one system line injected;
//     stale/absent signal -> zero injection (lazy-loading contract)
//   - contract: a V3-shaped ctx (breaking major bump) throws with an explicit
//     message instead of loading half-working
//   - recipes: config validation (unknown on/deliver, broken jsonc), probe
//     gating (generate/storage/event surfaces only required when used),
//     failure watch -> generate call shape (model object, placeholder fill),
//     exitFilter, ratePerHour via storage, both deliver paths, cleanup,
//     manual recipe tools, bg-done notifications
//   - bg-done in-session injection: queued at outbox-append time, delivered
//     once by the next context hook (sid + cwd), bg-injected.json handshake
//     written at injection time
//   - failure {stderr} slot: the bounded tail stored by the zsh side fills
//     the prompt; an absent field renders ""
// What is NOT covered here: real opencode runtime behavior (tool schema
// acceptance, hook event shape at runtime) — that is the platform's contract,
// anchored by assertContract's version check.

import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, rmSync, cpSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

const plugin = (await import("../companion.js")).default

let pass = 0
let fail = 0
const ok = (name) => { console.log(`  PASS ${name}`); pass++ }
const bad = (name, why) => { console.log(`  FAIL ${name}: ${why}`); fail++ }

// --- sandbox ---------------------------------------------------------------
// The plugin resolves its data dir as $XDG_DATA_HOME/zsh-opencode-mini and its
// config as $XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc at setup() time,
// so sandboxes point both at temp trees. Each recipe scenario gets its own
// sandbox (config is read fresh per setup call).
// Minimal TOML writer covering what this config uses: scalar tables and nested
// tables of scalars or arrays.
const toToml = (value) => {
  const scalar = (v) => {
    if (typeof v === "string") return JSON.stringify(v)
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    if (Array.isArray(v)) return "[" + v.map(scalar).join(", ") + "]"
    throw new Error("unsupported TOML value: " + JSON.stringify(v))
  }
  const isTable = (v) => v && typeof v === "object" && !Array.isArray(v)
  const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))
  const lines = []
  const walk = (obj, prefix) => {
    const scalars = []
    const tables = []
    for (const [childKey, child] of Object.entries(obj)) (isTable(child) ? tables : scalars).push([childKey, child])
    for (const [childKey, child] of scalars) lines.push(`${key(childKey)} = ${scalar(child)}`)
    for (const [childKey, child] of tables) {
      const name = prefix ? `${prefix}.${key(childKey)}` : key(childKey)
      lines.push(`[${name}]`)
      walk(child, name)
    }
  }
  walk(value, "")
  return lines.join("\n") + "\n"
}

const rootSandbox = () => {
  const xdgData = mkdtempSync(join(tmpdir(), "zom-comp-"))
  const xdgCfg = mkdtempSync(join(tmpdir(), "zom-cfg-"))
  const dataDir = join(xdgData, "zsh-opencode-mini")
  mkdirSync(dataDir, { recursive: true })
  const cfgDir = join(xdgCfg, "zsh-opencode-mini")
  mkdirSync(cfgDir, { recursive: true })
  // The extensions ship with the plugin; loading the real directory keeps
  // these tests on the path a user gets rather than a mock of it.
  cpSync(new URL("../extensions", import.meta.url), join(cfgDir, "extensions"), {
    recursive: true,
  })
  // Same seed the installer writes: the prompt lives in the user's file, and
  // the host holds no second copy of it.
  writeFileSync(
    join(cfgDir, "agent.md"),
    readFileSync(new URL("../agent.example.md", import.meta.url), "utf8"),
  )
  return {
    xdgData, dataDir, cfgPath: join(cfgDir, "config.toml"),
    use() {
      process.env.XDG_DATA_HOME = xdgData
      process.env.XDG_CONFIG_HOME = xdgCfg
    },
    // Fixtures stay written as JSON objects and are lowered to TOML here, so
    // each case reads as data rather than as a format exercise.
    write(config) {
      // A string that is not JSON is written verbatim: those cases exercise the
      // "config unparsable" path.
      if (typeof config === "string") {
        try {
          config = JSON.parse(config)
        } catch {
          writeFileSync(this.cfgPath, config)
          return
        }
      }
      writeFileSync(this.cfgPath, toToml(config))
    },
  }
}
// The chain is host hook + one hook per extension; a test that fired only
// index 0 would silently stop covering the extensions.
const fire = (state, event) => {
  for (const hook of state.contextHooks) hook(event)
}

const shared = rootSandbox()
shared.use()

// fake "fresh" clock: the plugin reads epoch seconds from the signal file, so
// we write a signal stamped ~now for the fresh case, and ~2x TTL old for stale.
const now = Math.floor(Date.now() / 1000)
const TTL = 600
const signal = (epoch) =>
  writeFileSync(join(shared.dataDir, "last-failure.json"), JSON.stringify({
    ts: "x", epoch, cwd: "/tmp", exit: 1, cmd: "cargo build --release",
  }))

// Atomic replace, same protocol the zsh side uses (tmp + mv). The watcher
// listens on the directory, so this must trigger it exactly like production.
const atomicSignal = (dataDir, obj) => {
  const tmp = join(dataDir, ".last-failure.tmp")
  writeFileSync(tmp, JSON.stringify(obj))
  renameSync(tmp, join(dataDir, "last-failure.json"))
}

// fs.watch dispatch latency is load-sensitive (FSEvents coalescing); 10s
// absorbs a busy machine without making real hangs slow to report
const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return !!fn()
}

// Node's fs.watch on macOS loses events with low probability (platform
// contract, verified: not write-coalescing, not filename=null, not
// cross-scene pollution). The plugin's contract is the watcher pipeline —
// signal read -> epoch dedupe -> exitFilter -> fire — not the platform's
// delivery reliability, so fire-class assertions retry with a fresh epoch
// (fresh epochs avoid the lastFiredEpoch dedupe) until the effect lands.
const fireViaWatcher = async (dataDir, obj, gen, want, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    atomicSignal(dataDir, { ...obj, epoch: obj.epoch + i })
    if (await waitFor(() => gen() >= want)) return obj.epoch + i
  }
  return null
}

// --- mock ctx (V2 shape, per docs verified 2026-10-02) ----------------------
function makeCtx({ version = "2.0.21", omit = [] } = {}) {
  const state = {
    tools: [],
    contextHooks: [],
    systemPushes: [],
    generateCalls: [],
    storage: {},
    agents: {},
    outboxFeeds: [],
    signals: [],
  }
  const has = (s) => !omit.includes(s)
  const ctx = {
    app: { version },
    // Registration surfaces are async in the real runtime (they resolve after
    // the registry is written). The mocks defer by a tick so a host that does
    // not await them fails these tests instead of passing by accident.
    tool: has("tool")
      ? {
          async transform(cb) {
            await null
            cb({ add: (t) => state.tools.push(t) })
          },
        }
      : undefined,
    session: has("session")
      ? {
          async hook(name, cb) {
            if (name !== "context") throw new Error(`unexpected hook ${name}`)
            await null
            state.contextHooks.push(cb)
          },
        }
      : undefined,
    storage: has("storage")
      ? {
          get: async (k) => state.storage[k],
          set: async (k, v) => { state.storage[k] = v },
        }
      : undefined,
    agent: has("agent")
      ? {
          async transform(cb) {
            await null
            cb({
              get: (id) => state.agents[id],
              update: (id, fn) => {
                const item = state.agents[id] ?? { id }
                state.agents[id] = item
                fn(item)
              },
            })
          },
        }
      : undefined,
    generate: has("generate")
      ? { text: async (input) => { state.generateCalls.push(input); return { text: `hint for ${input.prompt}` } } }
      : undefined,
    event: has("event")
      ? { subscribe({ signal }) {
          state.signals.push(signal)
          const queue = []
          let wake = null
          state.outboxFeeds.push({ push(ev) { queue.push(ev); wake?.() } })
          return (async function* () {
            while (true) {
              if (!queue.length) await new Promise((r) => { wake = r })
              if (signal?.aborted) return
              yield queue.shift()
            }
          })()
        } }
      : undefined,
  }
  return { ctx, state }
}

const contextEvent = () => ({ system: [], messages: [], agent: "mini" })

// Injections belong to the conversation tail. Reading the two places through
// one accessor made "landed in the cached prefix" indistinguishable from
// "landed correctly", so they are kept apart: tailTexts is what an assertion
// inspects, prefixTexts is what a regression check inspects.
const tailTexts = (ev) =>
  (ev.messages ?? []).flatMap((m) => (m.content ?? []).map((p) => p.text))
const prefixTexts = (ev) => (ev.system ?? []).map((p) => p.text)
const injected = tailTexts // historical name at call sites below

const readOutbox = (dataDir) =>
  existsSync(join(dataDir, "outbox.jsonl"))
    ? readFileSync(join(dataDir, "outbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : []

// --- run --------------------------------------------------------------------
try {
  // 1. V2 ctx loads and registers both surfaces
  const { ctx, state } = makeCtx()
  await plugin.setup(ctx)
  state.tools.length === 1 && state.tools[0].name === "zom_context"
    ? ok("v2 loads")
    : bad("v2 loads", `tools=${JSON.stringify(state.tools.map(t => t.name))}`)
  // The mock refuses any hook name but "context", so the count is the only
  // thing left to check: at least the host's own hook must be registered.
  state.contextHooks.length >= 1
    ? ok("context hook registered")
    : bad("context hook registered", `hooks=${state.contextHooks.length}`)
  state.tools.some((t) => t.name === "zom_context")
    ? ok("tool registered")
    : bad("tool registered", JSON.stringify(state.tools.map((t) => t.name)))

  // 1b. the agent is seeded by the plugin, not by a markdown file in the host
  // config dir; personal taste is appended from the plugin's own config dir.
  const seeded = state.agents["mini"]
  seeded && seeded.mode === "primary" && seeded.hidden === true &&
  seeded.system.includes("You are summoned")
    ? ok("agent seeded at load")
    : bad("agent seeded at load", JSON.stringify(seeded))

  const promptFile = join(dirname(shared.cfgPath), "agent.md")
  writeFileSync(promptFile, "Prefer tilth over grep.\n")
  const reloaded = makeCtx()
  await plugin.setup(reloaded.ctx)
  reloaded.state.agents["mini"].system === "Prefer tilth over grep.\n"
    ? ok("agent.md is the prompt")
    : bad("agent.md is the prompt", JSON.stringify(reloaded.state.agents["mini"].system))
  rmSync(promptFile, { force: true })

  // A deleted prompt is a visible state, not a silent fallback to a copy the
  // host kept: the agent registers with no brief and the problem says why.
  const missing = makeCtx()
  await plugin.setup(missing.ctx)
  const missingAgent = missing.state.agents["mini"]
  const missingEv = { system: [], messages: [], agent: "mini" }
  for (const hook of missing.state.contextHooks) hook(missingEv)
  const missingText = missingEv.messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  missingAgent.system === "" && missingText.includes("agent prompt")
    ? ok("a missing agent.md is visible, not papered over")
    : bad("a missing agent.md is visible, not papered over", JSON.stringify({ system: missingAgent.system, missingText }))
  writeFileSync(
    promptFile,
    readFileSync(new URL("../agent.example.md", import.meta.url), "utf8"),
  )

  // 1c. the agent id is configuration, not a constant: shell.agent renames it,
  // and the same value must both register the agent and gate injection.
  shared.write({ shell: { agent: "renamed-companion" }, companion: { failureTtlSeconds: TTL } })
  const renamed = makeCtx()
  await plugin.setup(renamed.ctx)
  const renamedAgent = renamed.state.agents["renamed-companion"]
  renamedAgent && renamedAgent.mode === "primary"
    ? ok("shell.agent names the agent")
    : bad("shell.agent names the agent", JSON.stringify(Object.keys(renamed.state.agents)))
  signal(now - 30)
  const oldName = { system: [], messages: [], agent: "mini" }
  fire(renamed.state, oldName)
  const newName = { system: [], messages: [], agent: "renamed-companion" }
  fire(renamed.state, newName)
  tailTexts(oldName).length === 0 && tailTexts(newName).length === 1
    ? ok("shell.agent gates injection")
    : bad("shell.agent gates injection", `old=${tailTexts(oldName).length} new=${tailTexts(newName).length}`)
  rmSync(shared.cfgPath, { force: true })

  // 2. fresh failure -> injected
  signal(now - 30)
  const ev = contextEvent()
  fire(state, ev)
  tailTexts(ev).length === 1 && tailTexts(ev)[0].includes("cargo build --release") &&
  prefixTexts(ev).length === 0
    ? ok("fresh failure injected")
    : bad("fresh failure injected", JSON.stringify(tailTexts(ev)))

  // 3. stale failure -> silent (lazy-loading contract)
  signal(now - TTL * 2)
  const ev2 = contextEvent()
  fire(state, ev2)
  tailTexts(ev2).length === 0 && prefixTexts(ev2).length === 0
    ? ok("stale failure silent")
    : bad("stale failure silent", JSON.stringify(tailTexts(ev2)))

  // 4. V3 ctx -> loud refusal
  try {
    await plugin.setup(makeCtx({ version: "3.0.0" }).ctx)
    bad("v3 refused loudly", "setup() did not throw")
  } catch (e) {
    String(e.message).includes("plugin API mismatch")
      ? ok("v3 refused loudly")
      : bad("v3 refused loudly", e.message)
  }

  // 5. F2: zom_context last_failure carries ageSeconds + fresh
  {
    signal(now - 30)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const tool = state.tools.find((t) => t.name === "zom_context")
    const res = await tool.execute({ query: "last_failure" })
    const parsed = JSON.parse(res.content)
    ;(parsed.ageSeconds !== undefined && parsed.fresh === true)
      ? ok("last_failure carries ageSeconds+fresh")
      : bad("last_failure carries ageSeconds+fresh", res.content)
    // regardless-of-age contract: an old failure is still returned, marked not fresh
    signal(now - TTL * 2)
    const res2 = JSON.parse((await tool.execute({ query: "last_failure" })).content)
    ;(res2.ageSeconds !== undefined && res2.fresh === false)
      ? ok("last_failure returns stale with fresh=false")
      : bad("last_failure returns stale with fresh=false", res2)
    clean()
  }

  // 6. config validation: the recipes extension owns the recipe schema now.
  //    A bad table must not take the plugin down: the extension refuses to
  //    wire anything and says why through the problem channel. A broken
  //    config document is still a load-time failure (nobody can read it).
  {
    const cases = [
      ["unknown on", `{"recipes":{"x":{"on":"cron","model":"p/m","prompt":"p","deliver":"outbox"}}}`, "unknown on value"],
      ["slot outside trigger (failure {sid})", `{"recipes":{"x":{"on":"failure","model":"p/m","prompt":"{sid}","deliver":"outbox"}}}`, "not provided by"],
      ["slot outside trigger (bg-done {exit})", `{"recipes":{"x":{"on":"bg-done","model":"p/m","prompt":"{exit}","deliver":"outbox"}}}`, "not provided by"],
      ["slot outside trigger (manual {sid})", `{"recipes":{"x":{"on":"manual","model":"p/m","prompt":"{sid}","deliver":"outbox"}}}`, "not provided by"],
      ["unknown deliver", `{"recipes":{"x":{"on":"failure","model":"p/m","prompt":"p","deliver":"email"}}}`, "unknown deliver value"],
      ["bad model", `{"recipes":{"x":{"on":"failure","model":"nomatch","prompt":"p","deliver":"outbox"}}}`, "provider/model-id"],
      ["bad exitFilter", `{"recipes":{"x":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox","exitFilter":["1"]}}}`, "array of integers"],
      ["bad name", `{"recipes":{"bad name!":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox"}}}`, "recipe name"],
    ]
    let allOk = true
    const whys = []
    for (const [name, jsonc, needle] of cases) {
      const sb = rootSandbox(); sb.use(); sb.write(jsonc)
      const { ctx, state } = makeCtx()
      const clean = await plugin.setup(ctx)
      const ev = { system: [], messages: [], agent: "mini" }
      fire(state, ev)
      const said = tailTexts(ev).join("\n")
      const tool = state.tools.find((t) => String(t.name).startsWith("zom_recipe_"))
      if (!said.includes(needle) || tool) {
        allOk = false
        whys.push(`${name}: tail=${JSON.stringify(said.slice(0, 120))} tool=${tool?.name}`)
      }
      clean()
    }
    const sb = rootSandbox(); sb.use(); sb.write("{ broken")
    try {
      const c = await plugin.setup(makeCtx().ctx)
      c()
      allOk = false; whys.push("broken jsonc: no throw")
    } catch (e) {
      if (!String(e.message).includes("failed to parse")) {
        allOk = false; whys.push(`broken jsonc: ${e.message}`)
      }
    }
    allOk ? ok("config validation loud, scoped to recipes") : bad("config validation loud, scoped to recipes", whys.join(" | "))
  }

  // 7. probe gating: recipes configured but generate/storage missing -> refuse;
  //    event.subscribe missing even without recipes -> refuse
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"x":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox"}}}`)
    try {
      const c = await plugin.setup(makeCtx({ omit: ["generate"] }).ctx)
      c()
      bad("probe gating refuses", "missing generate.text did not throw")
    } catch (e) {
      String(e.message).includes("ctx.generate.text")
        ? ok("probe gating refuses")
        : bad("probe gating refuses", e.message)
    }
    try {
      const c = await plugin.setup(makeCtx({ omit: ["event"] }).ctx)
      c()
      bad("event probe unconditional", "missing event.subscribe did not throw")
    } catch (e) {
      String(e.message).includes("ctx.event.subscribe")
        ? ok("event probe unconditional")
        : bad("event probe unconditional", e.message)
    }
  }

  // 8. watch -> generate: model object, placeholder fill, outbox delivery
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"prov/model-1","prompt":"cmd={cmd} exit={exit} cwd={cwd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    // same epoch re-fired by a duplicate fs event must not re-generate; the
    // epoch that actually fired is the one the helper landed on
    const firedEpoch = await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 127, cmd: "make test" }, () => state.generateCalls.length, 1)
    const call = state.generateCalls[0]
    firedEpoch !== null && call?.model?.providerID === "prov" && call?.model?.id === "model-1"
      && call.prompt === "cmd=make test exit=127 cwd=/w"
      ? ok("watch fires generate with model+placeholders")
      : bad("watch fires generate with model+placeholders", JSON.stringify(call))
    const lines = await waitFor(() => readOutbox(sb.dataDir).length === 1) && readOutbox(sb.dataDir)
    const rec = lines?.[0]
    rec?.kind === "recipe" && rec.recipe === "hint" && typeof rec.text === "string" && rec.id && rec.ts
      ? ok("deliver=outbox appends record")
      : bad("deliver=outbox appends record", JSON.stringify(rec))
    atomicSignal(sb.dataDir, { ts: "x", epoch: firedEpoch, cwd: "/w", exit: 127, cmd: "make test" })
    await new Promise((r) => setTimeout(r, 300))
    state.generateCalls.length === 1
      ? ok("epoch dedupes duplicate fs events")
      : bad("epoch dedupes duplicate fs events", `calls=${state.generateCalls.length}`)
    clean()
  }

  // 9. exitFilter: non-matching exit stays silent
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox","exitFilter":[1]}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    atomicSignal(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 127, cmd: "x" })
    await new Promise((r) => setTimeout(r, 400))
    state.generateCalls.length === 0
      ? ok("exitFilter filters non-matching exit")
      : bad("exitFilter filters non-matching exit", JSON.stringify(state.generateCalls))
    const fired = await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now + 1, cwd: "/w", exit: 1, cmd: "x" }, () => state.generateCalls.length, 1)
    fired ? ok("exitFilter passes matching exit") : bad("exitFilter passes matching exit", "never fired")
    clean()
  }

  // 10. ratePerHour: second fire in the same hour is gated via storage
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox","ratePerHour":1}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" }, () => state.generateCalls.length, 1)
    atomicSignal(sb.dataDir, { ts: "x", epoch: now + 1, cwd: "/w", exit: 2, cmd: "y" })
    await new Promise((r) => setTimeout(r, 400))
    // The counter now lives in the extension's own kv file beside the other
    // shell data (host.kv), not in the plugin ctx storage: one durable store,
    // no second surface that can silently return undefined.
    const kvPath = join(sb.dataDir, "recipes.kv.json")
    const kv = existsSync(kvPath) ? JSON.parse(readFileSync(kvPath, "utf8")) : {}
    state.generateCalls.length === 1 && Object.keys(kv).some((k) => k.startsWith("zom/rate/hint"))
      ? ok("ratePerHour gates via storage")
      : bad("ratePerHour gates via storage", `calls=${state.generateCalls.length} keys=${JSON.stringify(Object.keys(kv))}`)
    clean()
  }

  // 10b. A rate gate whose counter cannot be written must not fire anyway:
  //      the limit is off, and "off" is said out loud instead of looking
  //      enforced while generating on every event.
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox","ratePerHour":1}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    // A directory where the counter file should be: the gate reads as empty
    // (fine) but cannot persist its count, which is exactly the case under test.
    mkdirSync(join(sb.dataDir, "recipes.kv.json"), { recursive: true })
    atomicSignal(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" })
    await new Promise((r) => setTimeout(r, 400))
    const hookEvent = { system: [], messages: [], agent: "mini" }
    state.contextHooks.forEach((h) => h(hookEvent))
    const said = tailTexts(hookEvent).join("\n")
    state.generateCalls.length === 0 && said.includes("rate gate could not be written")
      ? ok("an unpersistable rate gate is reported, not ignored")
      : bad("an unpersistable rate gate is reported, not ignored", `calls=${state.generateCalls.length} tail=${JSON.stringify(said)}`)
    clean()
  }

  // 11. deliver=next-session: lands in context injection with [zom:name] tag;
  //     expires after ttlSeconds (ttl:0 => any later hook sees it gone; the
  //     failure TTL line, a different signal, legitimately persists)
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"next-session","ttlSeconds":0}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const gotHook = await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" }, () => state.generateCalls.length, 1)
      && readOutbox(sb.dataDir).length === 0
    const evx = contextEvent()
    fire(state, evx)
    const line =
    prefixTexts(evx).length === 0 ? tailTexts(evx).find((t) => t.startsWith("[zom:hint]")) : undefined
    gotHook && line && line.includes("hint for p")
      ? ok("next-session injects tagged output")
      : bad("next-session injects tagged output", JSON.stringify(tailTexts(evx)))
    await new Promise((r) => setTimeout(r, 1200))
    const evy = contextEvent()
    fire(state, evy)
    !tailTexts(evy).some((t) => t.startsWith("[zom:"))
      ? ok("next-session output expires after ttl")
      : bad("next-session output expires after ttl", JSON.stringify(tailTexts(evy)))
    clean()
  }

  // 12. manual recipe: registered as a tool, fires through the same pipeline
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"explain":{"on":"manual","model":"p/m","prompt":"explain {cmd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const tool = state.tools.find((t) => t.name === "zom_recipe_explain")
    await tool.execute({ cmd: "git rebase" })
    const call = state.generateCalls[0]
    tool && call?.prompt === "explain git rebase" && readOutbox(sb.dataDir).length === 1
      ? ok("manual recipe tool fires")
      : bad("manual recipe tool fires", JSON.stringify({ tool: tool?.name, call, outbox: readOutbox(sb.dataDir) }))
    clean()
  }

  // 13. cleanup: aborts the event stream and stops the failure watcher
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const sig = state.signals[0]
    clean()
    const aborted = sig?.aborted === true
    atomicSignal(sb.dataDir, { ts: "x", epoch: now + 9, cwd: "/w", exit: 3, cmd: "after-clean" })
    await new Promise((r) => setTimeout(r, 400))
    aborted && state.generateCalls.length === 0
      ? ok("cleanup aborts stream and stops watcher")
      : bad("cleanup aborts stream and stops watcher", `aborted=${aborted} calls=${state.generateCalls.length}`)
  }

  // 14. bg-done: execution.succeeded for a known bg sid -> outbox record;
  //     unknown sid / other event types stay silent. Main shape = the real
  //     runtime envelope {type, data:{sessionID}} (opencode 2.0.21); one
  //     {properties} legacy-wire event proves the fallback still works
  {
    const sb = rootSandbox(); sb.use()
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    writeFileSync(join(sb.dataDir, "bg.jsonl"), JSON.stringify({ sid: "ses_zom-bg-1", pid: 1 }) + "\n")
    const feed = state.outboxFeeds[0]
    // other event types never notify (session.status does not exist in v2)
    feed.push({ type: "session.status", data: { sessionID: "ses_zom-bg-1", status: { type: "idle" } } })
    feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_other" } })
    await new Promise((r) => setTimeout(r, 100))
    readOutbox(sb.dataDir).length === 0
      ? ok("bg-done ignores non-execution events and unknown sids")
      : bad("bg-done ignores non-execution events and unknown sids", JSON.stringify(readOutbox(sb.dataDir)))
    feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-1" } })
    const done = await waitFor(() => readOutbox(sb.dataDir).length === 1) && readOutbox(sb.dataDir)[0]
    done?.kind === "bg-done" && done.sid === "ses_zom-bg-1" && done.ok === true && done.text === "background session ses_zom-bg-1 finished"
      ? ok("bg-done succeeded appends outbox record")
      : bad("bg-done succeeded appends outbox record", JSON.stringify(done))
    // duplicate delivery (one evt id per server instance) is absorbed by the
    // sid set, and a legacy-wire {properties} event still notifies
    feed.push({ id: "evt_dup", type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-1" } })
    feed.push({ id: "evt_dup", type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-1" } })
    feed.push({ id: "evt_legacy", type: "session.execution.succeeded", properties: { sessionID: "ses_zom-bg-2" } })
    writeFileSync(join(sb.dataDir, "bg.jsonl"), JSON.stringify({ sid: "ses_zom-bg-1", pid: 1 }) + "\n" + JSON.stringify({ sid: "ses_zom-bg-2", pid: 2 }) + "\n")
    await new Promise((r) => setTimeout(r, 300))
    const after = readOutbox(sb.dataDir)
    after.length === 2 && after[1]?.sid === "ses_zom-bg-2" && after[1]?.ok === true
      ? ok("bg-done dup delivery absorbed, legacy shape tolerated")
      : bad("bg-done dup delivery absorbed, legacy shape tolerated", JSON.stringify(after))
    // failed path: notify with ok:false when the sessionID is readable
    // (ses_zom-bg-3 was never notified; bg-2 is already in the set)
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_zom-bg-3" } })
    writeFileSync(join(sb.dataDir, "bg.jsonl"), JSON.stringify({ sid: "ses_zom-bg-1", pid: 1 }) + "\n" + JSON.stringify({ sid: "ses_zom-bg-2", pid: 2 }) + "\n" + JSON.stringify({ sid: "ses_zom-bg-3", pid: 3 }) + "\n")
    const bad1 = await waitFor(() => readOutbox(sb.dataDir).length === 3) && readOutbox(sb.dataDir)[2]
    bad1?.ok === false && bad1.text.includes("with error")
      ? ok("bg-done failed appends ok:false notice")
      : bad("bg-done failed appends ok:false notice", JSON.stringify(bad1))
    // failed with unreadable sessionID stays silent
    feed.push({ type: "session.execution.failed", data: {} })
    await new Promise((r) => setTimeout(r, 200))
    readOutbox(sb.dataDir).length === 3
      ? ok("bg-done failed without sessionID stays silent")
      : bad("bg-done failed without sessionID stays silent", JSON.stringify(readOutbox(sb.dataDir)))
    clean()
  }

  // 16. bg-done recipe: fires once per sid (deduped with the notification),
  //     a second execution for the same sid is silent, another sid fires again
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"poke":{"on":"bg-done","model":"p/m","prompt":"done: {sid} in {cwd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    writeFileSync(join(sb.dataDir, "bg.jsonl"), JSON.stringify({ sid: "ses_zom-bg-1", cwd: "/w" }) + "\n" + JSON.stringify({ sid: "ses_zom-bg-2", cwd: "/x" }) + "\n")
    const feed = state.outboxFeeds[0]
    feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-1" } })
    await waitFor(() => state.generateCalls.length === 1)
    feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-1" } })
    feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-2" } })
    await waitFor(() => state.generateCalls.length === 2)
    await new Promise((r) => setTimeout(r, 300))
    state.generateCalls.length === 2
      ? ok("bg-done recipe fires once per sid")
      : bad("bg-done recipe fires once per sid", JSON.stringify(state.generateCalls))
    // fill identity against the trigger's slot set: the ledger's cwd lands in
    // {cwd}, the event's sessionID in {sid}
    state.generateCalls[0]?.prompt === "done: ses_zom-bg-1 in /w"
      ? ok("bg-done recipe fill matches trigger slots")
      : bad("bg-done recipe fill matches trigger slots", JSON.stringify(state.generateCalls[0]))
    const o = readOutbox(sb.dataDir)
    const pokes = o.filter((r) => r.recipe === "poke")
    const done = o.filter((r) => r.kind === "bg-done")
    pokes.length === 2 && done.length === 2
      ? ok("bg-done recipe outbox lines once per sid")
      : bad("bg-done recipe outbox lines once per sid", JSON.stringify(o))
    clean()
  }

  // 18. notices: pending shell-side notices are injected once, deduped by
  //     kind+text, and the file self-cleans; a second hook sees nothing
  {
    const sb = rootSandbox(); sb.use()
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const notices = join(sb.dataDir, "notices.jsonl")
    writeFileSync(notices,
      JSON.stringify({ ts: now - 100, kind: "hook-failure", text: "spawn hook foo exited 1 (kind=bg); it did not run" }) + "\n" +
      JSON.stringify({ ts: now - 50, kind: "hook-failure", text: "spawn hook foo exited 1 (kind=bg); it did not run" }) + "\n" +
      JSON.stringify({ ts: now - 10, kind: "history-oversized", text: "history-2026-10.jsonl is over 10 MB" }) + "\n" +
      `{"kind":"torn","text":"never completed`)
    const ev = contextEvent()
    fire(state, ev)
    const notice = tailTexts(ev).find((t) => t.includes("shell-side notices")) ?? ""
    const count = (notice.match(/hook-failure/g) || []).length
    notice && count === 1 && notice.includes("history-oversized") && !notice.includes("torn")
      ? ok("notices injected deduped")
      : bad("notices injected deduped", JSON.stringify(tailTexts(ev)))
    readFileSync(notices, "utf8") === ""
      ? ok("notices file self-cleans after drain")
      : bad("notices file self-cleans after drain", readFileSync(notices, "utf8"))
    const ev2 = contextEvent()
    fire(state, ev2)
    !tailTexts(ev2).some((t) => t.includes("shell-side notices"))
      ? ok("notices drained once")
      : bad("notices drained once", JSON.stringify(tailTexts(ev2)))
    clean()
  }

  // 20. bg-done in-session injection: the event lands in the injection queue
  //     at outbox-append time; the next context hook delivers it once (sid +
  //     cwd + ok flag) and writes the bg-injected.json handshake the zsh
  //     drain consults; a second hook sees nothing (queue consumed)
  {
    const sb = rootSandbox(); sb.use()
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    writeFileSync(join(sb.dataDir, "bg.jsonl"), JSON.stringify({ sid: "ses_zom-bg-inj", cwd: "/proj" }) + "\n")
    state.outboxFeeds[0].push({ type: "session.execution.succeeded", data: { sessionID: "ses_zom-bg-inj" } })
    const rec = await waitFor(() => readOutbox(sb.dataDir).length === 1) && readOutbox(sb.dataDir)[0]
    rec?.kind === "bg-done"
      ? ok("injection: outbox record still written")
      : bad("injection: outbox record still written", JSON.stringify(rec))
    const ev = contextEvent()
    fire(state, ev)
    const line = tailTexts(ev).find((t) => t.includes("background session"))
    line && line.includes("ses_zom-bg-inj") && line.includes("/proj")
      ? ok("injection: hook delivers sid+cwd once")
      : bad("injection: hook delivers sid+cwd once", JSON.stringify(tailTexts(ev)))
    // handshake: the drain on the zsh side skips this sid for the TTL window
    const marker = JSON.parse(readFileSync(join(sb.dataDir, "bg-injected.json"), "utf8"))
    typeof marker["ses_zom-bg-inj"] === "number"
      ? ok("injection: bg-injected.json marker written")
      : bad("injection: bg-injected.json marker written", JSON.stringify(marker))
    const ev2 = contextEvent()
    fire(state, ev2)
    !tailTexts(ev2).some((t) => t.includes("background session"))
      ? ok("injection: consumed after one hook")
      : bad("injection: consumed after one hook", JSON.stringify(tailTexts(ev2)))
    // failed path names the error in the injection (fresh sid — the notify
    // set dedupes per sid, ses_zom-bg-inj is already consumed)
    writeFileSync(join(sb.dataDir, "bg.jsonl"),
      JSON.stringify({ sid: "ses_zom-bg-inj", cwd: "/proj" }) + "\n" +
      JSON.stringify({ sid: "ses_zom-bg-fail", cwd: "/proj" }) + "\n")
    state.outboxFeeds[0].push({ type: "session.execution.failed", data: { sessionID: "ses_zom-bg-fail" } })
    await waitFor(() => readOutbox(sb.dataDir).length === 2)
    const ev3 = contextEvent()
    fire(state, ev3)
    const failLine = tailTexts(ev3).find((t) => t.includes("ses_zom-bg-fail"))
    failLine && failLine.includes("with error")
      ? ok("injection: failed session flagged with error")
      : bad("injection: failed session flagged with error", JSON.stringify(tailTexts(ev3)))
    clean()
  }

  // 21. failure recipe {stderr} slot: the bounded tail the zsh side stored
  //     into last-failure.json fills the prompt; an absent field renders ""
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"err=[{stderr}]","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const fired = await fireViaWatcher(sb.dataDir,
      { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x", stderr: "boom\nline2" },
      () => state.generateCalls.length, 1)
    fired !== null && state.generateCalls[0]?.prompt === "err=[boom\nline2]"
      ? ok("failure {stderr} slot fills the prompt")
      : bad("failure {stderr} slot fills the prompt", JSON.stringify(state.generateCalls[0]))
    clean()
    const sb2 = rootSandbox(); sb2.use()
    sb2.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"err=[{stderr}]","deliver":"outbox"}}}`)
    const { ctx: ctx2, state: state2 } = makeCtx()
    const clean2 = await plugin.setup(ctx2)
    const fired2 = await fireViaWatcher(sb2.dataDir,
      { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" },
      () => state2.generateCalls.length, 1)
    fired2 !== null && state2.generateCalls[0]?.prompt === "err=[]"
      ? ok("failure {stderr} absent renders empty")
      : bad("failure {stderr} absent renders empty", JSON.stringify(state2.generateCalls[0]))
    clean2()
  }

  // 19. repeat-failure: the threshold-th identical failure today drops one
  //     outbox hint; further failures stay silent (count === threshold fires
  //     once per command per day)
  {
    const sb = rootSandbox(); sb.use()
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const d = new Date()
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const today = `${month}-${String(d.getDate()).padStart(2, "0")}`
    const line = (cmd, exit) =>
      JSON.stringify({ ts: `${today}T10:00:00+0800`, cwd: "/w", exit, ms: 1, cmd })
    // In production precmd appends the failing command to history BEFORE
    // replacing last-failure.json, so when the watcher wakes the current
    // failure is already counted. Three history lines + the signal = the
    // third failure.
    writeFileSync(join(sb.dataDir, `history-${month}.jsonl`),
      line("make test", 1) + "\n" + line("make test", 1) + "\n" + line("make test", 1) + "\n" +
      line("make test", 0) + "\n" + line("git push", 1) + "\n")
    const repeats = () => readOutbox(sb.dataDir).filter((r) => r.kind === "repeat-failure")
    // two failures already on record; this one is the third -> hint
    const epoch = await fireViaWatcher(sb.dataDir,
      { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "make test" },
      () => repeats().length, 1)
    epoch !== null && repeats()[0].text.includes("'make test' has failed 3 times today")
      ? ok("repeat-failure hint at threshold")
      : bad("repeat-failure hint at threshold", JSON.stringify(repeats()))
    // the fourth failure must not re-hint — append it to history first,
    // exactly like precmd would, so count is 4 and the hint must stay silent
    writeFileSync(join(sb.dataDir, `history-${month}.jsonl`),
      line("make test", 1) + "\n", { flag: "a" })
    atomicSignal(sb.dataDir, { ts: "x", epoch: (epoch ?? now) + 100, cwd: "/w", exit: 1, cmd: "make test" })
    await waitFor(() => readFileSync(join(sb.dataDir, "last-failure.json"), "utf8").includes(`${(epoch ?? now) + 100}`))
    await new Promise((r) => setTimeout(r, 300))
    repeats().length === 1
      ? ok("repeat-failure fires once per command per day")
      : bad("repeat-failure fires once per command per day", JSON.stringify(repeats()))
    clean()
    // A second live process (another server instance sharing the dataDir) sees
    // the same failure event; its watcher must not append a second hint. Reset
    // the count to exactly the threshold: only count === threshold appends, so
    // the dedupe — not the arithmetic — is what keeps this silent.
    writeFileSync(join(sb.dataDir, `history-${month}.jsonl`),
      line("make test", 1) + "\n" + line("make test", 1) + "\n" + line("make test", 1) + "\n")
    const { ctx: ctx2, state: state2 } = makeCtx()
    const clean2 = await plugin.setup(ctx2)
    atomicSignal(sb.dataDir, { ts: "x", epoch: (epoch ?? now) + 200, cwd: "/w", exit: 1, cmd: "make test" })
    await waitFor(() => readFileSync(join(sb.dataDir, "last-failure.json"), "utf8").includes(`${(epoch ?? now) + 200}`))
    await new Promise((r) => setTimeout(r, 300))
    repeats().length === 1
      ? ok("repeat-failure deduped across plugin instances")
      : bad("repeat-failure deduped across plugin instances", JSON.stringify(repeats()))
    clean2()
  }

  // 15. recipes config with no matching signals leaves zero injection
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"next-session"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const evz = contextEvent()
    fire(state, evz)
    tailTexts(evz).length === 0
      ? ok("no signal no injection")
      : bad("no signal no injection", JSON.stringify(tailTexts(evz)))
    clean()
  }

  // 17. outbox append is a pure append: rotation belongs to the state-watch
  //     scanner (covered in extensions.test.mjs), because doing it here reads
  //     the whole file per record and races another process appending to the
  //     inode being replaced. A past-cap file must still accept a record.
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"explain":{"on":"manual","model":"p/m","prompt":"explain {cmd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = await plugin.setup(ctx)
    const tool = state.tools.find((t) => t.name === "zom_recipe_explain")
    const outbox = join(sb.dataDir, "outbox.jsonl")
    const padLine = (i) => JSON.stringify({ n: String(i).padStart(6, "0"), kind: "pad" }) + "\n"

    writeFileSync(outbox, padLine(0) + padLine(1))
    await tool.execute({ cmd: "small append" })
    const small = readOutbox(sb.dataDir)
    small.length === 3 && small[2].text === "hint for explain small append"
      ? ok("append below cap keeps everything")
      : bad("append below cap keeps everything", JSON.stringify(small.map((r) => r.kind ?? r.recipe)))

    const N = 12000
    let seed = ""
    for (let i = 0; i < N; i++) seed += padLine(i)
    writeFileSync(outbox, seed)
    const before = statSync(outbox).size
    await tool.execute({ cmd: "past cap" })
    const after = statSync(outbox).size
    const recs = readOutbox(sb.dataDir)
    const last = recs[recs.length - 1]
    // rotated-away prefix would show up as a missing n=0 pad record
    const keptPrefix = recs.some((r) => r.kind === "pad" && r.n === "000000")
    after > before && keptPrefix && last?.recipe === "explain"
      && last?.text === "hint for explain past cap" && !existsSync(`${outbox}.tmp`)
      ? ok("append past cap still lands, no rotation in the hot path")
      : bad("append past cap still lands, no rotation in the hot path",
          JSON.stringify({ before, after, last }))
    clean()
  }

  // 18. tty scope: a failure recorded by another terminal is invisible to
  //     this summon (tool answer and context injection); the owner sees it;
  //     legacy records without a tty field and summons without a spawns.jsonl
  //     record degrade to the old global-latest behaviour.
  {
    shared.use() // the recipe scenarios above re-pointed XDG at their own sandboxes
    const spawnsPath = join(shared.dataDir, "spawns.jsonl")
    const writeSpawns = (tty, cwd) =>
      writeFileSync(spawnsPath, `${JSON.stringify({ ts: now, kind: "mini", tty, cwd })}\n`)
    const removeSpawns = () => { try { renameSync(spawnsPath, spawnsPath + ".bak") } catch {} }
    const restoreSpawns = () => { try { renameSync(spawnsPath + ".bak", spawnsPath) } catch {} }
    const sigWithTty = (tty) => atomicSignal(shared.dataDir, {
      ts: "x", epoch: now, cwd: "/tmp", exit: 1, cmd: "cargo build --release", tty,
    })
    const toolOf = async () => {
      const { ctx, state } = makeCtx()
      await plugin.setup(ctx)
      return state.tools.find((t) => t.name === "zom_context")
    }
    const hookInjects = async () => {
      const { ctx, state } = makeCtx()
      await plugin.setup(ctx)
      const ev = contextEvent()
      fire(state, ev)
      return tailTexts(ev).filter((t) => String(t).includes("failed")).length
    }

    // no summon record: cannot tell which shell is asking -> global-latest
    removeSpawns()
    sigWithTty("/dev/ttysA")
    const out0 = await (await toolOf()).execute({ query: "last_failure" })
    out0.content.includes("cargo build") && (await hookInjects()) === 1
      ? ok("no spawn record degrades to global-latest")
      : bad("no spawn record degrades to global-latest", JSON.stringify({ out: out0.content, injects: await hookInjects() }))

    // another terminal's failure: hidden from tool and injection
    writeSpawns("/dev/ttysB", "/w")
    const out1 = await (await toolOf()).execute({ query: "last_failure" })
    out1.content.includes("no failed command in this terminal") && (await hookInjects()) === 0
      ? ok("foreign-tty failure hidden")
      : bad("foreign-tty failure hidden", JSON.stringify({ out: out1.content, injects: await hookInjects() }))

    // the owner still sees it
    writeSpawns("/dev/ttysA", "/w")
    const out2 = await (await toolOf()).execute({ query: "last_failure" })
    out2.content.includes("cargo build") && (await hookInjects()) === 1
      ? ok("own-tty failure visible")
      : bad("own-tty failure visible", JSON.stringify({ out: out2.content, injects: await hookInjects() }))

    // legacy record without tty field: owned by everyone
    atomicSignal(shared.dataDir, { ts: "x", epoch: now, cwd: "/tmp", exit: 1, cmd: "cargo build --release" })
    writeSpawns("/dev/ttysB", "/w")
    const out3 = await (await toolOf()).execute({ query: "last_failure" })
    out3.content.includes("cargo build") && (await hookInjects()) === 1
      ? ok("legacy no-tty record stays global-latest")
      : bad("legacy no-tty record stays global-latest", JSON.stringify({ out: out3.content, injects: await hookInjects() }))
    removeSpawns()
  }

  // 19. recent re-rank at read time: the summoning cwd's commands surface
  //     first (exact match, then subdirectories, newest first within each
  //     group); without a summon record the order is unchanged. Storage and
  //     the N-most-recent pool are untouched.
  {
    shared.use() // the recipe scenarios above re-pointed XDG at their own sandboxes
    const d = new Date()
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const hist = join(shared.dataDir, `history-${month}.jsonl`)
    const line = (cmd, cwd) => JSON.stringify({ ts: "x", cwd, exit: 0, ms: 1, cmd })
    // file order = oldest first: /other, /proj/sub, /proj, /other, /proj
    writeFileSync(hist, [
      line("a-oldest-other", "/other"),
      line("b-projsub", "/proj/sub"),
      line("c-proj-old", "/proj"),
      line("d-other-new", "/other"),
      line("e-proj-new", "/proj"),
    ].join("\n") + "\n")
    const spawnsPath = join(shared.dataDir, "spawns.jsonl")
    const toolOf = async () => {
      const { ctx, state } = makeCtx()
      await plugin.setup(ctx)
      return state.tools.find((t) => t.name === "zom_context")
    }
    const cmdsOf = async (query) => {
      const out = await (await toolOf()).execute(query)
      return out.content.split("\n").map((l) => { try { return JSON.parse(l).cmd } catch { return l } })
    }

    writeFileSync(spawnsPath, `${JSON.stringify({ ts: now, kind: "mini", tty: "/dev/ttys9", cwd: "/proj" })}\n`)
    const ranked = await cmdsOf({ query: "recent", n: 5 })
    JSON.stringify(ranked) === JSON.stringify(["e-proj-new", "c-proj-old", "b-projsub", "d-other-new", "a-oldest-other"])
      ? ok("recent ranked by summon cwd affinity")
      : bad("recent ranked by summon cwd affinity", JSON.stringify(ranked))

    // no summon record: exactly the old recency order (file order)
    renameSync(spawnsPath, spawnsPath + ".bak")
    const plain = await cmdsOf({ query: "recent", n: 5 })
    JSON.stringify(plain) === JSON.stringify(["a-oldest-other", "b-projsub", "c-proj-old", "d-other-new", "e-proj-new"])
      ? ok("recent without summon record keeps recency order")
      : bad("recent without summon record keeps recency order", JSON.stringify(plain))
    renameSync(spawnsPath + ".bak", spawnsPath)
  }

  // 20. usage baseline: the real path is event -> dispatch -> disk -> seed in
  //     a fresh module. The map is module scope, so "fresh module" needs a
  //     child process; running it in-process would read the map and hide a
  //     broken persist or a broken seed behind leftover state.
  {
    const sb = rootSandbox()
    sb.use()
    const usageEvent = (input, read) => ({
      type: "session.usage.updated",
      data: { sessionID: "ses_u", tokens: { input, cache: { read } } },
    })
    const settle = () => new Promise((r) => setTimeout(r, 40))

    const { ctx, state } = makeCtx()
    await plugin.setup(ctx)
    state.outboxFeeds[0].push(usageEvent(1000, 100))
    await settle()
    state.outboxFeeds[0].push(usageEvent(1500, 200))
    await settle()

    let wrote = null
    try { wrote = JSON.parse(readFileSync(join(sb.dataDir, "usage-baseline.json"), "utf8")) } catch {}
    wrote?.ses_u?.input === 1500
      ? ok("usage baseline written from the event stream")
      : bad("usage baseline written from the event stream", JSON.stringify(wrote))

    // A listener exists only so the delta has somewhere observable to land.
    writeFileSync(
      join(sb.cfgPath, "..", "extensions", "probe-usage.js"),
      `import { appendFileSync } from "node:fs"
export default {
  id: "probe-usage",
  setup(ctx, host) {
    host.onUsageDelta((d) => appendFileSync(host.dataDir + "/deltas.log", JSON.stringify(d) + "\\n"))
  },
}
`,
    )
    const companionHref = new URL("../companion.js", import.meta.url).href
    const probe = join(sb.dataDir, "probe.mjs")
    writeFileSync(
      probe,
      `const plugin = (await import(${JSON.stringify(companionHref)})).default
const queue = []
let wake = () => {}
const ctx = {
  app: { version: "2.0.21" },
  tool: { transform(cb) { cb({ add() {} }) } },
  session: { hook() {} },
  storage: { get: async () => undefined, set: async () => {} },
  agent: { transform(cb) { cb({ get: () => undefined, update() {} }) } },
  event: { subscribe() { return (async function* () {
    for (;;) {
      if (!queue.length) await new Promise((r) => { wake = r })
      yield queue.shift()
    }
  })() } },
}
await plugin.setup(ctx)
queue.push({ type: "session.usage.updated", data: { sessionID: "ses_u", tokens: { input: 1550, cache: { read: 260 } } } })
wake()
await new Promise((r) => setTimeout(r, 50))
process.exit(0)
`,
    )
    execSync(`"${process.execPath}" "${probe}"`, { env: process.env, stdio: "pipe" })
    let delta = null
    try {
      delta = JSON.parse(readFileSync(join(sb.dataDir, "deltas.log"), "utf8").trim().split("\n").pop())
    } catch {}
    delta?.sid === "ses_u" && delta?.dInput === 50 && delta?.dRead === 60
      ? ok("fresh module seeds the baseline from disk")
      : bad("fresh module seeds the baseline from disk", JSON.stringify(delta))
  }

  // 21. A reload runs setup again in the same process. Listeners from the
  //     previous generation must be gone, or one event fires two handlers.
  {
    const sb = rootSandbox()
    sb.use()
    mkdirSync(join(sb.cfgPath, "..", "extensions"), { recursive: true })
    writeFileSync(
      join(sb.cfgPath, "..", "extensions", "count-delta.js"),
      `import { appendFileSync } from "node:fs"
export default {
  id: "count-delta",
  setup(ctx, host) {
    host.onUsageDelta(() => appendFileSync(host.dataDir + "/fires.log", "x"))
  },
}
`,
    )
    const usageEvent = (input, read) => ({
      type: "session.usage.updated",
      data: { sessionID: "ses_r", tokens: { input, cache: { read } } },
    })
    const settle = () => new Promise((r) => setTimeout(r, 60))
    const first = makeCtx()
    await plugin.setup(first.ctx)
    const second = makeCtx()
    await plugin.setup(second.ctx)
    first.state.outboxFeeds[0].push(usageEvent(1000, 100))
    await settle()
    second.state.outboxFeeds[0].push(usageEvent(1200, 150))
    await settle()
    let fires = ""
    try {
      fires = readFileSync(join(sb.dataDir, "fires.log"), "utf8")
    } catch {}
    // The first sample only records a baseline; the second one is the delta.
    // One line = one live listener. Two = the reloaded generation is still
    // subscribed alongside the new one.
    fires.length === 1
      ? ok("a reload does not stack listeners")
      : bad("a reload does not stack listeners", `fires=${fires.length}`)
  }
} catch (e) {
  bad("suite crashed", e.stack || e.message)
}

console.log(`companion.test: ${pass + fail} checks, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
