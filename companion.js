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
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { copyFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const DEFAULTS = {
  failureTtlSeconds: 600,
  recentDefaultN: 20,
  recipeTtlSeconds: 900,
  // Identical failures of one command within a day that trigger a single
  // outbox hint. 0 disables.
  repeatFailureThreshold: 3,
  autoTitle: "idle",
  autoTitleIdleMinutes: 54,
  devPath: "",
}

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
  // The zsh side reads ZOM_CONFIG (see the plugin); honor it here too so both
  // halves always split config at the same seam. Default is the XDG location.
  return process.env.ZOM_CONFIG || join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "zsh-opencode-mini",
    "config.toml",
  )
}

// The agent is created at load time, not shipped as a markdown file under the
// host's config dir. Agent discovery is directory-based, but a plugin may seed
// the registry: update() on an unknown id starts from Agent.Info.default
// (packages/core/src/agent.ts:63), and Agent.Info carries `system`.
const DEFAULT_AGENT = "mini"

// The conversation tail is the only place a hint can go without paying for the
// cached prefix again. Module scope because both the host hook and the
// extension host write through it.
const inject = (event, text) => {
  ;(event.messages ??= []).push({ role: "system", content: [{ type: "text", text }] })
}
// What a hook gets is a copy: the system prefix and the message history are
// frozen (reading them is fine, writing them is a TypeError), and host.inject
// resolves the copy back to the event that is actually being assembled.
const frozenParts = (parts) =>
  Object.freeze(
    (parts ?? []).map((p) => (p && typeof p === "object" ? Object.freeze({ ...p }) : p)),
  )
// The tool list is part of the same cached prefix (cache-watch hashes it), so
// it is frozen the same way: a handler that edits a description re-pays every
// token before it, and nothing would say so.
const frozenTools = (tools) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(tools ?? {}).map(([name, value]) => [
        name,
        value && typeof value === "object" ? Object.freeze({ ...value }) : value,
      ]),
    ),
  )
const readOnlyView = (event) =>
  Object.freeze({
    ...event,
    system: frozenParts(event.system),
    messages: Object.freeze(
      (event.messages ?? []).map((m) =>
        Object.freeze({ ...m, content: frozenParts(m.content) }),
      ),
    ),
    tools: frozenTools(event.tools),
  })
// The agent definition lives here, not in extensions/: registering an agent is a
// host capability. The prompt below is only a seed for the user's copy in
// <config dir>/agent.md — that file is what runs, re-read on every reload. The
// id is not a constant either: it is shell.agent, resolved at setup so the zsh
// side's --agent flag and this registration cannot drift apart.
const AGENT_DESCRIPTION =
  "Terminal companion: short answers, reads the scene with tools, queries history on demand"

// The prompt is a file the user owns: <config dir>/agent.md, seeded from
// agent.example.md by the installer. There is deliberately no copy here: two
// texts meant to say the same thing drift, and the silent one wins.
function agentSystemPrompt() {
  const path = join(dirname(configPath()), "agent.md")
  try {
    const text = readFileSync(path, "utf8").trim()
    if (text) return `${text}\n`
    extensionReport("companion", `agent prompt is empty: ${path}`)
  } catch (e) {
    extensionReport(
      "companion",
      `agent prompt unreadable (${path}): ${e?.message ?? e} — ` +
        `the mini agent runs without its terminal brief; restore it from agent.example.md`,
    )
  }
  return ""
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
      `[zom] no python3 with tomllib (3.11+) found for ${p}. ` +
        `Set ZOM_PYTHON=/path/to/python3 or install one.`,
    )
  }
  const run = spawnSync(interpreter, ["-c", TOML_JSON, p], { encoding: "utf8" })
  if (run.error) throw new Error(`[zom] failed to run ${interpreter} for ${p}: ${run.error.message}`)
  if (run.status !== 0) {
    throw new Error(
      `[zom] failed to parse ${p}: ${(run.stderr || "").trim()}. ` +
        `Fix the file or remove it to run on defaults.`,
    )
  }
  return JSON.parse(run.stdout)
}

function expandHome(path) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path
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
      `[zom] recipe model must be "provider/model-id", got: ${JSON.stringify(spec)}`,
    )
  }
  return { providerID: spec.slice(0, idx), id: spec.slice(idx + 1) }
}

// One slot syntax for both compile-time validation and runtime rendering: the
// two halves used to spell the regex separately, so a change to one silently
// left the other behind.
const SLOT_RE = /\{(\w+)\}/g

export function renderTemplate(template, slots) {
  return String(template ?? "").replace(SLOT_RE, (_m, key) =>
    key in slots ? String(slots[key] ?? "") : `{${key}}`,
  )
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
      `[zom] plugin API mismatch: built for V${CONTRACT.major}, ` +
        `running on OpenCode ${version || "<version unreadable>"}. ` +
        `Refusing to load half-working. Re-verify against ${CONTRACT.docs} ` +
        `(last verified ${CONTRACT.verified}).`,
    )
  }
  for (const [name, probe] of [...CONTRACT.surfaces, ...extraSurfaces]) {
    if (!probe(ctx)) {
      throw new Error(
        `[zom] missing plugin API surface: ${name} (OpenCode ${version}). ` +
          `The V2 plugin API shape has changed — re-verify against ${CONTRACT.docs}.`,
      )
    }
  }
}

