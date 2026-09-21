/**
 * Test suite: classify heuristics, config/token resolution, and an end-to-end
 * event→publish flow against a fake ntfy server. Run: npm test
 */

import assert from "node:assert/strict"
import { classify, excerpt, preprocess } from "../src/classify"
import { readConfig, type StorageLike } from "../src/config"
import { watchEvents, type EventsDeps } from "../src/events"
import { Notifier, type FetchLike } from "../src/publish"
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
    { type: "session.tool.failed", data: { sessionID: "tools", error: { type: "tool", message: "ECONNRESET" } } },
    { type: "session.tool.failed", data: { sessionID: "tools", error: { type: "tool", message: "ECONNRESET" } } },
    { type: "session.tool.failed", data: { sessionID: "tools", error: { type: "tool", message: "ECONNRESET" } } },
    // Form question.
    { type: "form.created", data: { form: { id: "f1", sessionID: "done", title: "Which database?" } } },
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
    const generated = first.config!.topics.question.replace(/-question$/, "")
    assert.match(generated, /^opencode-[a-f0-9]{10}$/)
    const second = await readConfig({ serverUrl: "http://t" }, storage)
    assert.equal(second.config!.topics.question, `${generated}-question`)
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
    assert.equal(res.config!.topics.custom, "bt-custom")
  })
  await test("startup info lists subscribe topics", async () => {
    const res = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    assert.ok(res.info.some((l) => l.includes("bt-question")))
  })

  console.log("events → publish (end-to-end)")
  const { fetcher, config, notifier } = await runMainFlow()
  const byKind = (titlePrefix: string) => fetcher.sent.filter((s) => s.body.title?.startsWith(titlePrefix))

  await test("permission.asked → question publish (urgent, right topic, bearer auth)", () => {
    const q = byKind("Permission needed:")
    assert.equal(q.length, 1)
    assert.equal(q[0].body.topic, "opencode-test-question")
    assert.equal(q[0].body.priority, 5)
    assert.match(q[0].body.message, /shell.*npm test/)
    assert.equal((q[0].headers as any).Authorization, undefined)
  })
  await test("finished suppressed when question fired within window (session ask)", () => {
    assert.equal(byKind("Finished: Fix login bug").length, 0)
  })
  await test("plain completion → finished publish (default priority)", () => {
    const f = byKind("Finished: Add dark mode")
    assert.equal(f.length, 1)
    assert.equal(f[0].body.topic, "opencode-test-finished")
    assert.equal(f[0].body.priority, 3)
    assert.match(f[0].body.message, /dark mode shipped/)
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
    assert.equal(e[0].body.topic, "opencode-test-error")
    assert.equal(e[0].body.priority, 4)
    assert.match(e[0].body.message, /Model overloaded/)
    assert.equal(byKind("Finished: Risky task").length, 0)
  })
  await test("tool error cooldown: 1st fires, 2nd suppressed, 3rd after cooldown carries count", async () => {
    const e = byKind("Error: Flaky suite")
    assert.equal(e.length, 1)
    assert.match(e[0].body.message, /ECONNRESET/)
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
    assert.equal(q[0].body.topic, "opencode-test-question")
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
    // Recover: same topic as the earlier failure (bt-question) now succeeds.
    fetcher.mode = "ok"
    const recovery = await captureLogs(async () => {
      notifier.notify("question", "s2", { title: "D", message: "m" })
      await flush()
    })
    assert.equal(recovery.filter((l) => l.includes("recovered")).length, 1)
  })
  await test("transport failures rate-limited per (topic, class)", async () => {
    const { config: cfg } = await readConfig({ serverUrl: "http://t", baseTopic: "bt" }, fakeStorage())
    const fetcher = fakeFetch()
    fetcher.mode = "throw"
    const notifier = new Notifier(cfg!, fetcher as FetchLike)
    const lines = await captureLogs(async () => {
      // Two failures on the SAME topic (question) → rate-limited to 1 line…
      notifier.notify("question", "s1", { title: "A", message: "m" })
      notifier.notify("question", "s2", { title: "B", message: "m" })
      // …while a different topic logs its own first failure.
      notifier.notify("error", "s3", { title: "C", message: "m" })
      await flush()
    })
    const eLines = lines.filter((l) => l.includes("ECONNREFUSED"))
    assert.equal(eLines.length, 2, `expected 2 (one per topic), got: ${JSON.stringify(lines)}`)
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
    assert.equal(fetcher.sent[0].body.topic, "bt-custom")
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

  console.log("")
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED: ${failures.join(", ")}`)
    process.exitCode = 1
  } else {
    console.log(`all ${passed} tests passed`)
  }
}

await main()
