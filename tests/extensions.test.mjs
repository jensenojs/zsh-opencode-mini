// Unit tests for the extensions layer: policy modules (cache-watch,
// state-watch) on a mock host, plus companion's isolation guarantees
// (loadExtensions scans ZOM_CONFIG's dir; a broken extension dies alone).
// Run: node tests/extensions.test.mjs
// Also driven by tests/run.zsh (S10b).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, utimesSync, statSync, readdirSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import cacheWatch from "../extensions/cache-watch.js"
import stateWatch from "../extensions/state-watch.js"
import sessionTitle from "../extensions/session-title.js"
import { loadExtensions, trimTailFile } from "../companion.js"

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

// --- cache-watch -----------------------------------------------------------
{
  const shared = new Map()
  const boot = () => {
    const c = makeCtx()
    const h = makeHost(shared)
    return { c, h }
  }
  const sid = "ses_test"
  const prefix = (extra = "") => [{ type: "text", text: "core instructions" + extra }]
  const turn = (c, system) => {
    const messages = []
    c.fire("context", { sessionID: sid, system, messages, agent: "mini" })
    return messages.map((m) => m.content.map((p) => p.text).join(""))
  }

  let { c, h } = boot()
  await cacheWatch.setup(c.ctx, h.host)

  check("first request only seeds the baseline", turn(c, prefix()).length === 0)
  check("baseline persisted", JSON.parse(shared.get("zom-cache-watch")).hashes[sid]?.length > 0)
  check("unchanged prefix stays quiet", turn(c, prefix()).length === 0)

  const fired = turn(c, prefix(" v2"))
  check("changed prefix fires on that request", fired.length === 1 && fired[0].includes("prompt prefix changed"))
  check("notice explains the re-pay", fired[0].includes("re-pays at uncached rates"))
  {
    // A directory move rewrites only the tail <env> block: cheap, and the
    // whole point of the shared-prefix hash is not to cry wolf on it.
    const env = (dir) => [
      ...prefix(" v2"),
      { type: "text", text: "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: " + dir },
    ]
    check("tail env seeded", turn(c, env("/a")).length === 0)
    check("tail env move stays quiet", turn(c, env("/b")).length === 0)
  }
  check("fires once per change", turn(c, prefix(" v2")).length === 0)
  check(
    "our own notice does not perturb the hash",
    turn(c, [...prefix(" v2"), { type: "text", text: "[zom-cache-watch] prompt prefix changed" }]).length === 0,
  )
  {
    // The tool list is part of the cached prefix: an MCP server's schema edit
    // re-pays everything before it even when its prose did not move. A
    // separate session keeps this from perturbing the prefix checks above.
    const toolsSid = "ses_tools"
    const withTool = (schema) => ({
      sessionID: toolsSid,
      system: prefix(" v2"),
      messages: [],
      agent: "mini",
      tools: { "demo.tool": { description: "same prose", parameters: schema } },
    })
    const fireTurn = (ev) => {
      c.fire("context", ev)
      return ev.messages.map((m) => m.content.map((p) => p.text).join("")).join("")
    }
    check("tool schema seeded", fireTurn(withTool({ a: 1 })).length === 0)
    check("unchanged tool schema stays quiet", fireTurn(withTool({ a: 1 })).length === 0)
    check(
      "a tool schema change fires",
      fireTurn(withTool({ a: 2 })).includes("prompt prefix changed"),
    )
  }
  {
    // Sessions accumulate forever if the map grows without a cap: one key per
    // session, and old sessions never come back.
    for (let i = 0; i < 140; i++) {
      c.fire("context", {
        sessionID: `ses_bulk_${i}`,
        system: prefix(" v2"),
        messages: [],
        agent: "mini",
      })
    }
    const kept = Object.keys(JSON.parse(shared.get("zom-cache-watch")).hashes)
    check("remembered sessions are capped", kept.length <= 128)
    check("the newest session survives the cap", kept.includes("ses_bulk_139"))
  }
  {
    const other = []
    c.fire("context", { sessionID: "ses_build", system: prefix(" other"), messages: other, agent: "orchestrator" })
    check("other agents' sessions get nothing", other.length === 0)
    check("other agents' sessions are not tracked", !JSON.parse(shared.get("zom-cache-watch")).hashes.ses_build)
  }
  check(
    "our own notice does not perturb the hash",
    turn(c, [...prefix(" v2"), { type: "text", text: "[zom-cache-watch] prompt prefix changed" }]).length === 0,
  )

  // a relaunch inherits the hashes: no bootstrap blind spot for a known session
  const reborn = boot()
  await cacheWatch.setup(reborn.c.ctx, reborn.h.host)
  const afterReboot = turn(reborn.c, prefix(" v3"))
  check("relaunched instance fires on the first changed request", afterReboot.length === 1)
  check("reboot without change stays quiet", turn(reborn.c, [{ type: "text", text: "core instructions v3" }]).length === 0)

  // one-shot migration from the earlier directory-keyed build
  const legacy = new Map([["zom-cache-watch", JSON.stringify({ lastDir: "/somewhere/else" })]])
  const m = makeHost(legacy)
  const mc = makeCtx()
  await cacheWatch.setup(mc.ctx, m.host)
  const migrated = turn(mc, [{ type: "text", text: "core instructions v4" }])
  check("legacy state migrates and fires once", migrated.length === 1)
  const after = JSON.parse(legacy.get("zom-cache-watch"))
  check("legacy lastDir dropped after migration", !("lastDir" in after) && after.hashes[sid]?.length > 0)
}

// --- state-watch -----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "zom-ext-state-"))
  const { ctx } = makeCtx()
  const { host, reports, listeners } = makeHost()
  host.dataDir = dir
  await stateWatch.setup(ctx, host)
  const bump = () => delta(listeners[0], "x", 1, 0)

  const big = ("x".repeat(99) + "\n").repeat(12 * 1024) // ~1.2MB, full lines
  writeFileSync(join(dir, "bg.jsonl"), big)
  for (let i = 0; i < 50; i++) bump()
  const trimmed = readFileSync(join(dir, "bg.jsonl"), "utf8")
  check("oversized bg.jsonl trimmed", statSync(join(dir, "bg.jsonl")).size <= 64 * 1024 + 128)
  check("trim keeps the tail", trimmed.endsWith(big.slice(-64)))
  check("trim reports", reports.some((m) => m.includes("bg.jsonl")))

  writeFileSync(join(dir, "bg.jsonl"), "small\n")
  for (let i = 0; i < 50; i++) bump()
  check("small bg.jsonl untouched", readFileSync(join(dir, "bg.jsonl"), "utf8") === "small\n")

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