// --- failure signal --------------------------------------------------------

// Parsed, not judged: the age comes along as a number so callers can decide
// what counts as fresh (the TTL that used to live here had exactly one caller,
// which always passed Infinity — a policy that silently did nothing).
function readFailureSignal(dataDir) {
  const p = join(dataDir, "last-failure.json")
  if (!existsSync(p)) return undefined
  try {
    const sig = JSON.parse(readFileSync(p, "utf8"))
    const age = Math.floor(Date.now() / 1000) - Number(sig.epoch)
    return { ...sig, ageSeconds: Number.isFinite(age) ? age : undefined }
  } catch {
    return undefined // unreadable signal file is not worth crashing a model call over
  }
}


// The summon identity: which shell (tty, cwd) spawned a session. The zsh side
// stamps every spawn into spawns.jsonl; the host parses the file and hands the
// records over in file order. Which record describes the session now asking is
// not decidable here — with two minis in two panes sharing one server and one
// data dir, "the newest summon" is a guess, so the guess belongs to the
// consumer that knows what it is looking for.
function readSpawns(dataDir) {
  const p = join(dataDir, "spawns.jsonl")
  if (!existsSync(p)) return []
  const out = []
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.kind === "mini" || r.kind === "last") {
          out.push({ tty: String(r.tty ?? ""), cwd: String(r.cwd ?? ""), ts: Number(r.ts ?? 0) })
        }
      } catch {} // torn line, same tolerance as every other jsonl read here
    }
  } catch {
    return []
  }
  return out
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
  const out = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {} // a torn line is not worth failing the injection over
  }
  const tmp = `${p}.tmp`
  writeFileSync(tmp, "")
  renameSync(tmp, p)
  return out
}

// Repeated-failure awareness. Every non-zero exit already wakes the failure
// watcher, so counting costs one read of a bounded store. Exact-string match
// on the command — a changed argument is a different command; that is the
// documented granularity limit of this heuristic.
// --- bounded files ---------------------------------------------------------
// How to cut a jsonl file down to its newest lines, in one place: the outbox
// rotation and the extension that prunes bg.jsonl both need it, and two
// implementations drift on the only question that matters — what happens to a
// torn last line (dropped: it is a crashed append, not a record).
export function trimTailFile(path, { capBytes, keepBytes }) {
  if (!existsSync(path)) return false
  const buf = readFileSync(path)
  if (buf.length <= capBytes) return false
  let end = buf.length
  if (buf[end - 1] !== 0x0a) end = buf.lastIndexOf(0x0a) + 1
  let start = Math.max(0, end - keepBytes)
  if (start > 0) {
    const nl = buf.indexOf(0x0a, start)
    start = nl === -1 ? end : nl + 1
  }
  // tmp+mv replace (the last-failure.json protocol): a drain holding an open
  // fd finishes reading the old inode instead of a truncated file.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, buf.subarray(start, end))
  renameSync(tmp, path)
  return true
}

// --- plugin ----------------------------------------------------------------

