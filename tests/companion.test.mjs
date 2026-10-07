// Unit test for opencode-plugin/zom-companion.js, driven on a mock plugin ctx.
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
// What is NOT covered here: real opencode runtime behavior (tool schema
// acceptance, hook event shape at runtime) — that is the platform's contract,
// anchored by assertContract's version check.

import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const plugin = (await import("../opencode-plugin/zom-companion.js")).default

let pass = 0
let fail = 0
const ok = (name) => { console.log(`  PASS ${name}`); pass++ }
const bad = (name, why) => { console.log(`  FAIL ${name}: ${why}`); fail++ }

// --- sandbox ---------------------------------------------------------------
// The plugin resolves its data dir as $XDG_DATA_HOME/zsh-opencode-mini and its
// config as $XDG_CONFIG_HOME/zsh-opencode-mini/config.jsonc at setup() time,
// so sandboxes point both at temp trees. Each recipe scenario gets its own
// sandbox (config is read fresh per setup call).
const rootSandbox = () => {
  const xdgData = mkdtempSync(join(tmpdir(), "zom-comp-"))
  const xdgCfg = mkdtempSync(join(tmpdir(), "zom-cfg-"))
  const dataDir = join(xdgData, "zsh-opencode-mini")
  mkdirSync(dataDir, { recursive: true })
  const cfgDir = join(xdgCfg, "zsh-opencode-mini")
  mkdirSync(cfgDir, { recursive: true })
  return {
    xdgData, dataDir, cfgPath: join(cfgDir, "config.jsonc"),
    use() {
      process.env.XDG_DATA_HOME = xdgData
      process.env.XDG_CONFIG_HOME = xdgCfg
    },
    write(jsonc) { writeFileSync(this.cfgPath, jsonc) },
  }
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
    outboxFeeds: [],
    signals: [],
  }
  const has = (s) => !omit.includes(s)
  const ctx = {
    app: { version },
    tool: has("tool")
      ? { transform(cb) { cb({ add: (t) => state.tools.push(t) }) } }
      : undefined,
    session: has("session")
      ? { hook(name, cb) {
          if (name !== "context") throw new Error(`unexpected hook ${name}`)
          state.contextHooks.push(cb)
        } }
      : undefined,
    storage: has("storage")
      ? {
          get: async (k) => state.storage[k],
          set: async (k, v) => { state.storage[k] = v },
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

const contextEvent = () => ({ system: [] })

const readOutbox = (dataDir) =>
  existsSync(join(dataDir, "outbox.jsonl"))
    ? readFileSync(join(dataDir, "outbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : []

// --- run --------------------------------------------------------------------
try {
  // 1. V2 ctx loads and registers both surfaces
  const { ctx, state } = makeCtx()
  plugin.setup(ctx)
  state.tools.length === 1 && state.tools[0].name === "zom_context"
    ? ok("v2 loads")
    : bad("v2 loads", `tools=${JSON.stringify(state.tools.map(t => t.name))}`)
  state.contextHooks.length === 1
    ? ok("context hook registered")
    : bad("context hook registered", `hooks=${state.contextHooks.length}`)
  ok("tool registered")

  // 2. fresh failure -> injected
  signal(now - 30)
  const ev = contextEvent()
  state.contextHooks[0](ev)
  ev.system.length === 1 && ev.system[0].text.includes("cargo build --release")
    ? ok("fresh failure injected")
    : bad("fresh failure injected", JSON.stringify(ev.system))

  // 3. stale failure -> silent (lazy-loading contract)
  signal(now - TTL * 2)
  const ev2 = contextEvent()
  state.contextHooks[0](ev2)
  ev2.system.length === 0
    ? ok("stale failure silent")
    : bad("stale failure silent", JSON.stringify(ev2.system))

  // 4. V3 ctx -> loud refusal
  try {
    plugin.setup(makeCtx({ version: "3.0.0" }).ctx)
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
    const clean = plugin.setup(ctx)
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

  // 6. config validation: unknown on / deliver / broken jsonc / bad model
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
      ["broken jsonc", `{ broken`, "failed to parse"],
    ]
    let allOk = true
    const whys = []
    for (const [name, jsonc, needle] of cases) {
      const sb = rootSandbox(); sb.use(); sb.write(jsonc)
      try {
        const c = plugin.setup(makeCtx().ctx)
        c() // must not leak a watcher when setup wrongly succeeds
        allOk = false; whys.push(`${name}: no throw`)
      } catch (e) {
        if (!String(e.message).includes(needle)) { allOk = false; whys.push(`${name}: ${e.message}`) }
      }
    }
    allOk ? ok("config validation loud") : bad("config validation loud", whys.join(" | "))
  }

  // 7. probe gating: recipes configured but generate/storage missing -> refuse;
  //    event.subscribe missing even without recipes -> refuse
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"x":{"on":"failure","model":"p/m","prompt":"p","deliver":"outbox"}}}`)
    try {
      const c = plugin.setup(makeCtx({ omit: ["generate"] }).ctx)
      c()
      bad("probe gating refuses", "missing generate.text did not throw")
    } catch (e) {
      String(e.message).includes("ctx.generate.text")
        ? ok("probe gating refuses")
        : bad("probe gating refuses", e.message)
    }
    try {
      const c = plugin.setup(makeCtx({ omit: ["event"] }).ctx)
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
    const clean = plugin.setup(ctx)
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
    const clean = plugin.setup(ctx)
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
    const clean = plugin.setup(ctx)
    await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" }, () => state.generateCalls.length, 1)
    atomicSignal(sb.dataDir, { ts: "x", epoch: now + 1, cwd: "/w", exit: 2, cmd: "y" })
    await new Promise((r) => setTimeout(r, 400))
    state.generateCalls.length === 1 && Object.keys(state.storage).some((k) => k.startsWith("zom/rate/hint/"))
      ? ok("ratePerHour gates via storage")
      : bad("ratePerHour gates via storage", `calls=${state.generateCalls.length} keys=${JSON.stringify(Object.keys(state.storage))}`)
    clean()
  }

  // 11. deliver=next-session: lands in context injection with [zom:name] tag;
  //     expires after ttlSeconds (ttl:0 => any later hook sees it gone; the
  //     failure TTL line, a different signal, legitimately persists)
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"next-session","ttlSeconds":0}}}`)
    const { ctx, state } = makeCtx()
    const clean = plugin.setup(ctx)
    const gotHook = await fireViaWatcher(sb.dataDir, { ts: "x", epoch: now, cwd: "/w", exit: 1, cmd: "x" }, () => state.generateCalls.length, 1)
      && readOutbox(sb.dataDir).length === 0
    const evx = contextEvent()
    state.contextHooks[0](evx)
    const line = evx.system.find((s) => s.text.startsWith("[zom:hint]"))
    gotHook && line && line.text.includes("hint for p")
      ? ok("next-session injects tagged output")
      : bad("next-session injects tagged output", JSON.stringify(evx.system))
    await new Promise((r) => setTimeout(r, 1200))
    const evy = contextEvent()
    state.contextHooks[0](evy)
    !evy.system.some((s) => s.text.startsWith("[zom:"))
      ? ok("next-session output expires after ttl")
      : bad("next-session output expires after ttl", JSON.stringify(evy.system))
    clean()
  }

  // 12. manual recipe: registered as a tool, fires through the same pipeline
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"explain":{"on":"manual","model":"p/m","prompt":"explain {cmd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = plugin.setup(ctx)
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
    const clean = plugin.setup(ctx)
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
    const clean = plugin.setup(ctx)
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
    const clean = plugin.setup(ctx)
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

  // 15. recipes config with no matching signals leaves zero injection
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"hint":{"on":"failure","model":"p/m","prompt":"p","deliver":"next-session"}}}`)
    const { ctx, state } = makeCtx()
    const clean = plugin.setup(ctx)
    const evz = contextEvent()
    state.contextHooks[0](evz)
    evz.system.length === 0
      ? ok("no signal no injection")
      : bad("no signal no injection", JSON.stringify(evz.system))
    clean()
  }

  // 17. outbox rotation: past 1MB the append keeps the last ≤64KB of complete
  //     lines and drops the ancient prefix (no backup file). Below the cap
  //     nothing is dropped; the zsh byte cursor recovers via its
  //     cursor>size → restart-from-zero rule, so replaying the tail is fine.
  {
    const sb = rootSandbox(); sb.use()
    sb.write(`{"recipes":{"explain":{"on":"manual","model":"p/m","prompt":"explain {cmd}","deliver":"outbox"}}}`)
    const { ctx, state } = makeCtx()
    const clean = plugin.setup(ctx)
    const tool = state.tools.find((t) => t.name === "zom_recipe_explain")
    const outbox = join(sb.dataDir, "outbox.jsonl")
    // uniform-length pad records keep the retained-tail math exact
    const padLine = (i) =>
      JSON.stringify({ n: String(i).padStart(6, "0"), kind: "pad", text: `pad-${String(i).padStart(6, "0")}-` + "x".repeat(60) }) + "\n"
    const L = padLine(0).length

    // below the cap: append only, nothing dropped
    writeFileSync(outbox, padLine(0) + padLine(1))
    await tool.execute({ cmd: "small append" })
    const small = readOutbox(sb.dataDir)
    small.length === 3 && small[0].kind === "pad" && small[2].text === "hint for explain small append"
      ? ok("rotation below cap keeps everything")
      : bad("rotation below cap keeps everything", JSON.stringify(small.map((r) => r.kind ?? r.recipe)))

    // over the cap: seed >1MB of complete pad lines plus a torn trailing
    // fragment (a crashed append's leftover); the new append must rotate,
    // keep only the last ≤64KB of complete lines, and land its own record
    const N = 12000
    let seed = ""
    for (let i = 0; i < N; i++) seed += padLine(i)
    seed += `{"kind":"torn","text":"never completed`
    if (seed.length <= 1_000_000) bad("rotation seed size", `seed only ${seed.length} bytes`)
    writeFileSync(outbox, seed)
    await tool.execute({ cmd: "rotate me" })
    const raw = readFileSync(outbox, "utf8")
    let parseOk = true
    const recs = []
    for (const l of raw.split("\n").filter(Boolean)) {
      try { recs.push(JSON.parse(l)) } catch { parseOk = false }
    }
    const pads = recs.filter((r) => r.kind === "pad")
    const ids = pads.map((r) => Number(r.n))
    const last = recs[recs.length - 1]
    const padBytes = pads.length * L
    // retained pads are the maximal suffix fitting 64KB at line granularity
    const tailKept = padBytes <= 64 * 1024 && padBytes > 64 * 1024 - L
    parseOk && raw.endsWith("\n") && !raw.includes("torn")
      && ids.every((v, i) => v === ids[0] + i) && ids[ids.length - 1] === N - 1
      && tailKept
      && last?.recipe === "explain" && last?.text === "hint for explain rotate me"
      && !existsSync(`${outbox}.tmp`)
      ? ok("rotation keeps aligned tail, drops prefix and torn fragment")
      : bad("rotation keeps aligned tail, drops prefix and torn fragment",
          JSON.stringify({ parseOk, endsNl: raw.endsWith("\n"), torn: raw.includes("torn"),
            firstId: ids[0], lastId: ids[ids.length - 1], padBytes, last }))
    clean()
  }
} catch (e) {
  bad("suite crashed", e.stack || e.message)
}

console.log(`companion.test: ${pass + fail} checks, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
