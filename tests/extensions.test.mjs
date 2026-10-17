// Unit tests for the extensions layer: policy modules (cache-watch,
// state-watch) on a mock host, plus companion's isolation guarantees
// (loadExtensions scans ZOM_CONFIG's dir; a broken extension dies alone).
// Run: node tests/extensions.test.mjs
// Also driven by tests/run.zsh (S10).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, utimesSync, statSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import cacheWatch from "../extensions/cache-watch.js"
import stateWatch from "../extensions/state-watch.js"
import { loadExtensions } from "../companion.js"

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
      hook(event, handler) {
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

// --- isolation via loadExtensions ------------------------------------------
{
  const cfgDir = mkdtempSync(join(tmpdir(), "zom-ext-iso-"))
  const dataDir = mkdtempSync(join(tmpdir(), "zom-ext-data-"))
  mkdirSync(join(cfgDir, "extensions"))
  writeFileSync(join(cfgDir, "config.toml"), '[shell]\nbinary = "x"\n')
  writeFileSync(join(cfgDir, "extensions", "bad.js"), `export default { setup() {{{ `)
  writeFileSync(
    join(cfgDir, "extensions", "dup.js"),
    `import { appendFileSync } from "node:fs"\n` +
      `export default { id: "good", async setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => { event.system.push({ type: "text", text: "good says hi" }) })\n` +
      `  appendFileSync(host.dataDir + "/good.marker", "x")\n` +
      `} }`,
  )
  writeFileSync(
    join(cfgDir, "extensions", "good.js"),
    `import { appendFileSync } from "node:fs"\n` +
      `export default { id: "good", async setup(ctx, host) {\n` +
      `  ctx.session.hook("context", (event) => { event.system.push({ type: "text", text: "good says hi" }) })\n` +
      `  appendFileSync(host.dataDir + "/good.marker", "x")\n` +
      `} }`,
  )
  writeFileSync(
    join(cfgDir, "extensions", "boomer.js"),
    `export default { id: "boomer", async setup(ctx) {\n` +
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

console.log(`extensions.test: ${pass} checks, ${fail} failed`)
if (fail > 0) process.exit(1)