export default {
  id: "zom-companion",
  async setup(ctx) {
    // One parse per load (the config feeds contract probes, companion config,
    // dataDir and recipes alike).
    const fullCfg = loadConfig()
    const configuredAgent = fullCfg?.shell?.agent
    const agentID =
      typeof configuredAgent === "string" && configuredAgent.trim() !== ""
        ? configuredAgent.trim()
        : DEFAULT_AGENT
    const cfg = { ...DEFAULTS, ...fullCfg?.companion }
    const dataDir = shellDataDir(fullCfg)
    // Raw: the shape of a recipe is the recipes extension's business.
    const recipes = fullCfg?.recipes ?? {}
    const hasRecipes = Object.keys(recipes).length > 0
    // Seeded here, not at module load: the baseline lives next to the rest of
    // the shell data, wherever the config says that is.
    // A reload calls setup again in the same process. Every collection above
    // is module scope (the extension loader reads some of them without a setup
    // scope), so drop what the previous generation left behind instead of
    // stacking a second copy of every listener on top of it.
    resetGenerationState()
    seedUsageTotals(dataDir)
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
      ["ctx.agent.transform", (c) => typeof c?.agent?.transform === "function"],
    ]
    if (hasRecipes) {
      // Recipes call the model. Storage used to be probed here too, back when
      // rate counters lived in ctx.storage; they moved to the host's own kv,
      // so requiring a surface nobody reads is a dead contract check.
      extraSurfaces.push(["ctx.generate.text", (c) => typeof c?.generate?.text === "function"])
    }
    assertContract(ctx, extraSurfaces)

    // The host config dir holds this one file and nothing else: the agent and
    // its prompt are seeded here, re-seeded on every domain reload so an edit
    // to <config dir>/agent.md lands without a restart. The runtime may hand
    // back a promise; ignoring it means setup resolves before the agent
    // exists, and the first request sees no agent at all.
    await ctx.agent.transform((agent) => {
      agent.update(agentID, (item) => {
        item.system = agentSystemPrompt()
        item.description = AGENT_DESCRIPTION
        item.mode = "primary"
        item.hidden = true
      })
    })

    // The watcher and the outbox writer both need the directory to exist; the
    // zsh side creates it too, so this is idempotent.
    mkdirSync(dataDir, { recursive: true })

    const outboxPath = join(dataDir, "outbox.jsonl")
    // Outbox growth is bounded by the state-watch scanner, not on the append
    // path: appending is the hot operation (one per finished recipe), and a
    // read-the-whole-file + rename there both costs the request and races
    // another process appending to the inode being replaced.
    const appendOutbox = (record) => {
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
    // Capabilities extensions ask for: a failure was seen, the outbox is
    // appendable and readable, the shell's records are parseable. What any of
    // them means is not decided here.
    const files = {
      lastFailure: () => readFailureSignal(dataDir),
      // Spawn records in file order: the consumer picks which one is its own.
      spawns: () => readSpawns(dataDir),
      drainNotices: () => drainNotices(dataDir),
      // Parsed history records: which of them count as "the same failure
      // today" is the caller's aggregation, not the file format's.
      failureRecords: () => {
        const p = monthFile()
        if (!existsSync(p)) return []
        const out = []
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {} // torn line, same tolerance as every other jsonl read
        }
        return out
      },
      // Bounded files: the extension decides which file and how big, the host
      // owns the cutting so two callers cannot disagree about a torn tail.
      trimTail: (path, opts) => trimTailFile(path, opts),
      // The data dir's entries as facts (name, size, mtime, kind). Which of
      // them to trim or delete is the caller's policy; the host is the only
      // one who should be touching this directory at all.
      entries: () => {
        try {
          return readdirSync(dataDir).flatMap((name) => {
            try {
              const st = statSync(join(dataDir, name))
              return [{ name, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }]
            } catch {
              return []
            }
          })
        } catch {
          return []
        }
      },
      // Deleting is a capability some extensions need (a cleaner), but the data
      // dir also holds the host's own records. Whitelist the shapes cleaners
      // touch instead of handing out "delete any file by name".
      remove: (name) => {
        if (!/^(passthrough\.\d+\.keys\.log|claim-.+)$/.test(name)) {
          extensionReport("companion", `refused to remove ${name}: not a cleaner-owned file`)
          return false
        }
        try {
          unlinkSync(join(dataDir, name))
          return true
        } catch {
          return false // already gone: not an error for a cleaner
        }
      },
      // Cross-process "who handles this once": two servers watching the same
      // failure file would each fire a model call. Exclusive create is the
      // claim; the caller decides what the key means.
      claim: (key) => {
        const safe = String(key).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)
        try {
          closeSync(openSync(join(dataDir, `claim-${safe}`), "wx"))
          return true
        } catch (e) {
          if (e?.code === "EEXIST") return false
          extensionReport("companion", `claim ${safe} could not be written: ${e?.message ?? e}`)
          return false
        }
      },
      // The tail as records: which of them surface first is the tool's call.
      // The limit is required — defaulting it here would put a policy number
      // (how much history is "recent") back into the host.
      historyTail: (n) => {
        if (!(Number.isFinite(n) && n > 0)) {
          throw new Error(`[zom] historyTail needs a positive limit, got ${n}`)
        }
        const p = monthFile()
        if (!existsSync(p)) return []
        const limit = Math.floor(n)
        return readFileSync(p, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .slice(-limit)
          .map((raw) => {
            let cwd = ""
            try {
              cwd = String(JSON.parse(raw).cwd ?? "")
            } catch {} // torn line: still shown, just never ranked
            return { raw, cwd }
          })
      },
    }
    const failureListeners = []
    const execListeners = []
    const onFailure = (cb) => failureListeners.push(cb)
    const outbox = {
      append: (record) => appendOutbox(record),
      records: () => {
        if (!existsSync(outboxPath)) return []
        const out = []
        for (const line of readFileSync(outboxPath, "utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {} // torn line, same tolerance as every other jsonl read
        }
        return out
      },
    }

    // Cross-process handshake with the zsh side's __zom_outbox_drain: a
    // bg-done injected here must not ALSO print as `zom: ...` at the shell
    // prompt, so injection records {sid: epoch} in this file and the drain
    // skips records whose sid was injected within the failure TTL (the same
    // key both sides read for freshness). Written only when an injection
    // actually happened; a drain that ran earlier still prints — the accepted
    // duplication is documented on the zsh side.
    const bgInjectedPath = join(dataDir, "bg-injected.json")
    const BG_INJECTED_CAP = 200
    const markBgInjected = (sid) => {
      let cur = {}
      try { cur = JSON.parse(readFileSync(bgInjectedPath, "utf8")) } catch {}
      // Delete before insert so a re-marked sid moves to the back: a plain
      // assignment keeps the original position and the cap would evict the
      // newest entries first.
      delete cur[sid]
      cur[sid] = Math.floor(Date.now() / 1000)
      const keys = Object.keys(cur)
      for (const k of keys.slice(0, Math.max(0, keys.length - BG_INJECTED_CAP))) delete cur[k]
      const tmp = `${bgInjectedPath}.tmp`
      writeFileSync(tmp, JSON.stringify(cur))
      renameSync(tmp, bgInjectedPath)
    }
    // Both are file protocols the zsh side also reads; the decision to use
    // them (which sessions count as background, when to notify) is not here.
    files.bgLedger = () => bgLedger()
    files.markBgInjected = (sid) => markBgInjected(sid)

    // Failure watcher. last-failure.json is atomically replaced (tmp+mv), so
    // watch the directory and filter by filename — watching the file itself
    // would follow the old inode and go quiet after the first replace.
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename !== "last-failure.json") return
      const sig = readFailureSignal(dataDir)
      if (!sig) return
      // What a repeated failure means is an extension's judgement; the host
      // only says "a failure was recorded".
      for (const cb of failureListeners) {
        try {
          cb(sig)
        } catch (e) {
          extensionReport("companion", `failure listener failed: ${e?.message ?? e}`)
        }
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
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: bgAbort.signal })) {
          // ev.data is the verified v2 envelope; ev.properties kept as
          // older-wire tolerance, bare ev as last resort.
          const p = ev?.data ?? ev?.properties ?? ev
          if (ev?.type === "session.usage.updated") {
            dispatchUsage(p)
            continue
          }
          const failed = ev?.type === "session.execution.failed"
          if (ev?.type !== "session.execution.succeeded" && !failed) continue
          const sid = p?.sessionID
          if (!sid) continue // failed-path data shape unverified; stay silent
          // Delivered raw: which sessions matter, when to notify and what to
          // say are decisions the bg-done extension and recipes make.
          for (const cb of execListeners) {
            try {
              cb({ sid, ok: !failed })
            } catch (e) {
              extensionReport("companion", `execution listener failed: ${e?.message ?? e}`)
            }
          }
        }
      } catch (e) {
        if (!bgAbort.signal.aborted) {
          extensionReport("companion", `event stream ended unexpectedly: ${e?.message ?? e}`)
        }
      }
    })()

    // Await registration: hooks added after setup resolves are invisible to
    // requests already being assembled, and the symptom is a plugin that
    // silently stops seeing context while `loading plugin` still logs fine.
    await loadExtensions(ctx, dataDir, agentID, cfg, {
      files,
      outbox,
      recipes,
      onFailure,
      onSessionExecution: (cb) => execListeners.push(cb),
    })

    return () => {
      watcher.close()
      bgAbort.abort()
    }
  },
}

