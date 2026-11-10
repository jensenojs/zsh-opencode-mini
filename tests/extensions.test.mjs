// Unit tests for the extensions layer: policy modules (state-watch) on a
// mock host, plus companion's isolation guarantees
// (loadExtensions scans ZOM_CONFIG's dir; a broken extension dies alone).
// Run: node tests/extensions.test.mjs
// Also driven by tests/run.zsh (S10b).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, utimesSync, statSync, readdirSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import stateWatch from "../extensions/state-watch.js"
import idleCompact from "../extensions/idle-compact.js"
import sessionTitle from "../extensions/session-title.js"
import { loadExtensions, resetGenerationState, trimTailFile } from "../companion.js"

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`)
  }
}

function makeCtx() {
  const hooks = new Map()
  const ctx = {
    session: {
      // Async like the real surface: a loader that does not await hook
      // registration loses the hook entirely here.
      async hook(event, handler) {
        await null
        if (!hooks.has(event)) hooks.set(event, [])
        hooks.get(event).push(handler)
      },
    },
  }
  return {
    ctx,
    fire(event, arg) {
      for (const h of hooks.get(event) ?? []) h(arg)
    },
  }
}

function makeHost(backend = new Map(), agent = "mini") {
  const reports = []
  const listeners = []
  const host = {
    agent,
    report: (m) => reports.push(String(m)),
    onUsageDelta: (cb) => listeners.push(cb),
    storage: (key) => ({
      get: () => (backend.has(key) ? JSON.parse(backend.get(key)) : undefined),
      set: (v) => backend.set(key, JSON.stringify(v)),
    }),
    dataDir: tmpdir(),
    // The plugin instance's location: the shared server knows it, the process
    // does not (its cwd is where the server was launched).
    directory: "/workspace",
    // The host merges its documented defaults into the companion section before
    // any extension sees it; mirror that here so "absent knob" means a host
    // too old to run the extension, not a value nobody filled.
    config: {
      failureTtlSeconds: 600,
      recentDefaultN: 20,
      recipeTtlSeconds: 900,
      repeatFailureThreshold: 3,
      autoTitle: "idle",
      autoTitleIdleMinutes: 54,
    },
    // Extensions deliver through this one channel; the test assembles the same
    // tail shape the host does.
    inject: (event, text) => {
      event.messages.push({ role: "system", content: [{ type: "text", text }] })
    },
    // The real cutter, not a mock of it: the test asserts the semantics of
    // trimming a torn tail, so a re-implementation here would assert nothing.
    // Same for the directory facts state-watch asks for.
    files: {
      trimTail: trimTailFile,
      entries: () =>
        readdirSync(host.dataDir).flatMap((name) => {
          try {
            const st = statSync(join(host.dataDir, name))
            return [{ name, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }]
          } catch {
            return []
          }
        }),
      remove: (name) => {
        try {
          unlinkSync(join(host.dataDir, name))
          return true
        } catch {
          return false
        }
      },
    },
  }
  return { host, reports, listeners, backend }
}

function delta(ext, sid, dInput, dRead) {
  ext({ sid, dInput, dRead })
}

// --- state-watch -----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "zom-ext-state-"))
  const { ctx } = makeCtx()
  const { host, reports, listeners } = makeHost()
  host.dataDir = dir
  await stateWatch.setup(ctx, host)
  const bump = () => delta(listeners[0], "x", 1, 0)

  // The outbox rotates here, not on the append path: same cap, same tail.
  const outboxBig = ("y".repeat(99) + "\n").repeat(12 * 1024)
  writeFileSync(join(dir, "outbox.jsonl"), outboxBig)
  for (let i = 0; i < 50; i++) bump()
  const outboxTail = readFileSync(join(dir, "outbox.jsonl"), "utf8")
  check("oversized outbox trimmed", statSync(join(dir, "outbox.jsonl")).size <= 64 * 1024 + 128)
  check("outbox trim keeps the tail", outboxTail.endsWith(outboxBig.slice(-64)))
  check("outbox trim names the file", reports.some((m) => m.includes("outbox.jsonl")))

  const old = join(dir, "passthrough.111.keys.log")
  const fresh = join(dir, "passthrough.222.keys.log")
  writeFileSync(old, "keys")
  writeFileSync(fresh, "keys")
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(old, weekAgo, weekAgo)
  for (let i = 0; i < 50; i++) bump()
  check("stale keys.log removed", !existsSync(old))
  check("fresh keys.log kept", existsSync(fresh))
  for (const f of readdirSync(dir)) unlinkSync(join(dir, f))
}

// --- session-title ---------------------------------------------------------
{
  const shared = new Map()
  const boot = (config, agent = "mini") => {
    const c = makeCtx()
    const updates = []
    // The capability the extension is allowed to use: one retitle door, no raw
    // session object. The assertions below read the same {sessionID,title}.
    const h = makeHost(shared, agent)
    h.host.session = { retitle: async (sessionID, title) => updates.push({ sessionID, title }) }
    if (config) h.host.config = { ...h.host.config, ...config }
    return { c, h, updates }
  }
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
  const fire = (c, sid, agent = "mini") =>
    c.fire("context", { sessionID: sid, system: [], messages: [user("下一个任务")], agent })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  // The policy is time-based; drive Date.now instead of sleeping.
  const clock = (start) => {
    const real = Date.now
    let now = start
    Date.now = () => now
    return {
      advance: (ms) => {
        now += ms
      },
      restore: () => {
        Date.now = real
      },
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot()
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_a")
      await tick()
      check("the first request only seeds the clock", updates.length === 0)
      t.advance(60_000)
      fire(c, "ses_a")
      await tick()
      check("a prompt inside the idle window keeps the name", updates.length === 0)
    } finally {
      t.restore()
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot()
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_b")
      t.advance(90 * 60_000)
      fire(c, "ses_b")
      await tick()
      check("a prompt after a long silence regenerates the title", updates.length === 1)
      check(
        "regeneration goes through the empty-title path",
        updates[0]?.title === "" && updates[0]?.sessionID === "ses_b",
      )
      t.advance(60_000)
      fire(c, "ses_b")
      await tick()
      check("one regeneration per idle gap", updates.length === 1)
      t.advance(90 * 60_000)
      fire(c, "ses_b")
      await tick()
      check("the next idle gap renames again", updates.length === 2)
    } finally {
      t.restore()
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot({ autoTitleIdleMinutes: 600 })
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_c")
      t.advance(90 * 60_000)
      fire(c, "ses_c")
      await tick()
      check("the idle threshold comes from config", updates.length === 0)
    } finally {
      t.restore()
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot({ autoTitle: "off" })
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_d")
      t.advance(24 * 3600_000)
      fire(c, "ses_d")
      await tick()
      check("autoTitle = off disables it", updates.length === 0)
    } finally {
      t.restore()
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot()
      // A host too old to fill the knob: say it, don't invent a number.
      h.host.config = {}
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_f")
      t.advance(90 * 60_000)
      fire(c, "ses_f")
      await tick()
      check(
        "a host without autoTitleIdleMinutes is reported, not guessed",
        updates.length === 0 && h.reports.some((r) => r.includes("autoTitleIdleMinutes missing")),
      )
    } finally {
      t.restore()
    }
  }

  {
    const t = clock(1_800_000_000_000)
    try {
      const { c, h, updates } = boot()
      await sessionTitle.setup(c.ctx, h.host)
      fire(c, "ses_e", "orchestrator")
      t.advance(90 * 60_000)
      fire(c, "ses_e", "orchestrator")
      await tick()
      check("other agents' sessions are not renamed", updates.length === 0)
    } finally {
      t.restore()
    }
  }
}

// --- isolation via loadExtensions ------------------------------------------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-iso-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-data-"))
  mkdirSync(join(cfgDir, "extensions"))
  // The problem text itself now lives in a policy extension (extension-health),
  // so a sandbox that only holds broken fixtures has nobody to say anything.
  copyFileSync(
    new URL("../extensions/extension-health.js", import.meta.url),
    join(cfgDir, "extensions", "extension-health.js"),
  )
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')
  writeFileSync(join(cfgDir, "extensions", "bad.js"), `export default { setup() {{{ `)
  writeFileSync(
    join(cfgDir, "extensions", "dup.js"),
    `import { appendFileSync } from "node:fs"\n` +
      `export default { id: "good", async setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "good says hi"))\n` +
      `  appendFileSync(host.dataDir + "/good.marker", "x")\n` +
      `} }`,
  )
  writeFileSync(
    join(cfgDir, "extensions", "good.js"),
    `import { appendFileSync } from "node:fs"\n` +
      `export default { id: "good", async setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "good says hi"))\n` +
      `  appendFileSync(host.dataDir + "/good.marker", "x")\n` +
      `} }`,
  )
  writeFileSync(
    join(cfgDir, "extensions", "boomer.js"),
    `export default { id: "boomer", async setup(ctx, host) {\n` +
      `  ctx.session.hook("context", () => { throw new Error("boom") })\n` +
      `} }`,
  )

  const prevCfg = process.env.ZOM_CONFIG
  process.env.ZOM_CONFIG = join(cfgDir, "config.toml")
  const { ctx, fire } = makeCtx()
  await loadExtensions(ctx, dataDir)
  const event = { system: [], messages: [], agent: "mini" }
  // Turn 1: hooks run, boomer's throw is caught and reported for next turn.
  // Turn 2: the drain surfaces everything reported so far.
  fire("context", event)
  fire("context", event)
  // A host-level failure must not follow the user into unrelated sessions.
  const other = { system: [], messages: [], agent: "build" }
  fire("context", other)
  check("extension problems stay out of other agents' sessions", other.messages.length === 0)
  process.env.ZOM_CONFIG = prevCfg

  // Two files claim id "good": refusing both is the contract — running the
  // one that happens to sort first is how a stale build keeps winning.
  check("duplicate id loads neither claimant", !existsSync(join(dataDir, "good.marker")))
  const text = event.messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  check("duplicate report names both files", text.includes("good.js") && text.includes("dup.js"))
  check("bad.js load failure attributed", text.includes("bad") && text.includes("failed to load"))
  check("boomer runtime failure attributed", text.includes("boomer") && text.includes("boom"))
  check("problems surfaced through the drain", text.includes("extension problem"))
  check("duplicate id refused loudly", text.includes("duplicate extension id"))
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

// --- uninstalling an extension takes its state with it ----------------------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-uninstall-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-uninstalldata-"))
  mkdirSync(join(cfgDir, "extensions"))
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')
  const file = join(cfgDir, "extensions", "keeper.js")
  writeFileSync(
    file,
    `export default { id: "zom-keeper", setup(ctx, host) {\n` +
      `  host.storage("zom-keeper").set({ n: 1 })\n` +
      `  host.kv.set("seen", 1)\n` +
      `  ctx.session.hook("context", () => {})\n` +
      `} }`,
  )
  // A shared channel is named after no extension, so an uninstall must leave it.
  const shared = join(dataDir, "outbox.jsonl")
  writeFileSync(shared, "record\n")

  const prevCfg = process.env.ZOM_CONFIG
  process.env.ZOM_CONFIG = join(cfgDir, "config.toml")
  const first = makeCtx()
  await loadExtensions(first.ctx, dataDir)
  check("storage file exists while installed", existsSync(join(dataDir, "zom-keeper.json")))
  check("kv file exists while installed", existsSync(join(dataDir, "zom-keeper.kv.json")))
  check(
    "rollback artifacts exist while installed",
    readdirSync(join(dataDir, "ext-good")).some((f) => f.startsWith("keeper.")),
  )

  // Exactly what the installer does to an extension removed from the mirror.
  unlinkSync(file)
  const second = makeCtx()
  await loadExtensions(second.ctx, dataDir)
  check("storage file removed with the extension", !existsSync(join(dataDir, "zom-keeper.json")))
  check("kv file removed with the extension", !existsSync(join(dataDir, "zom-keeper.kv.json")))
  check(
    "rollback artifacts removed with the extension",
    !readdirSync(join(dataDir, "ext-good")).some((f) => f.startsWith("keeper.")),
  )
  check("shared channel survives an uninstall", existsSync(shared))
  const owned = JSON.parse(readFileSync(join(dataDir, "ext-owned.json"), "utf8"))
  check("registry forgets the uninstalled extension", !("keeper.js" in owned))
  process.env.ZOM_CONFIG = prevCfg
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

// --- idle compaction: only the mini's own conversation ----------------------
{
  const { ctx } = makeCtx()
  const reports = []
  const compacted = []
  const prompts = []
  const sessions = {
    ses_root: { sessionID: "ses_root", agent: "mini" },
    ses_child: { sessionID: "ses_child", agent: "mini", parentID: "ses_root" },
    ses_other: { sessionID: "ses_other", agent: "build" },
  }
  const listeners = []
  const host = {
    agent: "mini",
    // 12ms of idleness: same policy as the 30-minute default, just observable.
    config: { idleCompact: { idleMinutes: 0.0002 } },
    report: (msg) => reports.push(msg),
    onUsageDelta: (cb) => listeners.push(cb),
    compactionPrompt: (text) => prompts.push(text),
    session: {
      get: async (sessionID) => sessions[sessionID],
      compact: async (sessionID) => compacted.push(sessionID),
    },
  }
  await idleCompact.setup(ctx, host)
  check("compaction instruction is registered", prompts.length === 1)
  check("instruction drops finished work", prompts[0].includes("Drop the process of finished tasks"))

  listeners[0]({ sid: "ses_root", dInput: 250_000, dRead: 20_000, dWrite: 0 })
  await new Promise((r) => setTimeout(r, 60))
  check("an idle root session is compacted", compacted.length === 1 && compacted[0] === "ses_root")

  // Compaction reports usage of its own; the quiet window keeps that from
  // arming the next one without the user ever sending a prompt.
  listeners[0]({ sid: "ses_root", dInput: 250_000, dRead: 20_000, dWrite: 0 })
  await new Promise((r) => setTimeout(r, 60))
  check("compaction does not repeat inside the quiet window", compacted.length === 1)

  listeners[0]({ sid: "ses_child", dInput: 250_000, dRead: 20_000, dWrite: 0 })
  listeners[0]({ sid: "ses_other", dInput: 250_000, dRead: 20_000, dWrite: 0 })
  await new Promise((r) => setTimeout(r, 60))
  check("subagent and other-agent sessions are not compacted", compacted.length === 1)
  check("no host problems reported", reports.length === 0)
}

// --- idle compaction: the timer is a hint, the session is the authority -----
{
  const { ctx } = makeCtx()
  const compacted = []
  const disposers = []
  const listeners = []
  const sessions = {
    // Last written to a moment ago: the idle window has barely started even
    // though a timer armed for it has already come due.
    ses_fresh: { sessionID: "ses_fresh", agent: "mini", time: { updated: Date.now() } },
  }
  const host = {
    agent: "mini",
    config: { idleCompact: { idleMinutes: 0.002 } }, // 120ms
    report: () => {},
    onUsageDelta: (cb) => listeners.push(cb),
    onDispose: (cb) => disposers.push(cb),
    compactionPrompt: () => {},
    session: {
      get: async (sessionID) => sessions[sessionID],
      compact: async (sessionID) => compacted.push(sessionID),
    },
  }
  await idleCompact.setup(ctx, host)
  check("the generation registers a disposer", disposers.length === 1)

  listeners[0]({ sid: "ses_fresh", dInput: 250_000, dRead: 20_000, dWrite: 0 })
  await new Promise((r) => setTimeout(r, 80))
  check("a session touched after the timer was armed is not compacted", compacted.length === 0)

  // The recheck re-arms for the remainder of the window instead of dropping it.
  await new Promise((r) => setTimeout(r, 120))
  check("it compacts once the session has actually been idle", compacted[0] === "ses_fresh")

  disposers[0]()
  const before = compacted.length
  listeners[0]({ sid: "ses_fresh", dInput: 250_000, dRead: 20_000, dWrite: 0 }) // arm a timer for this generation
  disposers[0]() // then drop the generation that owns it
  sessions.ses_fresh.time.updated = Date.now() - 10_000
  await new Promise((r) => setTimeout(r, 200))
  check("a disposed generation leaves no timer behind", compacted.length === before)
}

// --- idle compaction: size decides whether there is anything worth doing ---
{
  const { ctx } = makeCtx()
  const compacted = []
  const listeners = []
  const sessions = {
    ses_small: { sessionID: "ses_small", agent: "mini" },
  }
  const host = {
    agent: "mini",
    config: { idleCompact: { idleMinutes: 0.0002 } }, // 12ms
    report: () => {},
    onUsageDelta: (cb) => listeners.push(cb),
    compactionPrompt: () => {},
    session: {
      get: async (sessionID) => sessions[sessionID],
      compact: async (sessionID) => compacted.push(sessionID),
    },
  }
  await idleCompact.setup(ctx, host)

  // The summary a compaction leaves behind is small; a delta that shrinks the
  // conversation must drop the timer armed by the larger one, or the summary
  // gets summarized again without the user sending anything.
  listeners[0]({ sid: "ses_small", dInput: 250_000, dRead: 0, dWrite: 0 })
  listeners[0]({ sid: "ses_small", dInput: 60_000, dRead: 10_000, dWrite: 0 }) // 70k
  await new Promise((r) => setTimeout(r, 60))
  check("a shrinking conversation cancels the armed compaction", compacted.length === 0)

  listeners[0]({ sid: "ses_small", dInput: 160_000, dRead: 20_000, dWrite: 0 }) // 180k
  await new Promise((r) => setTimeout(r, 60))
  check("a conversation under the floor is not compacted", compacted.length === 0)

  listeners[0]({ sid: "ses_small", dInput: 230_000, dRead: 20_000, dWrite: 0 }) // 250k
  await new Promise((r) => setTimeout(r, 60))
  check("a conversation over the floor is compacted", compacted[0] === "ses_small")
}

// --- idle compaction: a refusal is a verdict, not a retry ------------------
{
  const { ctx } = makeCtx()
  const compacted = []
  const reports = []
  const listeners = []
  const sessions = { ses_full: { sessionID: "ses_full", agent: "mini" } }
  const host = {
    agent: "mini",
    config: { idleCompact: { idleMinutes: 30 } },
    report: (msg) => reports.push(msg),
    onUsageDelta: (cb) => listeners.push(cb),
    compactionPrompt: () => {},
    session: {
      get: async (sessionID) => sessions[sessionID],
      // The server's answer when the history outside the keep window is empty.
      compact: async (sessionID) => {
        compacted.push(sessionID)
        throw new Error("Nothing to compact yet")
      },
    },
  }
  // The retry cadence is measured in minutes; the clock is the only way to see
  // it without waiting. Date rides along so the idle recheck reads the same one.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  try {
    await idleCompact.setup(ctx, host)
    listeners[0]({ sid: "ses_full", dInput: 250_000, dRead: 20_000, dWrite: 0 }) // 270k
    mock.timers.tick(30 * 60_000)
    await new Promise((r) => setImmediate(r))
    check("the first idle window asks once", compacted.length === 1)
    check("a refusal is not reported as a failure", reports.length === 0)

    // Same size: the question already has an answer.
    listeners[0]({ sid: "ses_full", dInput: 250_000, dRead: 20_000, dWrite: 0 })
    mock.timers.tick(30 * 60_000)
    await new Promise((r) => setImmediate(r))
    check("a refusal is not retried at the same size", compacted.length === 1)

    // Grown past the refusal: worth asking again.
    listeners[0]({ sid: "ses_full", dInput: 400_000, dRead: 20_000, dWrite: 0 }) // 420k
    mock.timers.tick(30 * 60_000)
    await new Promise((r) => setImmediate(r))
    check("growth past the refusal asks again", compacted.length === 2)
  } finally {
    mock.timers.reset()
  }
}

// --- idle compaction: a working subagent keeps the parent awake ------------
{
  const { ctx } = makeCtx()
  const compacted = []
  const listeners = []
  const sessions = {
    // The parent has been quiet for a while: only the child is working.
    ses_parent: { sessionID: "ses_parent", agent: "mini", time: { updated: Date.now() - 60_000 } },
    ses_child: { sessionID: "ses_child", agent: "general", parentID: "ses_parent" },
  }
  const host = {
    agent: "mini",
    config: { idleCompact: { idleMinutes: 0.005 } }, // 300ms
    report: () => {},
    onUsageDelta: (cb) => listeners.push(cb),
    compactionPrompt: () => {},
    session: {
      get: async (sessionID) => sessions[sessionID],
      compact: async (sessionID) => compacted.push(sessionID),
    },
  }
  await idleCompact.setup(ctx, host)

  listeners[0]({ sid: "ses_parent", dInput: 300_000, dRead: 0, dWrite: 0 }) // arm 300ms
  await new Promise((r) => setTimeout(r, 100))
  listeners[0]({ sid: "ses_child", dInput: 5_000, dRead: 0, dWrite: 0 }) // still working
  await new Promise((r) => setTimeout(r, 240)) // past the parent's own timer
  check("a working subagent holds off the parent's compaction", compacted.length === 0)
  await new Promise((r) => setTimeout(r, 250)) // past the window measured from the child
  check("it compacts once the child has been quiet too", compacted[0] === "ses_parent")
}

// --- generation cleanup: a reload takes back what the last one armed --------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-dispose-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-disposedata-"))
  mkdirSync(join(cfgDir, "extensions"))
  const marker = join(dataDir, "disposed.txt")
  writeFileSync(
    join(cfgDir, "extensions", "armed.js"),
    `import { writeFileSync } from "node:fs"\n` +
      `export default { id: "armed", setup(ctx, host) {\n` +
      `  host.onDispose(() => writeFileSync(${JSON.stringify(marker)}, "disposed"))\n` +
      `} }\n`,
  )
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')

  const prevCfg = process.env.ZOM_CONFIG
  process.env.ZOM_CONFIG = join(cfgDir, "config.toml")
  await loadExtensions(makeCtx().ctx, dataDir)
  check("a disposer does not run while its generation lives", !existsSync(marker))
  resetGenerationState()
  check("a reload runs what the previous generation registered", existsSync(marker))
  process.env.ZOM_CONFIG = prevCfg
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

// --- rolling upgrade: a broken version rolls back, once ---------------------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-roll-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-rolldata-"))
  mkdirSync(join(cfgDir, "extensions"))
  copyFileSync(
    new URL("../extensions/extension-health.js", import.meta.url),
    join(cfgDir, "extensions", "extension-health.js"),
  )
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')
  const file = join(cfgDir, "extensions", "roll.js")
  writeFileSync(
    file,
    `export default { id: "roll", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "v1 alive"))\n` +
      `} }`,
  )

  const prevCfg = process.env.ZOM_CONFIG
  process.env.ZOM_CONFIG = join(cfgDir, "config.toml")

  const first = makeCtx()
  await loadExtensions(first.ctx, dataDir)
  const e1 = { system: [], messages: [], agent: "mini" }
  first.fire("context", e1)
  check("first load registers the extension", e1.messages.some((m) => m.content.some((p) => p.text === "v1 alive")))

  // A version that cannot even parse must not take the working one with it.
  writeFileSync(file, `export default { setup() {{{`)
  const second = makeCtx()
  await loadExtensions(second.ctx, dataDir)
  const e2 = { system: [], messages: [], agent: "mini" }
  second.fire("context", e2)
  const drain2 = { system: [], messages: [], agent: "mini" }
  second.fire("context", drain2)
  const text2 = [...e2.messages, ...drain2.messages]
    .map((m) => m.content.map((p) => p.text).join(""))
    .join("\n")
  check("broken version rolls back to the last good one", e2.messages.some((m) => m.content.some((p) => p.text === "v1 alive")))
  check("rollback is reported", text2.includes("rolled back"))
  check("broken bytes are kept", existsSync(join(dataDir, "ext-good", "roll.js.broken")))

  // The same broken content is not retried, and not re-reported, on every load.
  const third = makeCtx()
  await loadExtensions(third.ctx, dataDir)
  const e3 = { system: [], messages: [], agent: "mini" }
  third.fire("context", e3)
  const drain3 = { system: [], messages: [], agent: "mini" }
  third.fire("context", drain3)
  check("quarantined content still runs the good copy", e3.messages.some((m) => m.content.some((p) => p.text === "v1 alive")))
  const quiet3 = [...e3.messages, ...drain3.messages]
    .map((m) => m.content.map((p) => p.text).join(""))
    .join("\n")
  check("quarantine stays quiet", !quiet3.includes("rolled back") && !quiet3.includes("failed to load"))

  // Fixing the source is a new hash: tried again, and it becomes the good copy.
  writeFileSync(
    file,
    `export default { id: "roll", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "v2 alive"))\n` +
      `} }`,
  )
  const fourth = makeCtx()
  await loadExtensions(fourth.ctx, dataDir)
  const e4 = { system: [], messages: [], agent: "mini" }
  fourth.fire("context", e4)
  check("fixed version is tried and kept", e4.messages.some((m) => m.content.some((p) => p.text === "v2 alive")))

  // devPath: the working tree replaces the installed mirror.
  const devTree = mkdtempSync(join(tmpdir(), "zom-ext-dev-"))
  mkdirSync(join(devTree, "extensions"))
  writeFileSync(
    join(devTree, "extensions", "dev.js"),
    `export default { id: "dev", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "from dev tree"))\n` +
      `} }`,
  )
  const devCtx = makeCtx()
  await loadExtensions(devCtx.ctx, dataDir, "mini", { devPath: devTree })
  const e5 = { system: [], messages: [], agent: "mini" }
  devCtx.fire("context", e5)
  check("devPath loads the working tree", e5.messages.some((m) => m.content.some((p) => p.text === "from dev tree")))
  check("devPath replaces the mirror", !e5.messages.some((m) => m.content.some((p) => p.text === "v2 alive")))

  // The mechanism, not discipline: an extension that writes the cached prefix
  // gets a frozen copy and a loud failure, and the real prefix stays intact.
  const guardDir = mkdtempSync(join(tmpdir(), "zom-ext-guard-"))
  mkdirSync(join(guardDir, "extensions"))
  copyFileSync(
    new URL("../extensions/extension-health.js", import.meta.url),
    join(guardDir, "extensions", "extension-health.js"),
  )
  writeFileSync(join(guardDir, "config.toml"), '[shell]\nbinary = "x"\n')
  writeFileSync(
    join(guardDir, "extensions", "writer.js"),
    `export default { id: "writer", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => { event.system.push({ type: "text", text: "silently expensive" }) })\n` +
      // The array freeze alone left this one silent: mutating a part rewrote
      // the cached prefix without any error.
      `  ctx.session.hook("context", (event) => { event.system[0].text = "PWNED" })\n` +
      `} }`,
  )
  process.env.ZOM_CONFIG = join(guardDir, "config.toml")
  const guard = makeCtx()
  await loadExtensions(guard.ctx, dataDir)
  const gp = { system: [{ type: "text", text: "prefix" }], messages: [], agent: "mini" }
  guard.fire("context", gp)
  const gd = { system: [], messages: [], agent: "mini" }
  guard.fire("context", gd)
  const guardText = gd.messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  check("writing the cached prefix is refused", gp.system.length === 1)
  check("mutating a prefix part is refused too", gp.system[0].text === "prefix")
  check("the refusal is reported to the agent", guardText.includes("writer"))

  // The tail is the other half of the same promise: appending through the view
  // would be an unaudited way around host.inject, and any ctx surface beyond
  // session.hook is not offered at all.
  writeFileSync(
    join(guardDir, "extensions", "mutator.js"),
    `export default { id: "mutator", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => { event.messages.push({ role: "system", content: [{ type: "text", text: "smuggled" }] }) })\n` +
      `  ctx.session.hook("context", () => { ctx.session.update({ title: "x" }) })\n` +
      `} }`,
  )
  const guard2 = makeCtx()
  await loadExtensions(guard2.ctx, dataDir)
  const gm = { system: [], messages: [], agent: "mini" }
  guard2.fire("context", gm)
  const gmDrain = { system: [], messages: [], agent: "mini" }
  guard2.fire("context", gmDrain)
  const guardText2 = gmDrain.messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  check("the message tail is read-only too", !gm.messages.some((m) => m.content.some((p) => p.text === "smuggled")))
  check("only the context hook is offered", guardText2.includes("mutator") && guardText2.includes("not a function"))
  rmSync(guardDir, { recursive: true, force: true })

  process.env.ZOM_CONFIG = prevCfg
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(devTree, { recursive: true, force: true })
}

// --- imports fine, throws in setup(): the working copy must survive ---------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-setup-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-setupdata-"))
  mkdirSync(join(cfgDir, "extensions"))
  copyFileSync(
    new URL("../extensions/extension-health.js", import.meta.url),
    join(cfgDir, "extensions", "extension-health.js"),
  )
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')
  const file = join(cfgDir, "extensions", "boom.js")
  writeFileSync(
    file,
    `export default { id: "boom", setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => host.inject(event, "v1 alive"))\n` +
      `} }`,
  )
  const prevCfg = process.env.ZOM_CONFIG
  process.env.ZOM_CONFIG = join(cfgDir, "config.toml")

  const first = makeCtx()
  await loadExtensions(first.ctx, dataDir)
  const goodDir = join(dataDir, "ext-good")
  const copies = () => readdirSync(goodDir).filter((f) => f.startsWith("boom.") && f.endsWith(".js"))
  check("setup success records the last-good copy", copies().length === 1)
  const goodHash = copies()[0].slice("boom.".length, -".js".length)

  // This is the failure a syntax check cannot catch, and the one that used to
  // destroy the version that works: the copy was promoted at import time.
  writeFileSync(file, `export default { id: "boom", setup() { throw new Error("boom in setup") } }`)
  const second = makeCtx()
  await loadExtensions(second.ctx, dataDir)
  const e2 = { system: [], messages: [], agent: "mini" }
  second.fire("context", e2)
  const drain2 = { system: [], messages: [], agent: "mini" }
  second.fire("context", drain2)
  const text2 = [...e2.messages, ...drain2.messages]
    .map((m) => m.content.map((p) => p.text).join(""))
    .join("\n")
  check("a setup failure keeps the previous last-good copy", copies().length === 1 && copies()[0].includes(goodHash))
  check("a setup failure keeps the broken bytes", existsSync(join(goodDir, "boom.js.broken")))
  const state = JSON.parse(readFileSync(join(goodDir, "boom.js.json"), "utf8"))
  check("a setup failure does not promote the broken hash", state.hash === goodHash)
  check("a setup failure rolls back to the working version", e2.messages.some((m) => m.content.some((p) => p.text === "v1 alive")))
  check("a setup failure is reported", text2.includes("rolled back"))

  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  process.env.ZOM_CONFIG = prevCfg
}

// --- a devPath that does not resolve is said out loud ----------------------
// Silence here is the worst outcome: the user edits extensions in a working
// tree, nothing loads, and nothing says why.
{
  const root = mkdtempSync(join(tmpdir(), "zom-devmiss-"))
  const dataDir = join(root, "data")
  mkdirSync(dataDir, { recursive: true })
  const { ctx, fire } = makeCtx()
  await loadExtensions(ctx, dataDir, "mini", { devPath: join(root, "does-not-exist") })
  const event = { system: [], messages: [], agent: "mini" }
  fire("context", event)
  const text = event.messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  check(
    "a missing devPath is reported, not treated as no extensions",
    text.includes("could not be read") && text.includes("devPath"),
  )
  rmSync(root, { recursive: true, force: true })
}

// --- disk-watch ------------------------------------------------------------
{
  const { default: diskWatch, shouldWarn } = await import("../extensions/disk-watch.js")
  const HOUR = 60 * 60 * 1000
  check("disk-watch: below threshold never warns", shouldWarn(0.5, undefined, 1000) === false)
  check("disk-watch: at threshold warns once", shouldWarn(0.9, undefined, 1000) === true)
  check("disk-watch: inside cooldown stays quiet", shouldWarn(0.93, 1000, 1000 + 3 * HOUR) === false)
  check("disk-watch: after cooldown reminds", shouldWarn(0.93, 1000, 1000 + 7 * HOUR) === true)
  check("disk-watch: recovered disk re-arms silently", shouldWarn(0.8, 1000, 1000 + 7 * HOUR) === false)

  const fullStatfs = () => ({ blocks: 1000n, bsize: 4096n, bavail: 50n })
  const boot = (statfs) => {
    const c = makeCtx()
    const backend = new Map()
    const h = makeHost(backend).host
    h.dataDir = "/somewhere"
    if (statfs) h.statfs = statfs
    return { c, h, backend }
  }
  const event = (c) => {
    const messages = []
    c.fire("context", { sessionID: "ses_disk", system: [], messages, agent: "mini" })
    return messages.map((m) => m.content.map((p) => p.text).join("")).join("\n")
  }
  {
    const { c, h } = boot(fullStatfs)
    await diskWatch.setup(c.ctx, h)
    const first = event(c)
    check("disk-watch: a full disk injects a warning", first.includes("zom-disk-watch") && first.includes("95%"))
    const second = event(c)
    check("disk-watch: the next turn does not repeat it", second === "")
  }
  {
    // Cross-process reminder: a persisted lastWarnAt from seven hours ago,
    // disk still full — the fresh instance reminds.
    const { c, h } = boot(fullStatfs)
    h.storage("zom-disk-watch").set({ lastWarnAt: Date.now() - 7 * 60 * 60 * 1000 })
    await diskWatch.setup(c.ctx, h)
    check("disk-watch: past cooldown it reminds", event(c).includes("zom-disk-watch"))
  }
  {
    const { c, h } = boot(() => ({ blocks: 1000n, bsize: 4096n, bavail: 500n }))
    await diskWatch.setup(c.ctx, h)
    check("disk-watch: a half-full disk stays quiet", event(c) === "")
  }
  {
    const { c, h } = boot(() => {
      throw new Error("EIO")
    })
    await diskWatch.setup(c.ctx, h)
    check("disk-watch: a failing statfs is swallowed, not thrown", event(c) === "")
  }
  {
    // Only the mini's own conversation is nagged; subagents share the disk
    // but not the composer this notice would land in.
    const { c, h } = boot(fullStatfs)
    await diskWatch.setup(c.ctx, h)
    const messages = []
    c.fire("context", { sessionID: "ses_sub", system: [], messages, agent: "other-agent" })
    check("disk-watch: other agents are not injected", messages.length === 0)
  }
}

console.log(`extensions.test: ${pass} checks, ${fail} failed`)
// The exit code is what CI and run.zsh read; a FAIL line alone is a message in
// a bottle.
if (fail > 0) process.exitCode = 1
if (fail > 0) process.exit(1)
