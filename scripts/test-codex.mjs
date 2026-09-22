import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "nudge-codex-"))
const hooks = join(dir, "hooks.json")
const config = join(dir, "nudge.json")
const adapter = join(root, "scripts/codex-hook.mjs")
writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }))
const setup = () => spawnSync(process.execPath, [join(root, "scripts/configure-codex.mjs"), hooks, config, adapter, "nudge-test"], {
  encoding: "utf8", env: { ...process.env, NTFY_W: "https://example.com|test-token|nudge-test|1|" },
})
assert.equal(setup().status, 0)
assert.equal(setup().status, 0)
const saved = JSON.parse(readFileSync(hooks, "utf8"))
assert.equal(saved.hooks.Stop.length, 2)
assert.equal(saved.hooks.PermissionRequest.length, 1)
assert.equal(saved.hooks.Stop[0].hooks[0].command, "echo existing")
assert.equal(statSync(config).mode & 0o777, 0o600)
assert.equal(JSON.parse(readFileSync(config, "utf8")).topic, "nudge-test")

// One runnable delivery check: mock fetch and invoke the real hook process.
const mock = join(dir, "mock-fetch.mjs")
const out = join(dir, "sent.json")
writeFileSync(mock, `import { writeFileSync } from "node:fs";
globalThis.fetch = async (_url, options) => { writeFileSync(process.env.NUDGE_TEST_OUT, JSON.stringify({ url: _url, ...options, signal: undefined })); return { ok: true }; };
`)
const invoke = (event) => spawnSync(process.execPath, ["--import", mock, adapter, config], {
  encoding: "utf8", input: JSON.stringify(event), env: { ...process.env, NUDGE_TEST_OUT: out },
})
assert.equal(invoke({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { description: "Run tests" } }).status, 0)
let sent = JSON.parse(readFileSync(out, "utf8"))
assert.equal(sent.headers.Authorization, "Bearer test-token")
assert.equal(JSON.parse(sent.body).priority, 5)
assert.equal(JSON.parse(sent.body).topic, "nudge-test")
assert.equal(invoke({ hook_event_name: "Stop", last_assistant_message: "All done." }).stdout, "{}\n")
sent = JSON.parse(readFileSync(out, "utf8"))
assert.equal(JSON.parse(sent.body).title, "Codex: Finished")
assert.equal(invoke({ hook_event_name: "Stop", last_assistant_message: "Should I deploy?" }).status, 0)
sent = JSON.parse(readFileSync(out, "utf8"))
assert.equal(JSON.parse(sent.body).title, "Codex: Question")
const remove = spawnSync("bash", [join(root, "scripts/uninstall.sh"), "--json", "1"], {
  encoding: "utf8", env: { ...process.env, HOME: dir, CODEX_HOME: dir, NTFY_CONFIG_FILE: join(dir, "opencode.json") },
})
assert.equal(remove.status, 0)
assert.ok(JSON.parse(remove.stdout).items.some((item) => item.id === `codex:${hooks}` && item.status === "removed"))
assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop[0].hooks[0].command, "echo existing")
assert.equal(existsSync(config), false)
console.log("Codex hooks: config preservation, idempotency, delivery, classification, removal OK")