// --- extensions -------------------------------------------------------------
// Feature modules that are ours but do not belong in the user's main
// ~/.config/opencode/ path load from <config dir>/extensions/. Each exports
// default { id, setup(ctx, host) } and receives the same plugin ctx plus a
// host carrying the mechanism they all share, so an extension file holds
// only policy:
//   host.report(msg)        queue a problem for user-visible injection —
//                           plugin stderr never reaches opencode.log, so a
//                           console.error is a message in a bottle
//   host.onUsageDelta(cb)   per session.usage.updated, once the companion's
//                           event loop has turned the cumulative totals into
//                           a {sid, dInput, dRead} delta
//   host.storage(name)      JSON kv in the shell data dir, tmp+mv atomic,
//                           survives restarts (deltas need a baseline; the
//                           19:56 drop landed in the boot blind spot without)
//   host.dataDir            the shell data dir the storage lives in
// Hook registration aggregates across callers, so an extension can still
// register its own session.hook("context").
// Reports awaiting delivery. The host keeps the queue and a hard cap; what is
// worth saying, how often, and in what words is extensions/extension-health.js.
const extensionProblems = [] // { name, msg, ts } awaiting delivery
const EXTENSION_PROBLEM_CAP = 200
const usageDeltaListeners = []
// sid -> {input, read, ts} cumulative at last event. Persisted to disk because
// mini embeds the server: every hide-and-relaunch is a fresh boot, and the
// first turn after a relaunch is exactly the one that pays full price for a
// directory switch — without a seeded baseline that bust is undetectable.
const usageTotals = new Map()
// Resolved once the effective data dir is known (setup): shellDataDir() at module
// scope would ignore a shell.dataDir override and split the baseline in two.
let usageBaselineFile
const USAGE_BASELINE_CAP = 64

