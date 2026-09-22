/**
 * Test suite: classify heuristics, config/token resolution, and an end-to-end
 * event→publish flow against a fake ntfy server. Run: npm test
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { detectAccess } from "../src/access"
import {
  cleanText,
  errorCaption,
  finishedCaption,
  formCaption,
  permissionCaption,
  questionCaption,
  truncateAt,
} from "../src/caption"
import { classify, excerpt, preprocess } from "../src/classify"
import { readConfig, type StorageLike } from "../src/config"
import { watchEvents, type EventsDeps } from "../src/events"
import { Notifier, freshState, sharedState, type FetchLike } from "../src/publish"
import { registerTool } from "../src/tool"

let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ok - ${name}`)
    })
    .catch((error) => {
      failures.push(name)
      console.log(`  FAIL - ${name}: ${(error as Error).message}`)
    })
}

const flush = () => new Promise((r) => setTimeout(r, 20))

function fakeStorage(initial: Record<string, unknown> = {}): StorageLike & { map: Map<string, unknown> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
  }
}

interface Published {
  url: string
  body: any
  headers: Record<string, string>
}

function fakeFetch(): FetchLike & { sent: Published[]; mode: string } {
  const sent: Published[] = []
  const fn = (async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (fn.mode === "http401") return new Response("unauthorized", { status: 401 })
    if (fn.mode === "throw") throw new Error("connect ECONNREFUSED")
    sent.push({ url: input, body, headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response("ok", { status: 200 })
  }) as FetchLike & { sent: Published[]; mode: string }
  fn.sent = sent
  fn.mode = "ok"
  return fn
}

function fakeCtx(
  events: unknown[],
  sessions: Record<string, { title?: string; outcome?: string }> = {},
): EventsDeps {
  return {
    event: {
      subscribe: () =>
        (async function* () {
          for (const e of events) yield e
        })(),
    },
    session: {
      async get({ sessionID }) {
        const s = sessions[sessionID]
        if (!s) throw new Error("session not found")
        return s
      },
    },
  }
}

// Capture console.error output while running fn.
async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "))
  }
  try {
    await fn()
  } finally {
    console.error = original
  }
  return lines
}

const SESSIONS = {
  ask: { title: "Fix login bug", outcome: "succeeded" },
  done: { title: "Add dark mode", outcome: "succeeded" },
  qs: { title: "Refactor plan", outcome: "succeeded" },
  qfin: { title: "Staging migration", outcome: "succeeded" },
  exec: { title: "Boundary rewrite", outcome: "succeeded" },
  ff: { title: "Form fields demo", outcome: "succeeded" },
  stopped: { title: "Long job", outcome: "interrupted" },
  boom: { title: "Risky task", outcome: "failed" },
  tools: { title: "Flaky suite", outcome: "succeeded" },
}

async function runMainFlow() {
  const storage = fakeStorage()
  const { config } = await readConfig(
    { serverUrl: "http://ntfy.test", baseTopic: "opencode-test", events: { error: { cooldownSec: 0.03 } } },
    storage,
  )
  assert.ok(config, "config should parse")
  const fetcher = fakeFetch()
  const notifier = new Notifier(config!, fetcher as FetchLike)
  const controller = new AbortController()

  const events = [
    // Session "ask": permission question, then idle within window → finished suppressed.
    { type: "permission.asked", data: { sessionID: "ask", action: "shell", resources: ["npm test"], message: "Run tests?" } },
    { type: "session.text.ended", data: { sessionID: "ask", assistantMessageID: "m1", ordinal: 0, text: "Running tests now." } },
    { type: "session.idle", data: { sessionID: "ask" } },
    // Session "done": plain completion.
    { type: "session.text.ended", data: { sessionID: "done", assistantMessageID: "m2", ordinal: 0, text: "All done, dark mode shipped." } },
    { type: "session.idle", data: { sessionID: "done" } },
    // Session "qs": turn ends on a question.
    { type: "session.text.ended", data: { sessionID: "qs", assistantMessageID: "m3", ordinal: 0, text: "Refactor is ready — should I squash these commits?" } },
    { type: "session.idle", data: { sessionID: "qs" } },
    // Session "stopped": interrupted → no ping.
    { type: "session.idle", data: { sessionID: "stopped" } },
    // Session "boom": execution fails → error ping, idle with failed outcome → no finished ping.
    { type: "session.execution.failed", data: { sessionID: "boom", error: { type: "provider", message: "Model overloaded" } } },
    { type: "session.idle", data: { sessionID: "boom" } },
    // Session "tools": flapping tool errors → cooldown + suppressed count.
    // input.started registers the tool NAME (tool.failed carries only the call id).
    { type: "session.tool.input.started", data: { sessionID: "tools", assistantMessageID: "mT", id: "t1", name: "shell" } },
    { type: "session.tool.failed", data: { sessionID: "tools", assistantMessageID: "mT", id: "t1", error: { type: "tool", message: "ECONNRESET" } } },
    { type: "session.tool.failed", data: { sessionID: "tools", assistantMessageID: "mT", id: "t1", error: { type: "tool", message: "ECONNRESET" } } },
    { type: "session.tool.failed", data: { sessionID: "tools", assistantMessageID: "mT", id: "t1", error: { type: "tool", message: "ECONNRESET" } } },
    // Form question.
    { type: "form.created", data: { form: { id: "f1", sessionID: "done", title: "Which database?" } } },
    // Session "qfin": turn ends on a question (question fires), then a stray
    // duplicate boundary within the window → finished must be suppressed (§6.2).
    { type: "session.text.ended", data: { sessionID: "qfin", assistantMessageID: "m5", ordinal: 0, text: "Migration ready — should I run it against staging?" } },
    { type: "session.idle", data: { sessionID: "qfin" } },
    { type: "session.execution.succeeded", data: { sessionID: "qfin" } },
    // Session "exec": turn completion via session.execution.succeeded — the
    // live-verified boundary trigger (session.idle is never emitted by the server).
    // execution.started + tool calls feed the Direction 3 telemetry caption.
    { type: "session.execution.started", data: { sessionID: "exec" } },
    { type: "session.tool.called", data: { sessionID: "exec", assistantMessageID: "m6", id: "c1", executed: true } },
    { type: "session.tool.success", data: { sessionID: "exec", assistantMessageID: "m6", id: "c1", executed: true } },
    { type: "session.tool.called", data: { sessionID: "exec", assistantMessageID: "m6", id: "c2", executed: true } },
    { type: "session.tool.success", data: { sessionID: "exec", assistantMessageID: "m6", id: "c2", executed: true } },
    { type: "session.text.ended", data: { sessionID: "exec", assistantMessageID: "m6", ordinal: 0, text: "Boundary rewrite is complete." } },
    { type: "session.execution.succeeded", data: { sessionID: "exec" } },
    // Form WITH fields → lock-screen choices in the caption.
    {
      type: "form.created",
      data: {
        form: {
          id: "f2",
          sessionID: "ff",
          title: "Pick env",
          fields: [
            { key: "env", title: "Environment", type: "multiselect", options: [{ label: "staging" }, { label: "prod" }] },
            { key: "dry", title: "Dry run?", type: "boolean" },
            { key: "note", title: "Internal note", type: "string", hidden: true },
          ],
        },
      },
    },
  ]

  const done = watchEvents(fakeCtx(events, SESSIONS), notifier, config!, controller.signal)
  await done
  await flush()
  return { fetcher, config: config!, notifier }
}

async function main() {
  console.log("classify")
  await test("trailing ? → question", () => {
    assert.equal(classify("Should I squash these commits?"), "question")
  })
  await test("plain statement → finished", () => {
    assert.equal(classify("All tests pass. Dark mode is shipped."), "finished")
  })
  await test("mid-message ? only → finished", () => {
    assert.equal(classify("Two tests failed. 3 were they flaky? Investigating… no, real. Fixed."), "finished")
  })
  await test("phrase pattern anywhere → question", () => {
    assert.equal(classify("Done with the migration. Let me know if you'd like the old table dropped."), "question")
  })
  await test("trailing ? inside code fence ignored", () => {
    assert.equal(classify("```\nreally = \"confusing?\"\n```\nAll green.", undefined), "finished")
  })
  await test("mode always / off", () => {
    assert.equal(classify("All green.", "always"), "question")
    assert.equal(classify("Really?", "off"), "finished")
  })
  await test("custom patterns replace defaults (trailing ? rule still applies)", () => {
    assert.equal(classify("Shall we dance?", "heuristic", ["\\bdance\\b"]), "question")
    assert.equal(classify("Should I squash these commits then", "heuristic", ["\\bdance\\b"]), "finished")
    assert.equal(classify("Should I squash these commits then"), "question") // default pattern list
  })
  await test("preprocess strips urls/emphasis/code", () => {
    assert.equal(preprocess("See [docs](http://x.io) for **truth**"), "See docs for truth")
  })
  await test("excerpt truncates", () => {
    assert.ok(excerpt("x".repeat(500), 100).length <= 100)
  })

  console.log("config")
  await test("missing serverUrl → problem, no config", async () => {
    delete process.env.NTFY_SERVER_URL
    delete process.env.NTFY_BASE_URL
    const res = await readConfig({}, fakeStorage())
    assert.equal(res.config, undefined)
    assert.equal(res.problems.length, 1)
    assert.match(res.problems[0], /NTFY_SERVER_URL/)
  })
  await test("serverUrl from env", async () => {
    process.env.NTFY_SERVER_URL = "http://env.test/"
    const res = await readConfig({}, fakeStorage())
    assert.equal(res.config?.serverUrl, "http://env.test")
    delete process.env.NTFY_SERVER_URL
  })
  await test("token chain: literal, {env:NAME} unresolved, default env", async () => {
    process.env.MY_TOK = "from-env"
    process.env.NTFY_TOKEN = "default-tok"
    let res = await readConfig({ serverUrl: "http://t", token: "literal" }, fakeStorage())
    assert.equal(res.config?.token, "literal")
    res = await readConfig({ serverUrl: "http://t", token: "{env:MY_TOK}" }, fakeStorage())
    assert.equal(res.config?.token, "from-env")
    res = await readConfig({ serverUrl: "http://t" }, fakeStorage())
    assert.equal(res.config?.token, "default-tok")
    res = await readConfig({ serverUrl: "http://t", token: "{env:MISSING_VAR}" }, fakeStorage())
    assert.equal(res.config?.token, "default-tok") // falls through to NTFY_TOKEN
    delete process.env.MY_TOK
    delete process.env.NTFY_TOKEN
  })
  await test("baseTopic auto-generated once and persisted", async () => {
    const storage = fakeStorage()
    const first = await readConfig({ serverUrl: "http://t" }, storage)
    const generated = first.config!.topic
    assert.match(generated, /^opencode-[a-f0-9]{10}$/)
    const second = await readConfig({ serverUrl: "http://t" }, storage)
    assert.equal(second.config!.topic, generated)
    assert.equal(storage.map.get("baseTopic"), generated)
  })
  await test("event defaults and overrides", async () => {
    const res = await readConfig(
      {
        serverUrl: "http://t",
        baseTopic: "bt",
        events: { question: { priority: "high", enabled: false }, error: { cooldownSec: 5 } },
      },
      fakeStorage(),
    )
    const ev = res.config!.events
    assert.equal(ev.question.enabled, false)
    assert.equal(ev.question.priority, 4)
    assert.equal(ev.finished.priority, 3)
    assert.equal(ev.error.cooldownMs, 5000)
    assert.equal(res.config!.topic, "bt")
  })
  await test("permission event defaults: enabled, urgent, lock tag", async () => {
    const res = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    const p = res.config!.events.permission
    assert.equal(p.enabled, true)
    assert.equal(p.priority, 5)
    assert.deepEqual(p.tags, ["lock"])
  })
  await test("permission.enabled=false → asks never publish", async () => {
    const res = await readConfig(
      { serverUrl: "http://t", baseTopic: "bt", events: { permission: { enabled: false } } },
      fakeStorage(),
    )
    const f = fakeFetch()
    new Notifier(res.config!, f as FetchLike).notify("permission", "p1", {
      title: "Permission needed: x",
      message: "m",
    })
    await flush()
    assert.equal(f.sent.length, 0)
  })
  await test("startup info lists the subscribe topic", async () => {
    const res = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    assert.ok(res.info.some((l) => l.includes("topic: bt")))
  })

  console.log("access modes (local / tailscale / cloudflare)")
  await test("loopback → local mode with loopback warning and phone hint", () => {
    const a = detectAccess("http://127.0.0.1:8080")
    assert.equal(a.mode, "local")
    assert.ok(a.warnings.some((w) => /loopback/.test(w)), "warns phone can't use loopback")
    assert.ok(a.hints.some((h) => /phone/.test(h)))
  })
  await test("private LAN IP → local mode, no warnings", () => {
    const a = detectAccess("http://192.168.1.42")
    assert.equal(a.mode, "local")
    assert.equal(a.warnings.length, 0)
    assert.ok(a.summary.includes("LAN"))
    // Same for 10.x and 172.16-31.x
    assert.equal(detectAccess("http://10.0.5.5").mode, "local")
    assert.equal(detectAccess("http://172.20.1.1").mode, "local")
  })
  await test("ts.net hostname and 100.64–127 CGNAT IPs → tailscale", () => {
    assert.equal(detectAccess("https://mac-abc123.tail1234.ts.net").mode, "tailscale")
    assert.equal(detectAccess("http://100.64.0.10").mode, "tailscale")
    assert.equal(detectAccess("https://100.101.102.103").mode, "tailscale")
    assert.notEqual(detectAccess("https://100.8.9.10").mode, "tailscale") // outside CGNAT slice
  })
  await test("public https (tunnel/reverse proxy) → cloudflare, no warnings", () => {
    const a = detectAccess("https://ntfy.example.com")
    assert.equal(a.mode, "cloudflare")
    assert.equal(a.warnings.length, 0)
    assert.ok(a.hints.some((h) => /anywhere/.test(h)))
  })
  await test("public http → cloudflare with TLS warning", () => {
    const a = detectAccess("http://203.0.113.7")
    assert.equal(a.mode, "cloudflare")
    assert.ok(a.warnings.some((w) => /TLS/.test(w)))
  })
  await test("trycloudflare quick tunnel → restart warning", () => {
    const a = detectAccess("https://random-words.trycloudflare.com")
    assert.equal(a.mode, "cloudflare")
    assert.ok(a.warnings.some((w) => /quick tunnel/.test(w)))
  })
  await test("unparseable serverUrl → warning, publishing will fail loudly", () => {
    const a = detectAccess("ntfy.example.com") // missing scheme
    assert.ok(a.warnings.some((w) => /not a valid URL/.test(w)))
  })
  await test("accessMode option overrides detection; invalid value falls back to auto", async () => {
    const forced = await readConfig({ serverUrl: "http://127.0.0.1", accessMode: "tailscale" }, fakeStorage())
    assert.ok(forced.info.some((l) => l.includes("access mode: tailscale")))
    const invalid = await readConfig({ serverUrl: "http://127.0.0.1", accessMode: "wat" }, fakeStorage())
    assert.ok(invalid.info.some((l) => l.includes("access mode: local")))
  })
  await test("startup info includes access mode line and hints", async () => {
    const res = await readConfig({ serverUrl: "https://ntfy.example.com", baseTopic: "bt" }, fakeStorage())
    assert.ok(res.info.some((l) => l.includes("access mode: cloudflare")))
    assert.ok(res.info.some((l) => l.startsWith("hint: ")))
  })

  console.log("events → publish (end-to-end)")
  const { fetcher, config, notifier } = await runMainFlow()
  const byKind = (titlePrefix: string) => fetcher.sent.filter((s) => s.body.title?.startsWith(titlePrefix))

  await test("permission.asked → permission publish (urgent, lock tag, single topic, bearer auth)", () => {
    const q = byKind("Permission needed:")
    assert.equal(q.length, 1)
    assert.equal(q[0].body.topic, "opencode-test")
    assert.equal(q[0].body.priority, 5)
    assert.deepEqual(q[0].body.tags, ["lock"])
    assert.equal(q[0].body.message, "shell · npm test — Run tests?")
    assert.equal((q[0].headers as any).Authorization, undefined)
  })
  await test("finished NOT suppressed by an earlier permission (permission is its own kind, not a question)", () => {
    assert.equal(byKind("Finished: Fix login bug").length, 1)
  })
  await test("question→finished suppression still works via double boundary (session qfin)", () => {
    assert.equal(byKind("Question: Staging migration").length, 1)
    assert.equal(byKind("Finished: Staging migration").length, 0)
  })
  await test("session.execution.succeeded → telemetry caption (Done in 1s · 2 tools)", () => {
    const f = byKind("Finished: Boundary rewrite")
    assert.equal(f.length, 1)
    assert.equal(f[0].body.priority, 3)
    assert.equal(f[0].body.message, "Done in 1s · 2 tools")
  })
  await test("plain completion without telemetry → fallback caption", () => {
    const f = byKind("Finished: Add dark mode")
    assert.equal(f.length, 1)
    assert.equal(f[0].body.topic, "opencode-test")
    assert.equal(f[0].body.priority, 3)
    assert.equal(f[0].body.message, "Agent finished its turn.")
  })
  await test("text-classified question → question publish", () => {
    const q = byKind("Question: Refactor plan")
    assert.equal(q.length, 1)
    assert.equal(q[0].body.priority, 5)
    assert.match(q[0].body.message, /squash these commits/)
  })
  await test("interrupted turn → no notification", () => {
    assert.equal(byKind("Finished: Long job").length, 0)
    assert.equal(byKind("Question: Long job").length, 0)
  })
  await test("failed turn → error publish, no finished", () => {
    const e = byKind("Error: Risky task")
    assert.equal(e.length, 1)
    assert.equal(e[0].body.topic, "opencode-test")
    assert.equal(e[0].body.priority, 4)
    assert.match(e[0].body.message, /Model overloaded/)
    assert.equal(byKind("Finished: Risky task").length, 0)
  })
  await test("tool error cooldown: 1st fires, 2nd suppressed, 3rd after cooldown carries count", async () => {
    const e = byKind("Error: Flaky suite")
    assert.equal(e.length, 1)
    assert.equal(e[0].body.message, "shell failed · ECONNRESET")
    assert.equal(e[0].body.message.includes("suppressed"), false)
    // 2 tool failures inside the 30ms cooldown were suppressed (script fired 3 total).
    await new Promise((r) => setTimeout(r, 60)) // > cooldownSec 0.03
    notifier.notify("error", "tools", {
      title: "Error: Flaky suite",
      message: "Tool failed: ECONNRESET",
    })
    await flush()
    const all = byKind("Error: Flaky suite")
    assert.equal(all.length, 2)
    assert.match(all[1].body.message, /\(\+2 similar errors suppressed\)/)
  })
  await test("form.created → question with form title", () => {
    const q = fetcher.sent.filter((s) => s.body.message === "Which database?")
    assert.equal(q.length, 1)
    assert.equal(q[0].body.topic, "opencode-test")
  })
  await test("form.created with fields → lock-screen choices in caption (hidden skipped)", () => {
    const q = fetcher.sent.filter((s) => s.body.title?.startsWith("Question: Form fields demo"))
    assert.equal(q.length, 1)
    assert.equal(q[0].body.message, "Pick env · Environment: staging | prod · Dry run?: yes | no")
  })

  console.log("captions (Direction 3, §6.4)")
  await test("cleanText strips headers/bold/urls and collapses whitespace", () => {
    assert.equal(cleanText("## Next steps\n\nSome **bold** [link](http://x.io) here"), "Next steps Some bold link here")
  })
  await test("truncateAt cuts at a word boundary with ellipsis", () => {
    assert.equal(truncateAt("abcdefgh ijklmn opqr", 12), "abcdefgh…")
  })
  await test("questionCaption extracts the trailing question sentence", () => {
    assert.equal(
      questionCaption("Migration ran fine and all checks are green. Ready for the review?"),
      "Ready for the review?",
    )
  })
  await test("questionCaption extracts the pattern-matched sentence (no trailing ?)", () => {
    assert.equal(
      questionCaption("Done with the migration. Let me know if you'd like the old table dropped."),
      "Let me know if you'd like the old table dropped.",
    )
  })
  await test("questionCaption falls back when text is empty", () => {
    assert.equal(questionCaption("   "), "The agent is waiting for your input.")
  })
  await test("finishedCaption builds telemetry and falls back", () => {
    assert.equal(
      finishedCaption({ startedAt: 1_000, endedAt: 113_000, tools: 9, failed: 1 }),
      "Done in 1m 52s · 9 tools · 1 failed",
    )
    assert.equal(finishedCaption({ endedAt: 0, tools: 0, failed: 0 }), "Agent finished its turn.")
    assert.equal(finishedCaption(undefined), "Agent finished its turn.")
    // watcher started mid-turn (no execution.started seen) → duration omitted, counts kept
    assert.equal(finishedCaption({ endedAt: 0, tools: 3, failed: 0 }), "3 tools")
  })
  await test("errorCaption: tool name + first line only + word-boundary cap", () => {
    assert.equal(
      errorCaption("tool", "edit", "Could not find oldString in SPEC.md\nstack trace follows"),
      "edit failed · Could not find oldString in SPEC.md",
    )
    assert.equal(errorCaption("tool", undefined, "boom"), "Tool failed · boom")
    assert.equal(errorCaption("session", undefined, "Model overloaded"), "Session failed · Model overloaded")
    const long = errorCaption("tool", "shell", "x".repeat(300) + " tail")
    assert.ok(long.endsWith("…"))
    assert.ok(long.length <= "shell failed · ".length + 161, `too long: ${long.length}`)
  })
  await test("permissionCaption: structured ask, message appended, fallback", () => {
    assert.equal(permissionCaption("read", ["permtest.env"]), "read · permtest.env")
    assert.equal(permissionCaption("shell", ["npm test"], "Run tests?"), "shell · npm test — Run tests?")
    assert.equal(permissionCaption(undefined, undefined, undefined), "The agent needs permission to continue.")
  })
  await test("formCaption renders choices, skips hidden fields, falls back to title", () => {
    assert.equal(formCaption("Which database?"), "Which database?")
    assert.equal(formCaption(undefined), "The agent asked you a question.")
    assert.equal(
      formCaption("Pick env", [
        { key: "env", title: "Environment", type: "multiselect", options: [{ label: "staging" }, { label: "prod" }] },
        { key: "dry", title: "Dry run?", type: "boolean" },
        { key: "note", title: "Internal note", type: "string", hidden: true },
      ]),
      "Pick env · Environment: staging | prod · Dry run?: yes | no",
    )
  })

  console.log("shared state across concurrently loaded plugin instances")
  await test("sharedState() is a process-wide singleton", () => {
    assert.equal(sharedState(), sharedState())
  })
  await test("default Notifier state stays instance-local (test isolation)", async () => {
    const { config: cfg } = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    const f1 = fakeFetch()
    const f2 = fakeFetch()
    new Notifier(cfg!, f1 as FetchLike).notify("question", "iso", { title: "Q", message: "m" })
    new Notifier(cfg!, f2 as FetchLike).notify("question", "iso", { title: "Q", message: "m" })
    await flush()
    assert.equal(f1.sent.length, 1)
    assert.equal(f2.sent.length, 1, "instance-local state must not cross-suppress")
  })
  await test("3 instances sharing state publish one event once; finished suppressed cross-instance", async () => {
    const { config: cfg } = await readConfig(
      { serverUrl: "http://t", baseTopic: "bt", events: { error: { cooldownSec: 300 } } },
      fakeStorage(),
    )
    const shared = freshState()
    const f1 = fakeFetch()
    const f2 = fakeFetch()
    const f3 = fakeFetch()
    const n1 = new Notifier(cfg!, f1 as FetchLike, shared)
    const n2 = new Notifier(cfg!, f2 as FetchLike, shared)
    const n3 = new Notifier(cfg!, f3 as FetchLike, shared)
    // The same event observed by three concurrently loaded plugin copies…
    const input = { title: "Question: Which database?", message: "postgres or sqlite?" }
    n1.notify("question", "dup", input)
    n2.notify("question", "dup", input)
    n3.notify("question", "dup", input)
    // …and a finished event from another copy right behind the question.
    n2.notify("finished", "dup", { title: "Finished: x", message: "done" })
    await flush()
    assert.equal(f1.sent.length, 1, "first instance publishes")
    assert.equal(f2.sent.length, 0, "second + third instances suppressed")
    assert.equal(f3.sent.length, 0, "third instance suppressed")
    assert.equal(f1.sent[0].body.topic, "bt")
  })
  await test("error cooldown counts across instances", async () => {
    const { config: cfg } = await readConfig(
      { serverUrl: "http://t", baseTopic: "bt", events: { error: { cooldownSec: 300 } } },
      fakeStorage(),
    )
    const shared = freshState()
    const f1 = fakeFetch()
    const f2 = fakeFetch()
    const n1 = new Notifier(cfg!, f1 as FetchLike, shared)
    const n2 = new Notifier(cfg!, f2 as FetchLike, shared)
    n1.notify("error", "co", { title: "E", message: "boom" })
    n2.notify("error", "co", { title: "E", message: "boom" })
    n2.notify("error", "co", { title: "E", message: "boom" })
    await flush()
    assert.equal(f1.sent.length, 1, "cooldown shared → one error published")
    assert.equal(f2.sent.length, 0)
  })

  console.log("failure logging (§7.1)")
  await test("first failure logs, repeats rate-limited, recovery logged once", async () => {
    const storage = fakeStorage()
    const { config: cfg } = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, storage)
    const fetcher = fakeFetch()
    fetcher.mode = "http401"
    const notifier = new Notifier(cfg!, fetcher as FetchLike)
    const lines = await captureLogs(async () => {
      notifier.notify("question", "s1", { title: "A", message: "m" })
      await flush()
      notifier.notify("question", "s1", { title: "B", message: "m" })
      await flush()
      notifier.notify("finished", "s1", { title: "C", message: "m" })
      await flush()
    })
    const failuresLogged = lines.filter((l) => l.includes("HTTP 401"))
    assert.equal(failuresLogged.length, 1, `expected 1 failure log, got: ${JSON.stringify(lines)}`)
    assert.ok(failuresLogged[0].includes("check token"), "should include actionable hint")
    // Recover: same topic as the earlier failure ("bt") now succeeds.
    fetcher.mode = "ok"
    const recovery = await captureLogs(async () => {
      notifier.notify("question", "s2", { title: "D", message: "m" })
      await flush()
    })
    assert.equal(recovery.filter((l) => l.includes("recovered")).length, 1)
  })
  await test("transport failures rate-limited to one line per (topic, class)", async () => {
    const { config: cfg } = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    const fetcher = fakeFetch()
    fetcher.mode = "throw"
    const notifier = new Notifier(cfg!, fetcher as FetchLike)
    const lines = await captureLogs(async () => {
      // All kinds share the one topic, so every transport failure lands in the
      // same (topic, class) bucket → rate-limited to a single line.
      notifier.notify("question", "s1", { title: "A", message: "m" })
      notifier.notify("question", "s2", { title: "B", message: "m" })
      notifier.notify("error", "s3", { title: "C", message: "m" })
      await flush()
    })
    const eLines = lines.filter((l) => l.includes("ECONNREFUSED"))
    assert.equal(eLines.length, 1, `expected 1 (single topic + class), got: ${JSON.stringify(lines)}`)
  })

  console.log("ntfy_notify tool")
  await test("registers ntfy_notify and publishes custom notifications", async () => {
    const { config: cfg } = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    const fetcher = fakeFetch()
    const notifier = new Notifier(cfg!, fetcher as FetchLike)
    let added: any
    let namespace: any
    const ctx = {
      tool: {
        transform: async (cb: (e: any) => void) => {
          cb({
            namespace: (n: any) => (namespace = n),
            add: (t: any) => (added = t),
          })
          return { dispose: async () => {} }
        },
      },
    }
    await registerTool(ctx as any, notifier, cfg!)
    assert.equal(namespace.name, "ntfy")
    assert.equal(added.name, "notify")
    assert.ok(added.description.includes("phone"))

    const execCtx = { signal: new AbortController().signal, progress: async () => {} }
    const ok = await added.execute({ message: "Deploy done", title: "CI", priority: "urgent", tags: ["tada"] }, execCtx)
    await flush()
    assert.match(ok.content, /Notification sent/)
    assert.equal(fetcher.sent.length, 1)
    assert.equal(fetcher.sent[0].body.topic, "bt")
    assert.equal(fetcher.sent[0].body.priority, 5)
    assert.deepEqual(fetcher.sent[0].body.tags, ["tada"])

    // Validation paths
    const badTopic = await added.execute({ message: "x", topic: "bad topic!" }, execCtx)
    assert.match(badTopic.content, /invalid topic/)
    const missing = await added.execute(undefined, execCtx)
    assert.match(missing.content, /'message' is required/)
    // Topic override is honored
    await added.execute({ message: "x", topic: "bt-deploy" }, execCtx)
    await flush()
    assert.equal(fetcher.sent.at(-1)!.body.topic, "bt-deploy")
  })

  console.log("setup-server.sh non-interactive contract (SPEC §14.3)")
  const sh = fileURLToPath(new URL("./setup-server.sh", import.meta.url))
  const runSh = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [sh, ...args], { encoding: "utf8", env: { ...process.env, ...env } })

  await test("--help exits 0 and documents modes, preflight, exit codes", () => {
    const r = runSh(["--help"])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /local\|tailscale\|cloudflare/)
    assert.match(r.stdout, /preflight/)
    assert.match(r.stdout, /Exit codes: 0 ok · 2 usage/)
  })

  await test("--json + unknown argument → exit 2, one JSON error object on stdout", () => {
    const r = runSh(["--json", "bogus"])
    assert.equal(r.status, 2)
    assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one stdout line")
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, false)
    assert.equal(out.code, 2)
    assert.equal(out.kind, "setup")
    assert.match(out.error, /unknown argument/)
  })

  await test("conflicting modes → exit 2 with JSON", () => {
    const r = runSh(["--json", "local", "cloudflare"])
    assert.equal(r.status, 2)
    assert.match(JSON.parse(r.stdout).error, /conflicting modes/)
  })

  await test("preflight --json: side-effect-free machine report, exit codes scored", () => {
    const r = runSh(["preflight", "--json"])
    assert.ok(r.status === 0 || r.status === 3 || r.status === 4, `unexpected status ${r.status}`)
    assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one stdout line")
    const out = JSON.parse(r.stdout)
    assert.equal(out.kind, "preflight")
    assert.equal(typeof out.port, "number")
    const ids: string[] = out.checks.map((c: any) => c.id)
    for (const id of ["docker-cli", "docker-compose", "docker-daemon"]) {
      assert.ok(ids.includes(id), `missing check ${id}: ${JSON.stringify(ids)}`)
    }
    assert.ok(ids.some((i) => i.startsWith("port-")), "port check present")
    assert.equal(out.ok, r.status === 0)
    for (const c of out.checks) assert.equal(typeof c.ok, "boolean")
  })

  await test("preflight <mode> scopes checks to that mode (lan-ip / cloudflare-hostname)", () => {
    const local = runSh(["preflight", "local", "--json"])
    const parsed = JSON.parse(local.stdout)
    assert.equal(parsed.mode, "local")
    assert.ok(parsed.checks.some((c: any) => c.id === "lan-ip"), "lan-ip check for local")
    const cf = runSh(["preflight", "cloudflare", "--json"], { CF_HOSTNAME: "" })
    const cfOut = JSON.parse(cf.stdout)
    assert.equal(cfOut.mode, "cloudflare")
    const host = cfOut.checks.find((c: any) => c.id === "cloudflare-hostname")
    assert.ok(host, "hostname check present")
    assert.equal(host.ok, false, "empty CF_HOSTNAME must fail its check")
    assert.ok([3, 4].includes(cf.status!), `expected scored failure, got ${cf.status}`)
  })

  await test("cloudflare mode re-points a stale DNS route (530 regression guard)", () => {
    // uninstall.sh deletes the tunnel but keeps the DNS route, so the record can
    // still aim at a dead tunnel. `route dns` without -f fails on an existing
    // record, and swallowing that failure leaves the hostname on Cloudflare 530
    // (error 1033) and the phone unable to subscribe.
    const src = readFileSync(sh, "utf8")
    const route = src.match(/"\$CF" tunnel route dns[^\n]*/)
    assert.ok(route, "cloudflared route dns call present")
    assert.match(route![0], /tunnel route dns -f ntfy/, "route dns must overwrite the existing record")
    assert.doesNotMatch(src, /already exists — ok/, "a failed route must not be swallowed")
  })

  await test("occupied NTFY_PORT → exit 4 with owner, before any file writes", async () => {
    // A held port must be reported as a conflict. If docker prerequisites are
    // missing, the script must fail earlier with 3 instead (and change nothing).
    const gen = runSh(["preflight", "--json"])
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = runSh(["--json", "local"], { NTFY_PORT: String(port) })
      const want = gen.status === 0 || gen.status === 4 ? 4 : 3
      assert.equal(r.status, want, `stdout: ${r.stdout} stderr: ${r.stderr}`)
      if (r.status === 4) {
        const out = JSON.parse(r.stdout)
        assert.equal(out.ok, false)
        assert.equal(out.code, 4)
        assert.match(out.error, /in use/)
        assert.match(out.error, /NTFY_PORT/)
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  console.log("install.sh wizard contract (SPEC §14.4)")
  const inst = fileURLToPath(new URL("../install.sh", import.meta.url))
  // Neutralize any wizard env from the outer shell, then apply per-test overrides.
  const cleanEnv = () => ({
    NTFY_HARNESSES: "", NTFY_MODE: "", NTFY_SCOPE: "", NTFY_EVENTS: "", NTFY_PHONE: "",
    NTFY_INSTALL_DEPS: "", NTFY_SKIP_CONFIRM: "", CF_HOSTNAME: "", NTFY_CONFIG_FILE: "",
  })
  const runInst = (args: string[] = [], env: Record<string, string> = {}, input?: string) =>
    spawnSync("bash", [inst, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...cleanEnv(), ...env },
      input,
      timeout: 15000,
    })

  await test("--help exits 0 and documents the wizard + env overrides", () => {
    const r = runInst(["--help"])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /interactive wizard/)
    assert.match(r.stdout, /NTFY_MODE/)
    assert.match(r.stdout, /Exit codes: 0 ok/)
  })

  await test("invalid NTFY_MODE fails fast → exit 2", () => {
    const r = runInst([], { NTFY_MODE: "bogus" }, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /NTFY_MODE must be local\|tailscale\|cloudflare/)
  })

  await test("invalid NTFY_HARNESSES fails fast → exit 2", () => {
    const r = runInst([], { NTFY_HARNESSES: "other" }, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /NTFY_HARNESSES must be both\|opencode\|codex/)
  })

  await test("invalid NTFY_SCOPE fails fast → exit 2", () => {
    const r = runInst([], { NTFY_SCOPE: "machine" }, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /NTFY_SCOPE must be global\|project/)
  })

  await test("invalid NTFY_EVENTS kind fails fast → exit 2", () => {
    const r = runInst([], { NTFY_EVENTS: "question,bogus" }, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown kind 'bogus'/)
  })

  await test("invalid NTFY_PHONE fails fast → exit 2", () => {
    const r = runInst([], { NTFY_PHONE: "pager" }, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /NTFY_PHONE must be ios\|android\|none/)
  })

  await test("EOF at the first prompt → exit 2 with scripted-help hint", () => {
    const r = runInst([], {}, "")
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no input/)
    assert.match(r.stderr, /NTFY_\* env overrides/)
  })

  await test("INSTALL.md documents the full env contract (drift guard)", () => {
    const md = readFileSync(fileURLToPath(new URL("../INSTALL.md", import.meta.url)), "utf8")
    for (const s of [
      "NTFY_HARNESSES", "NTFY_MODE", "NTFY_SCOPE", "NTFY_EVENTS", "NTFY_PHONE", "NTFY_INSTALL_DEPS",
      "NTFY_SKIP_CONFIRM", "CF_HOSTNAME", "NTFY_PORT", "LAN_IP", "NTFY_CONFIG_FILE",
      "setup-server.sh preflight", "sh install.sh",
      "`0` ok · `2` usage/bad input · `3` missing",  // exit-code contract
      "re-subscribe",           // wake-hash gotcha on mode switch
      "start (or restart) OpenCode once",  // new-plugin load gotcha
      "baseTopic", "serverUrl",
      "SERVER_URL=", "TOPIC=", "TOKEN=",  // Step 4 vars must be defined before use
      "smoke line",             // Step 5 fields captured in Step 2
    ]) assert.ok(md.includes(s), `INSTALL.md missing: ${s}`)
    // Dogfood defect #2: a comment after a `\` continuation silently drops every env var.
    assert.ok(!/^[^\n]*\\[ \t]+#/m.test(md), "INSTALL.md: comment after line-continuation backslash")
  })

  console.log("uninstall.sh contract (SPEC §15)")
  const uninst = fileURLToPath(new URL("../scripts/uninstall.sh", import.meta.url))
  const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/, "")
  // Neutralize uninstall env from the outer shell; per-test overrides win.
  const cleanUnEnv = () => ({
    NTFY_CONFIG_FILE: "", NTFY_PLUGIN_DIR: "", NTFY_REMOVE_PATHS: "",
    NTFY_SETUP_DIR: "", XDG_CONFIG_HOME: "",
  })
  const runUn = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync("bash", [uninst, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...cleanUnEnv(), ...env },
      timeout: 30000,
    })
  const fixt = (cfg: unknown, raw?: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ntfy-uninstall-"))
    const f = path.join(dir, "opencode.json")
    writeFileSync(f, raw !== undefined ? raw : JSON.stringify(cfg, null, 2) + "\n")
    return f
  }
  const unfixt = (f: string) => rmSync(path.dirname(f), { recursive: true, force: true })
  const readJ = (f: string): any => JSON.parse(readFileSync(f, "utf8"))
  const ourEntry = {
    serverUrl: "https://s.example.com",
    token: "tk_fixture0000000000000000000",
    baseTopic: "opencode-aaaaaaaaaa",
  }
  // PATH-shim fixtures for L2/L3 (D17d): fake docker/launchctl/cloudflared/tailscale
  // record every argv into $SHIM_LOG and drive replies from marker files in $ST —
  // the real machine's container/tunnel/serve/plist are never touched.
  const mkShims = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "ntfy-shim-"))
    const bin = path.join(d, "bin")
    const st = path.join(d, "state")
    const log = path.join(d, "argv.log")
    mkdirSync(bin, { recursive: true })
    mkdirSync(st, { recursive: true })
    writeFileSync(log, "")
    const shim = (name: string, body: string) => {
      const f = path.join(bin, name)
      // trailing `exit 0` keeps shim-internal `&&` chains from leaking rc under `set -e`
      writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$SHIM_LOG"\n${body}\nexit 0\n`)
      chmodSync(f, 0o755)
    }
    shim("docker", [
      `case "$1" in`,
      `  ps) [ -f "$ST/container" ] && printf 'ntfy-ntfy Up 5 minutes\\n' ;;`,
      `  info) [ -f "$ST/docker-down" ] && exit 1 ;;`,
      `  compose) rm -f "$ST/container" ;;`,
      `  rm) rm -f "$ST/container" ;;`,
      `esac`,
    ].join("\n"))
    shim("launchctl", `:`)
    shim("cloudflared", [
      `case "$1 $2" in`,
      `  "tunnel list")`,
      `    printf 'ID                                   NAME               CREATED              CONNECTIONS\\n'`,
      `    [ -f "$ST/tunnel" ] && printf 'f9e0e69a-8e3c-4d1b-bc5d-96debef45775  ntfy               2025-01-01T00:00:00Z 1xRTT\\n'`,
      `    ;;`,
      `  "tunnel delete") rm -f "$ST/tunnel" ;;`,
      `esac`,
    ].join("\n"))
    shim("tailscale", [
      `case "$1" in`,
      `  status) printf '100.100.100.100 fake-peer\\n' ;;`,
      `  serve)`,
      `    case "$2" in`,
      `      status) [ -f "$ST/serve" ] && printf 'http://127.0.0.1:8080/ (only one serve config can exist)\\n' ;;`,
      `      reset) rm -f "$ST/serve" ;;`,
      `    esac`,
      `    ;;`,
      `esac`,
    ].join("\n"))
    return { d, bin, st, log }
  }
  const shimEnv = (s: { bin: string; st: string; log: string }) => ({
    PATH: `${s.bin}:${process.env.PATH}`,
    SHIM_LOG: s.log,
    ST: s.st,
  })

  await test("--help exits 0 and documents inventory, levels, exit codes", () => {
    const r = runUn(["--help"])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /read-only survey/)
    assert.match(r.stdout, /L1: remove the plugin config entry/)
    assert.match(r.stdout, /Exit codes: 0 ok/)
    assert.match(r.stdout, /NTFY_REMOVE_PATHS/)
  })

  await test("no command → exit 2 with usage hint", () => {
    const r = runUn([])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /command required/)
  })

  await test("unknown command → exit 2", () => {
    const r = runUn(["wat"])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown command/)
  })

  await test("inventory --json: single object, expected component ids, exit 0", () => {
    const r = runUn(["inventory", "--json"])
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one JSON line on stdout")
    const rep = JSON.parse(r.stdout)
    assert.equal(rep.ok, true)
    assert.equal(rep.kind, "inventory")
    const ids: string[] = rep.items.map((i: any) => i.id)
    for (const need of ["config:", "clone-default", "container", "data-dir", "launchagent", "tunnel", "tailscale-serve"]) {
      assert.ok(ids.some((x) => x.startsWith(need)), `inventory missing: ${need}`)
    }
    assert.match(r.stderr, /read-only/)
  })

  await test("L1 removes our tuple entry, preserves foreign entries + sibling keys", () => {
    const f = fixt({
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      plugin: [
        [REPO, { ...ourEntry, customOption: "unrelated-option" }],
        ["/somewhere/other-plugin", { someOpt: 1 }],
      ],
      tail: { deep: true },
    })
    try {
      const r = runUn(["--json", "1"], { NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 0, r.stderr)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      assert.equal(rep.kind, "uninstall")
      assert.equal(rep.level, 1)
      const item = rep.items.find((i: any) => i.id === `config:${f}`)
      assert.equal(item.status, "removed")
      const manual: string[] = rep.items.filter((i: any) => i.status === "manual").map((i: any) => i.id)
      assert.ok(manual.includes("restart"), "restart reminder")
      assert.ok(manual.includes("phone-subscription"), "phone note")
      const back = readJ(f)
      assert.deepEqual(back.plugin, [["/somewhere/other-plugin", { someOpt: 1 }]])
      assert.equal(back.$schema, "https://opencode.ai/config.json")
      assert.equal(back.theme, "dark")
      assert.deepEqual(back.tail, { deep: true })
    } finally {
      unfixt(f)
    }
  })

  await test("L1 on a config without our entry → skipped-already-gone, exit 0", () => {
    const f = fixt({ plugin: [["/somewhere/other-plugin", {}]] })
    try {
      const r = runUn(["--json", "1"], { NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 0)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      assert.equal(rep.items.find((i: any) => i.id === `config:${f}`).status, "skipped-already-gone")
      assert.ok(!rep.items.some((i: any) => i.status === "manual"), "no manual notes when nothing was removed")
      assert.deepEqual(readJ(f).plugin, [["/somewhere/other-plugin", {}]])
    } finally {
      unfixt(f)
    }
  })

  await test("L1 removes the plugins object-form entry too", () => {
    const f = fixt({
      plugins: [
        { package: "opencode-ntfy", options: { ...ourEntry } },
        { package: "other-thing", options: {} },
      ],
    })
    try {
      const r = runUn(["--json", "1"], { NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 0)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.items.find((i: any) => i.id === `config:${f}`).status, "removed")
      const back = readJ(f)
      assert.equal(back.plugins.length, 1)
      assert.equal(back.plugins[0].package, "other-thing")
    } finally {
      unfixt(f)
    }
  })

  await test("stale/moved-path candidates are reported, never guessed (D17c)", () => {
    // (a) only a stale candidate → ambiguous, file untouched
    const fa = fixt({
      plugin: [["/moved/checkout/other-name", { serverUrl: "https://s.example.com", baseTopic: "opencode-bbbbbbbbbb" }]],
    })
    // (b) known entry + stale → ours removed, stale kept, hint in detail
    const fb = fixt({
      plugin: [
        [REPO, { ...ourEntry }],
        ["/moved/checkout/other-name", { serverUrl: "https://s.example.com", baseTopic: "opencode-bbbbbbbbbb" }],
      ],
    })
    try {
      const ra = runUn(["--json", "1"], { NTFY_CONFIG_FILE: fa })
      assert.equal(ra.status, 0)
      const pa = JSON.parse(ra.stdout)
      const ia = pa.items.find((i: any) => i.id === `config:${fa}`)
      assert.equal(ia.status, "skipped-ambiguous")
      assert.match(ia.detail, /NTFY_REMOVE_PATHS/)
      assert.equal(readJ(fa).plugin.length, 1, "stale entry untouched")

      const rb = runUn(["--json", "1"], { NTFY_CONFIG_FILE: fb })
      assert.equal(rb.status, 0)
      const pb = JSON.parse(rb.stdout)
      const ib = pb.items.find((i: any) => i.id === `config:${fb}`)
      assert.equal(ib.status, "removed")
      assert.match(ib.detail, /stale left/)
      const bb = readJ(fb)
      assert.equal(bb.plugin.length, 1)
      assert.equal(bb.plugin[0][0], "/moved/checkout/other-name")
    } finally {
      unfixt(fa)
      unfixt(fb)
    }
  })

  await test("NTFY_REMOVE_PATHS confirms a stale entry (the consent mechanism)", () => {
    const f = fixt({
      plugin: [["/moved/checkout/other-name", { serverUrl: "https://s.example.com", baseTopic: "opencode-bbbbbbbbbb" }]],
    })
    try {
      const r = runUn(["--json", "1"], {
        NTFY_CONFIG_FILE: f,
        NTFY_REMOVE_PATHS: "/moved/checkout/other-name",
      })
      assert.equal(r.status, 0)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.items.find((i: any) => i.id === `config:${f}`).status, "removed")
      assert.deepEqual(readJ(f).plugin, [])
    } finally {
      unfixt(f)
    }
  })

  await test("unparseable config → exit 3, failed item, JSON still emitted, file untouched", () => {
    const f = fixt(null, "{not json at all")
    try {
      const r = runUn(["--json", "1"], { NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 3)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, false)
      const item = rep.items.find((i: any) => i.id === `config:${f}`)
      assert.equal(item.status, "failed")
      assert.match(item.detail, /parse/i)
      assert.equal(readFileSync(f, "utf8"), "{not json at all", "never written on parse failure")
    } finally {
      unfixt(f)
    }
  })

  await test("default scope: L1 finds ~/.config/opencode/opencode.json (fake HOME)", () => {
    assert.ok(!existsSync(path.join(REPO, "opencode.json")), "repo root must not have opencode.json for this test")
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-un-home-"))
    const cfgDir = path.join(home, ".config", "opencode")
    mkdirSync(cfgDir, { recursive: true })
    const f = path.join(cfgDir, "opencode.json")
    writeFileSync(f, JSON.stringify({ plugin: [[REPO, { ...ourEntry }]] }, null, 2) + "\n")
    try {
      const r = runUn(["--json", "1"], { HOME: home })
      assert.equal(r.status, 0, r.stderr)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.items.find((i: any) => i.id === `config:${f}`).status, "removed")
      assert.deepEqual(readJ(f).plugin, [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  await test("real global config is never written by fixture runs (scope rule)", () => {
    const xdg = process.env.XDG_CONFIG_HOME
    const real = path.join(xdg && xdg !== "" ? xdg : path.join(os.homedir(), ".config"), "opencode", "opencode.json")
    if (!existsSync(real)) return // fresh machine: nothing to guard
    const before = readFileSync(real, "utf8")
    const f = fixt({ plugin: [[REPO, { ...ourEntry }]] })
    try {
      const r = runUn(["--json", "1"], { NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(real, "utf8"), before, "NTFY_CONFIG_FILE must replace the scope search")
    } finally {
      unfixt(f)
    }
  })

  // ---- U2: L2/L3 under PATH shims — no live destruction ever (D17d)
  await test("L2 full happy path via shims: infra removed, exact argv, L1 rides along", () => {
    const sh = mkShims()
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l2-home-"))
    const laDir = path.join(home, "Library", "LaunchAgents")
    const plist = path.join(laDir, "com.example.ntfy.plist")
    const dataDir = path.join(home, "ntfy")
    mkdirSync(laDir, { recursive: true })
    writeFileSync(plist, `<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>ntfy</string></dict></plist>\n`)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, "docker-compose.yml"), "services: {}\n")
    writeFileSync(path.join(sh.st, "container"), "")
    writeFileSync(path.join(sh.st, "tunnel"), "")
    writeFileSync(path.join(sh.st, "serve"), "")
    const f = fixt({ plugin: [[REPO, { ...ourEntry }]] })
    try {
      const r = runUn(["--json", "2"], { HOME: home, NTFY_CONFIG_FILE: f, ...shimEnv(sh) })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim().split("\n").length, 1, "single JSON line on stdout")
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      assert.equal(rep.kind, "uninstall")
      assert.equal(rep.level, 2)
      const by = (id: string) => rep.items.find((i: any) => i.id === id)
      assert.equal(by(`config:${f}`).status, "removed")
      assert.equal(by("container").status, "removed")
      assert.match(by("container").detail, /data kept/)
      assert.equal(by("launchagent").status, "removed")
      assert.equal(by("tunnel").status, "removed")
      assert.equal(by("tailscale-serve").status, "removed")
      const manual: string[] = rep.items.filter((i: any) => i.status === "manual").map((i: any) => i.id)
      assert.ok(manual.includes("restart") && manual.includes("phone-subscription"), "L1's notes ride along")
      assert.ok(!existsSync(plist), "plist deleted")
      for (const m of ["container", "tunnel", "serve"]) {
        assert.ok(!existsSync(path.join(sh.st, m)), `marker ${m} consumed`)
      }
      const argv = readFileSync(sh.log, "utf8")
      assert.ok(argv.includes(`docker compose -f ${path.join(dataDir, "docker-compose.yml")} down`), "compose down argv")
      assert.ok(argv.includes("launchctl bootout") && argv.includes(plist), "bootout argv + plist path")
      assert.ok(argv.includes("cloudflared tunnel delete -f ntfy"), "tunnel delete argv (-f: active connections)")
      assert.ok(argv.includes("tailscale serve reset"), "serve reset argv")
      assert.ok(!argv.includes("rm -f ntfy-ntfy"), "compose file existed → no docker rm -f fallback")
    } finally {
      rmSync(sh.d, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L2 idempotent rerun: clean machine → all skipped-already-gone, exit 0, no destructive argv", () => {
    const sh = mkShims()
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l2-home2-"))
    const f = fixt({ plugin: [["/somewhere/other-plugin", {}]] })
    try {
      const r = runUn(["--json", "2"], { HOME: home, NTFY_CONFIG_FILE: f, ...shimEnv(sh) })
      assert.equal(r.status, 0, r.stderr)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      for (const id of ["container", "launchagent", "tunnel", "tailscale-serve"]) {
        assert.equal(rep.items.find((i: any) => i.id === id)?.status, "skipped-already-gone", id)
      }
      assert.equal(rep.items.find((i: any) => i.id === `config:${f}`).status, "skipped-already-gone")
      assert.ok(!rep.items.some((i: any) => i.status === "manual"), "no manual notes when nothing changed")
      const argv = readFileSync(sh.log, "utf8")
      assert.ok(argv.includes("cloudflared tunnel list"), "detection ran")
      assert.ok(!argv.includes("tunnel delete") && !argv.includes("serve reset")
        && !argv.includes("bootout") && !argv.includes("docker compose"), "no teardown on a clean machine")
    } finally {
      rmSync(sh.d, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L2 with docker daemon down → 'manual' with recovery command, never failed, exit 0", () => {
    const sh = mkShims()
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l2-home3-"))
    writeFileSync(path.join(sh.st, "docker-down"), "")
    const f = fixt({ plugin: [["/somewhere/other-plugin", {}]] })
    try {
      const r = runUn(["--json", "2"], { HOME: home, NTFY_CONFIG_FILE: f, ...shimEnv(sh) })
      assert.equal(r.status, 0, r.stderr)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      const it = rep.items.find((i: any) => i.id === "container")
      assert.equal(it.status, "manual", "unverifiable → self-service, not a failure")
      assert.match(it.detail, /docker daemon not running/)
      assert.match(it.detail, /compose/, "prints the exact recovery command")
      assert.ok(!rep.items.some((i: any) => i.status === "failed"))
    } finally {
      rmSync(sh.d, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L3 without --confirm-data → exit 2 before ANY mutation", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l3-home-"))
    const f = fixt({ plugin: [[REPO, { ...ourEntry }]] })
    try {
      const r = runUn(["--json", "3"], { HOME: home, NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /confirm-data/)
      assert.equal(r.stdout.trim(), "", "no JSON on consent refusal")
      assert.equal(readJ(f).plugin.length, 1, "config untouched — refusal precedes L1")
    } finally {
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L3 with mismatched --confirm-data → exit 2, data + config intact", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l3-home2-"))
    const dataDir = path.join(home, "ntfy")
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, "cache.db"), "live db")
    const f = fixt({ plugin: [[REPO, { ...ourEntry }]] })
    try {
      const r = runUn(["--json", "3", `--confirm-data=${path.join(home, "wrong")}`], { HOME: home, NTFY_CONFIG_FILE: f })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /byte-for-byte/)
      assert.ok(existsSync(path.join(dataDir, "cache.db")), "data intact")
      assert.equal(readJ(f).plugin.length, 1, "config untouched")
    } finally {
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L3 with exact consent → wipes data + default clone; repo NEVER deleted (D17c)", () => {
    const sh = mkShims()
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l3-home3-"))
    const dataDir = path.join(home, "ntfy")
    const clone = path.join(home, ".local", "share", "opencode-ntfy")
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, "cache.db"), "live db")
    mkdirSync(path.join(clone, "src"), { recursive: true })
    writeFileSync(path.join(clone, "src", "index.ts"), "// plugin\n")
    const f = fixt({ plugin: [[REPO, { ...ourEntry }]] })
    try {
      const r = runUn(["--json", "3", `--confirm-data=${dataDir}`], { HOME: home, NTFY_CONFIG_FILE: f, ...shimEnv(sh) })
      assert.equal(r.status, 0, r.stderr)
      const rep = JSON.parse(r.stdout)
      assert.equal(rep.ok, true)
      assert.equal(rep.level, 3)
      const by = (id: string) => rep.items.find((i: any) => i.id === id)
      assert.equal(by("data-dir").status, "removed")
      assert.equal(by("clone-default").status, "removed")
      assert.ok(!existsSync(dataDir), "data dir wiped")
      assert.ok(!existsSync(clone), "default clone wiped")
      assert.ok(existsSync(REPO), "the checkout we run from is NEVER deleted")
      const pd = by("plugin-dir")
      assert.equal(pd.status, "manual", "custom/checkout plugin dir → self-service")
      assert.ok(pd.detail.includes(REPO), "names the path it left alone")
      assert.equal(by("dns-route").status, "manual")
      assert.equal(by(`config:${f}`).status, "removed", "L1 ran first")
      assert.ok(!rep.items.some((i: any) => i.status === "failed"))
    } finally {
      rmSync(sh.d, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      unfixt(f)
    }
  })

  await test("L3 path sanity refuses '/' and $HOME even WITH byte-exact consent", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ntfy-l3-home4-"))
    try {
      const ra = runUn(["--json", "3", "--confirm-data=/"], { NTFY_SETUP_DIR: "/", HOME: home })
      assert.equal(ra.status, 2)
      assert.match(ra.stderr, /refusing to wipe/)
      const rb = runUn(["--json", "3", `--confirm-data=${home}`], { NTFY_SETUP_DIR: home, HOME: home })
      assert.equal(rb.status, 2)
      assert.match(rb.stderr, /refusing to wipe/)
      assert.ok(existsSync(home), "home untouched")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  await test("UNINSTALL.md documents the full uninstall contract (drift guard)", () => {
    const md = readFileSync(fileURLToPath(new URL("../UNINSTALL.md", import.meta.url)), "utf8")
    for (const s of [
      "scripts/uninstall.sh", "--json inventory", "--confirm-data=", "DELETE",
      "byte-for-byte", "NTFY_REMOVE_PATHS", "NTFY_CONFIG_FILE", "NTFY_SETUP_DIR",
      "NTFY_PLUGIN_DIR", "Exit codes", "skipped-already-gone", "manual",
      "ambiguous", "pkill", "data kept", "irreversible",
      "setup-server.sh",                    // L2 keeps data → re-provision path
      // dogfood-defect guards: stale signal lives in detail, env is set once,
      // exit-2 has no JSON, node prerequisite + exit 5, reformat honesty
      "stale:", "set them once", "Prerequisites:", "internal failure",
      "no JSON on stdout", "XDG_CONFIG_HOME", "plugin dir", "sibling keys",
      // Step 3's verify checks (SPEC §15.2 D17b)
      "re-read config", "docker ps", "launchctl", "tunnel list", "serve status",
      // Step 4 table must stay byte-identical to SPEC §15.3 (incl. U3 rows)
      "config entry ......... removed from", "data dir ............. removed",
      "clone dir ............ removed", "container ............ compose down",
      "LaunchAgent .......... booted out", "cloudflared tunnel ... deleted",
      "tailscale serve ...... reset", "dns route ............ MANUAL",
      "phone subscription ... MANUAL", "OpenCode ............. restart once",
    ]) assert.ok(md.includes(s), `UNINSTALL.md missing: ${s}`)
    // inventory-first: the read-only survey must precede any execution (D17c)
    assert.ok(md.indexOf("--json inventory") < md.indexOf("--json 1"), "inventory must come before execute")
    // a `#` comment after a `\` continuation silently drops the rest of a pasted command
    assert.ok(!/^[^\n]*\\[ \t]+#/m.test(md), "UNINSTALL.md: comment after line-continuation backslash")
  })

  console.log("")
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED: ${failures.join(", ")}`)
    process.exitCode = 1
  } else {
    console.log(`all ${passed} tests passed`)
  }
}

await main()
