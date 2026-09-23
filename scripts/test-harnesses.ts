import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import commandCode from "../adapters/command-code"
import piExtension from "../adapters/pi"

const root = resolve(import.meta.dirname, "..")
const temp = mkdtempSync(join(tmpdir(), "ntfy-harness-test-"))
const home = join(temp, "home")
const project = join(temp, "project")
const events: any[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (_url: string, init: any) => {
  events.push(JSON.parse(init.body))
  return { ok: true, status: 200 } as Response
}) as typeof fetch

try {
  const install = spawnSync(process.execPath, [join(root, "scripts/install-harnesses.mjs"), root, "project", "command-code,pi,hermes"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NTFY_PROJECT_DIR: project, NTFY_SERVER_URL: "http://ntfy.example", NTFY_TOKEN: "test-token", NTFY_TOPIC: "test-topic", NTFY_EVENTS: "all" },
  })
  assert.equal(install.status, 0, install.stderr)
  assert.ok(existsSync(join(project, ".commandcode/mods/ntfy.ts")))
  assert.ok(existsSync(join(project, ".pi/extensions/ntfy.ts")))
  assert.ok(existsSync(join(home, ".hermes/plugins/ntfy/plugin.yaml")))
  assert.match(readFileSync(join(home, ".hermes/config.yaml"), "utf8"), /enabled:[\s\S]*ntfy/)
  const configPath = install.stdout.trim().split("\n").at(-1)!.slice("config: ".length)
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).baseTopic, "test-topic")
  const rerun = spawnSync(process.execPath, [join(root, "scripts/install-harnesses.mjs"), root, "project", "command-code,pi"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NTFY_PROJECT_DIR: project, NTFY_SERVER_URL: "http://ntfy.example", NTFY_TOKEN: "test-token", NTFY_TOPIC: "new-topic", NTFY_EVENTS: "all" },
  })
  assert.equal(rerun.status, 0, rerun.stderr)
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).baseTopic, "test-topic", "rerun keeps the phone topic")
  const moved = spawnSync(process.execPath, [join(root, "scripts/install-harnesses.mjs"), root, "project", "command-code,pi"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NTFY_PROJECT_DIR: project, NTFY_SERVER_URL: "http://ntfy.example", NTFY_TOKEN: "test-token", NTFY_TOPIC: "nudge-new", NTFY_FORCE_TOPIC: "1", NTFY_EVENTS: "all" },
  })
  assert.equal(moved.status, 0, moved.stderr)
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).baseTopic, "nudge-new", "explicit topic moves the subscription")

  const global = spawnSync(process.execPath, [join(root, "scripts/install-harnesses.mjs"), root, "global", "command-code,pi"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NTFY_SERVER_URL: "http://ntfy.example", NTFY_TOKEN: "test-token", NTFY_TOPIC: "global-topic", NTFY_EVENTS: "all" },
  })
  assert.equal(global.status, 0, global.stderr)
  assert.ok(existsSync(join(home, ".commandcode/mods/ntfy.ts")))
  assert.ok(existsSync(join(home, ".pi/agent/extensions/ntfy.ts")))

  process.env.NTFY_CONFIG_FILE = configPath
  const cmdHandlers = new Map<string, (event: any) => void>()
  let commandTool: any
  await commandCode({ cwd: project, on: (name: string, fn: any) => cmdHandlers.set(name, fn), hooks: (hooks: any) => { cmdHandlers.set("run_end", hooks.onRunEnd); cmdHandlers.set("before_tool_call", hooks.beforeToolCall) }, addTool: (tool: any) => { commandTool = tool } })
  await cmdHandlers.get("run_end")!({ result: { stopReason: "end_turn", finalText: "Done." } })
  await cmdHandlers.get("run_end")!({ result: { stopReason: "interrupted", finalText: "Stopped." } })
  await cmdHandlers.get("before_tool_call")!({ toolName: "shell_command", input: {} })
  await cmdHandlers.get("before_tool_call")!({ toolName: "ask_user_question", input: { questions: [{ question: "Choose a database", options: [{ label: "SQLite" }] }] } })
  cmdHandlers.get("tool_denied")!({ toolName: "shell" })
  await commandTool.run({ input: { message: "custom" } })

  const piHandlers = new Map<string, (event: any, ctx: any) => any>()
  let piTool: any
  piExtension({ on: (name: string, fn: any) => piHandlers.set(name, fn), registerTool: (tool: any) => { piTool = tool } })
  await piHandlers.get("session_start")!({}, { cwd: project })
  piHandlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Need input?" }] } }, {})
  await piHandlers.get("agent_settled")!({}, {})
  await piTool.execute("id", { message: "pi custom" })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(events.map((e) => e.title), ["Finished: Command Code · project", "Question: Command Code · project", "Permission denied: Command Code · project", "ntfy", "Question: Pi · project", "ntfy"])
  assert.equal(events[1].message, "Choose a database")
  assert.ok(events.every((e) => e.topic === "nudge-new"))

  const py = spawnSync("python3", ["-c", `import importlib.util, json
spec=importlib.util.spec_from_file_location('ntfy_hermes', ${JSON.stringify(join(root, "adapters/hermes/__init__.py"))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class C:
 def __init__(self): self.hooks={}; self.tools={}
 def register_hook(self, name, fn): self.hooks[name]=fn
 def register_tool(self, **kw): self.tools[kw['name']]=kw['handler']
c=C(); m.register(c)
assert {'post_llm_call','post_tool_call','pre_approval_request','on_session_end'} <= c.hooks.keys()
assert 'ntfy_notify' in c.tools
print('Hermes plugin registration ok')`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })
  assert.equal(py.status, 0, py.stderr)
  console.log("all harness adapter checks passed")
} finally {
  globalThis.fetch = originalFetch
  delete process.env.NTFY_CONFIG_FILE
  rmSync(temp, { recursive: true, force: true })
}