function persistUsageTotals() {
  if (!usageBaselineFile) return
  try {
    while (usageTotals.size > USAGE_BASELINE_CAP) {
      usageTotals.delete(usageTotals.keys().next().value)
    }
    const out = {}
    for (const [sid, t] of usageTotals) {
      out[sid] = { input: t.input, read: t.read, ts: t.ts }
    }
    const tmp = `${usageBaselineFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(out))
    renameSync(tmp, usageBaselineFile)
  } catch (e) {
    extensionReport("companion", `usage baseline persist failed: ${e?.message ?? e}`)
  }
}

// Insertion order doubles as recency: re-sampling a sid must move it to the
// back, otherwise the cap evicts the sessions that were just seen.
function trackUsage(sid, entry) {
  usageTotals.delete(sid)
  usageTotals.set(sid, entry)
  while (usageTotals.size > USAGE_BASELINE_CAP) {
    usageTotals.delete(usageTotals.keys().next().value)
  }
}

export function seedUsageTotals(dataDir) {
  usageBaselineFile = join(dataDir, "usage-baseline.json")
  try {
    const seeded = JSON.parse(readFileSync(usageBaselineFile, "utf8"))
    // Age is carried, not judged: whether a baseline from thirty minutes ago is
    // still comparable is the consumer's call, and the host has no business
    // holding a TTL that only one extension's use of the number depends on.
    for (const [sid, t] of Object.entries(seeded ?? {})) {
      if (typeof t?.input === "number") {
        trackUsage(sid, { input: t.input, read: t.read ?? 0, ts: t.ts ?? 0 })
      }
    }
  } catch {
    // no baseline on disk yet: first boot ever, nothing to seed
  }
}

export function extensionReport(name, msg) {
  if (extensionProblems.length >= EXTENSION_PROBLEM_CAP) extensionProblems.shift()
  extensionProblems.push({ name, msg: String(msg), ts: Math.floor(Date.now() / 1000) })
}

// Everything a load generation owns in module scope. Called at the top of
// setup: without it a hot reload keeps the previous generation's listeners
// alive, and each event fires the old generation's handlers too.
export function resetGenerationState() {
  extensionProblems.length = 0
  usageDeltaListeners.length = 0
  usageTotals.clear()
}

export function extensionStorage(dataDir, name) {
  const file = join(dataDir, `${name}.json`)
  return {
    get() {
      try {
        return JSON.parse(readFileSync(file, "utf8"))
      } catch {
        return {}
      }
    },
    set(obj) {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(obj))
      renameSync(tmp, file)
    },
  }
}

function dispatchUsage(p) {
  const sid = p?.sessionID ?? p?.info?.sessionID
  const tokens = p?.tokens
  if (!sid || !tokens || typeof tokens.input !== "number") return
  const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0
  const last = usageTotals.get(sid)
  trackUsage(sid, { input: tokens.input, read, ts: Date.now() })
  persistUsageTotals()
  if (!last) return // nothing to compare against: record and wait for the next delta
  // The delta carries the previous sample's timestamp; how long a gap makes the
  // comparison meaningless is a consumer's policy, not the host's.
  const delta = { sid, dInput: tokens.input - last.input, dRead: read - last.read, lastTs: last.ts }
  for (const cb of usageDeltaListeners) {
    try {
      cb(delta)
    } catch (e) {
      extensionReport("companion", `usage listener failed: ${e?.message ?? e}`)
    }
  }
}

export async function loadExtensions(ctx, dataDir, agentID = DEFAULT_AGENT, cfg = {}, services = {}) {
  // Extensions live next to config.toml, wherever ZOM_CONFIG points the
  // config — same rule the zsh installer mirrors on the way in.
  // devPath points the loader at a working tree, so an edited extension takes
  // effect on the next reload without running the installer. Unset (the
  // default) reads the installed mirror.
  const devRoot = typeof cfg?.devPath === "string" ? cfg.devPath.trim() : ""
  const dir = devRoot
    ? join(expandHome(devRoot), "extensions")
    : join(dirname(configPath()), "extensions")
  const loaded = []
  // When nothing loads, the extension that normally carries these problems
  // (extension-health) is itself missing — including the case where the
  // directory could not be read at all. The host then reports on its own, or
  // the failure is invisible exactly when it matters most.
  const speakWhenNothingLoaded = async () => {
    if (loaded.length > 0) return
    return ctx.session.hook("context", (event) => {
      if (event.agent !== agentID) return
      const pendingProblems = extensionProblems.splice(0, extensionProblems.length)
      if (pendingProblems.length === 0) return
      inject(
        event,
        `[zom] no extensions loaded; the host reports this itself:\n` +
          pendingProblems.map((p) => `- ${p.name}: ${p.msg}`).join("\n"),
      )
    })
  }
  let entries = []
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".js")).sort()
  } catch (e) {
    // Extensions carry most of what this plugin does (zom_context, failure
    // hints, notices), and setup creates the data dir before getting here, so
    // a missing extensions directory is a degraded install, not a valid
    // "extensions off" configuration. Say it instead of running quietly.
    extensionReport(
      "companion",
      `extensions directory ${dir} could not be read (${e?.code ?? e?.message ?? e}) — ` +
        (devRoot
          ? `check [companion] devPath = "${devRoot}"; no extensions were loaded`
          : `no extensions were loaded; the plugin is degraded`),
    )
    await speakWhenNothingLoaded()
    return
  }
  // Stage inside the plugin's own data dir: $TMPDIR is swept by the OS and by
  // anything else that decides to clean it, and a swept file turns into
  // "Cannot find module" at import time. This directory is ours to prune.
  const stageDir = join(dataDir, "ext-staged")
  try {
    mkdirSync(stageDir, { recursive: true })
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const f of readdirSync(stageDir)) {
      try {
        if (statSync(join(stageDir, f)).mtimeMs < cutoff) unlinkSync(join(stageDir, f))
      } catch {
        // already gone
      }
    }
  } catch (e) {
    extensionReport(
      "companion",
      `staging directory ${stageDir} is unusable (${e?.code ?? e?.message ?? e}) — no extensions were loaded`,
    )
    await speakWhenNothingLoaded()
    return
  }
  // Rolling upgrade with rollback: a version that fails to import does not get
  // to keep failing. Its hash is remembered, the last version that did load
  // takes its place, and the failed bytes stay on disk as <name>.broken for
  // whoever fixes the source.
  const goodDir = join(dataDir, "ext-good")
  // A rewritten file at the same path keeps resolving to the module the runtime
  // already evaluated — the cache key is the path, and a query string is not
  // enough under every runtime. Import a private copy so the running code is
  // always the bytes on disk.
  const importFile = async (file) => {
    try {
      return { mod: await import(pathToFileURL(file).href) }
    } catch (e) {
      return { error: e?.message ?? String(e) }
    }
  }
  const tryStage = async (file, name, tag) => {
    try {
      const staged = join(stageDir, `ext-${process.pid}-${tag}-${name}`)
      copyFileSync(file, staged)
      return await importFile(staged)
    } catch (e) {
      return { error: e?.message ?? String(e) }
    }
  }
  const readState = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch {
      return {}
    }
  }
  try {
    mkdirSync(goodDir, { recursive: true })
  } catch (e) {
    extensionReport(
      "companion",
      `rollback store ${goodDir} is unusable (${e?.code ?? e?.message ?? e}) — no extensions were loaded`,
    )
    await speakWhenNothingLoaded()
    return
  }

  for (const name of entries) {
    const file = join(dir, name)
    let id = name.replace(/\.js$/, "")
    let bytes
    try {
      bytes = readFileSync(file)
    } catch (e) {
      extensionReport(id, `unreadable: ${e?.message ?? e} (${file})`)
      continue
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
    const statePath = join(goodDir, `${name}.json`)
    const state = readState(statePath)
    // Content-addressed: the hash in the filename means an import never
    // resolves to bytes that changed under it, and the next upgrade cannot
    // overwrite the rollback target.
    // The hash goes before the extension: Node resolves imports by extension,
    // so roll.js.<hash> would not be importable as a module.
    const goodName = (h) => `${name.replace(/\.js$/, "")}.${h}.js`
    const goodPath = state.hash ? join(goodDir, goodName(state.hash)) : join(goodDir, name)
    const goodExists = Boolean(state.hash) && existsSync(goodPath)

    // This exact content already failed once: run the good copy instead of
    // failing again on every reload. The first report reached the user in the
    // process that saw the failure; later processes would otherwise run a
    // degraded set in silence, which looks like "the plugin is fine, the
    // feature vanished".
    if (state.broken?.hash === hash) {
      if (!goodExists) {
        extensionReport(
          id,
          `${name} is still broken (${state.broken.error ?? "load failed"}) and there is no ` +
            `last version to fall back to; fix the source in ${file}.`,
        )
        continue
      }
      const retry = await importFile(goodPath)
      if (retry.mod) loaded.push({ name, id: retry.mod?.default?.id || id, mod: retry.mod })
      else extensionReport(id, `last-good copy is unreadable (${goodPath}): ${retry.error}`)
      extensionReport(
        id,
        `${name} is quarantined (${state.broken.error ?? "load failed"}); running the last ` +
          `version that loaded. The broken copy is ${join(goodDir, `${name}.broken`)}.`,
      )
      continue
    }

    const attempt = await tryStage(file, name, hash)
    if (!attempt.error) {
      const mod = attempt.mod
      // The declared id, not the filename, is the extension's identity.
      if (typeof mod?.default?.id === "string" && mod.default.id) id = mod.default.id
      // Copying the bytes aside as last-good and pruning the previous copy
      // both wait for setup() to resolve: a module can import cleanly and
      // still throw while registering, and that failure must not destroy the
      // version that works — that copy is exactly what we roll back to.
      loaded.push({
        name,
        id,
        mod,
        commit: { name, hash, file, statePath, base: name.replace(/\.js$/, "") },
      })
      continue
    }

    // The new version is broken. Keep its bytes, remember the hash, and fall
    // back so whatever it replaced keeps working until the source is fixed.
    const brokenPath = join(goodDir, `${name}.broken`)
    try {
      copyFileSync(file, brokenPath)
    } catch {}
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          hash: state.hash ?? "",
          broken: { hash, error: attempt.error, at: Date.now() },
        }),
      )
    } catch {}
    let restored = false
    if (goodExists) {
      const retry = await importFile(goodPath)
      if (retry.mod) {
        restored = true
        const mod = retry.mod
        if (typeof mod?.default?.id === "string" && mod.default.id) id = mod.default.id
        loaded.push({ name, id, mod })
      }
    }
    extensionReport(
      id,
      `failed to load: ${attempt.error} (${file})` +
        (restored
          ? ` — rolled back to the last version that loaded; the broken copy is ${brokenPath}. Fix the source, then reload.`
          : ` — nothing earlier to roll back to; the broken copy is ${brokenPath}.`),
    )
  }

  // One id, one file. Two files claiming one id is an ambiguity we refuse to
  // resolve by filename order: silently running the older one is how a fix
  // sits on disk for hours while the bug keeps running.
  const byId = new Map()
  for (const item of loaded) byId.set(item.id, [...(byId.get(item.id) ?? []), item])
  for (const [id, items] of byId) {
    if (items.length > 1)
      extensionReport(id, `duplicate extension id — not loading any of: ${items.map((i) => i.name).join(", ")}`)
  }

  // Last-good bookkeeping, run only once an extension has actually come up:
  // the copy is content-addressed, and the previous one is dropped only after
  // its replacement is proven loadable + registerable.
  const commitGood = ({ name, hash, file, statePath, base }) => {
    try {
      const next = join(goodDir, `${base}.${hash}.js`)
      const tmp = `${next}.${process.pid}.tmp`
      copyFileSync(file, tmp)
      renameSync(tmp, next)
      writeFileSync(statePath, JSON.stringify({ hash }))
      // One good copy per extension: a directory that grows with every edit is
      // not a feature, and the older bytes are no longer reachable once the new
      // version is known to work.
      for (const f of readdirSync(goodDir)) {
        if (f === `${base}.${hash}.js` || f === `${name}.json` || f.endsWith(".broken")) continue
        if (f.startsWith(`${base}.`) && f.endsWith(".js")) {
          try {
            unlinkSync(join(goodDir, f))
          } catch {}
        }
      }
    } catch (e) {
      extensionReport(base, `could not record last-good copy: ${e?.message ?? e}`)
    }
  }

  const recordBroken = ({ name, hash, file, statePath }, error) => {
    const brokenPath = join(goodDir, `${name}.broken`)
    try {
      copyFileSync(file, brokenPath)
    } catch {}
    const prevHash = readState(statePath).hash ?? ""
    try {
      writeFileSync(statePath, JSON.stringify({ hash: prevHash, broken: { hash, error, at: Date.now() } }))
    } catch {}
    return brokenPath
  }

  // Registrations go into a buffer that is flushed only after setup()
  // resolves. A module that throws halfway through would otherwise leave a
  // hook or a tool behind that has no owner and fires on every request.
  const begin = (id, mod) => {
    const pending = []
    // Views handed to hooks resolve back to the real event here, so an
    // extension can only add a tail message through host.inject — never by
    // pushing into the array it was given.
    const views = new WeakMap()
    const host = {
    report: (msg) => extensionReport(id, msg),
    // Attribution at registration: a throwing callback dies alone and the
    // failure names the extension, not the host's event loop.
    onUsageDelta: (cb) =>
      pending.push(() =>
        usageDeltaListeners.push((delta) => {
          try {
            cb(delta)
          } catch (e) {
            extensionReport(id, `usage handler failed: ${e?.message ?? e}`)
          }
        }),
      ),
    // Injections go to the tail of the conversation, never the system
    // prompt: the system text is the cached prefix, and a hint that changes
    // between requests would re-pay for every token after it.
    inject: (event, text) => inject(views.get(event) ?? event, text),
    storage: (key) => extensionStorage(dataDir, key),
    dataDir,
    // Parsed records, not decisions: the extension judges freshness and
    // terminal ownership, the host owns the file formats.
    files: {
      ...(services.files ?? {}),
      // The loader's own failure queue, drained destructively: reporting a
      // problem is the host's (it is the only one who can see a load fail);
      // deciding when the user hears about it is not.
      drainProblems: () => extensionProblems.splice(0, extensionProblems.length),
    },
    // Same split for the outbox: append/read are ours, what to append is not.
    outbox: services.outbox ?? { append: () => {}, records: () => [] },
    onSessionExecution: (cb) =>
      pending.push(() =>
        (services.onSessionExecution ?? (() => {}))((ev) => {
          try {
            cb(ev)
          } catch (e) {
            extensionReport(id, `execution listener failed: ${e?.message ?? e}`)
          }
        }),
      ),
    // Errors attribute to the extension that registered the listener.
    onFailure: (cb) =>
      pending.push(() =>
        (services.onFailure ?? (() => {}))((sig) => {
          try {
            cb(sig)
          } catch (e) {
            extensionReport(id, `failure listener failed: ${e?.message ?? e}`)
          }
        }),
      ),
    // A model call and a tool registration, without the decision of when to
    // make either.
    model: {
      // The config validator enforces this shape; forwarding it keeps an
      // extension from re-deriving it differently.
      parse: (spec) => parseModel(spec),
      generate: async (model, prompt) => {
        const out = await ctx.generate.text({ model, prompt })
        // The docs pin the call shape but not the return shape (checked
        // 2026-10-02): accept a bare string or a {text} envelope.
        return typeof out === "string" ? out : String(out?.text ?? "")
      },
    },
    tool: {
      add: (tool) =>
        pending.push(() => ctx.tool.transform((editor) => editor.add(tool))),
    },
    // Slot substitution: the same syntax the recipes extension validates
    // against, so compile and fire cannot drift apart. Extensions cannot
    // import it — they run from a staged copy and relative imports break.
    render: (template, slots) => renderTemplate(template, slots),
    // The one session mutation the app needs: an empty title asks the server
    // to regenerate from history, the same semantics as the HTTP endpoint.
    // Everything else on ctx.session stays out of reach — an extension that
    // could rename or switch agents freely would be a second policy owner.
    session: {
      retitle: (sessionID, title) => ctx.session.update({ sessionID, title }),
    },
    // Durable counters: rate gates need to survive a restart. Backed by the
    // same atomic JSON store as host.storage. update() is the read-modify-write
    // gate: two callers in sequence cannot both see "one slot left", and a
    // failed write throws instead of persisting nothing and looking enforced.
    kv: (() => {
      const store = extensionStorage(dataDir, `${id}.kv`)
      return {
        get: (key) => (store.get() ?? {})[key],
        set: (key, value) => store.set({ ...(store.get() ?? {}), [key]: value }),
        update: (key, fn) => {
          const all = store.get() ?? {}
          const next = fn(all[key])
          if (next !== undefined) store.set({ ...all, [key]: next })
          return next
        },
      }
    })(),
    // The validated recipe table (the host owns config parsing and the
    // boundary check; what a recipe does is not config parsing).
    config: { ...cfg, recipes: services.recipes ?? {} },
    // The agent id this load registered under; extensions gate on it rather
    // than hard-coding a name that the config may have changed.
    agent: agentID,
    }
    // A hook the extension registers must not be able to break context
    // assembly for everyone else: wrap handlers one by one, attribute
    // failures to the extension, keep the rest of the chain running.
    // Extensions only ever see their own agent's requests; the gate belongs to
    // the host, not to every extension's memory. A plain object, not a Proxy
    // over ctx: a Proxy still answers Object.getOwnPropertyDescriptor for
    // whatever it hides, which left the real session surface reachable.
    const safeCtx = {
      session: {
        hook: (event, handler) =>
          pending.push(() =>
            ctx.session.hook(event, (...args) => {
              const real = args[0]
              if (event === "context" && real?.agent !== agentID) return
              // Every event is handed over as a read-only view, not only the
              // context one: any other event that carried `messages` would be
              // a second write path around host.inject.
              const view = real && typeof real === "object" ? readOnlyView(real) : real
              if (view && typeof view === "object") views.set(view, real)
              let out
              try {
                out = handler(view, ...args.slice(1))
              } catch (e) {
                extensionReport(id, `${event} hook failed: ${e?.message ?? e}`)
                return
              }
              // A handler that awaits something can fail after it returned;
              // nobody downstream would attribute that to this extension.
              if (out && typeof out.then === "function") {
                return out.catch((e) =>
                  extensionReport(id, `${event} hook failed: ${e?.message ?? e}`),
                )
              }
              return out
            }),
          ),
      },
    }
    const setup = async () => {
    if (typeof mod?.default?.setup === "function") await mod.default.setup(safeCtx, host)
    return pending
    }
    return { setup }
  }

  const flush = async (pending) => {
    for (const install of pending) await install()
  }

  for (const [id, items] of byId) {
    if (items.length !== 1) continue
    const first = items[0]
    try {
      // Registration is part of loading: a surface that rejects (tool name
      // already taken, hook refused) must take the same rollback path as a
      // throwing setup, not unwind the whole plugin.
      await flush(await begin(id, first.mod).setup())
      if (first.commit) commitGood(first.commit)
    } catch (e) {
      const err = e?.message ?? String(e)
      if (!first.commit) {
        // A last-good copy that came from the quarantine path has no source
        // bytes of its own; there is nothing to record or fall back to.
        extensionReport(id, `failed to load: ${err} (${first.name})`)
        continue
      }
      const brokenPath = recordBroken(first.commit, err)
      const prevHash = readState(first.commit.statePath).hash ?? ""
      const backFile = prevHash ? join(goodDir, `${first.commit.base}.${prevHash}.js`) : ""
      const back = backFile && existsSync(backFile) ? await importFile(backFile) : { error: "none" }
      let restored = false
      if (back.mod) {
        try {
          await flush(await begin(id, back.mod).setup())
          restored = true
        } catch (e2) {
          extensionReport(id, `last-good copy failed to register too: ${e2?.message ?? e2}`)
        }
      }
      extensionReport(
        id,
        `failed to load: ${err} (${first.commit.file})` +
          (restored
            ? ` — rolled back to the last version that loaded; the broken copy is ${brokenPath}. Fix the source, then reload.`
            : ` — nothing earlier to roll back to; the broken copy is ${brokenPath}.`),
      )
    }
  }
  await speakWhenNothingLoaded()
}
