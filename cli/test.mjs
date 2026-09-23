/*
 * nudge-agent CLI contract tests.
 *
 * Every test runs against a throwaway HOME, a fixture opencode config and PATH
 * shims for docker/launchctl/cloudflared/tailscale, so nothing here reads or
 * writes the real machine's config, container or tunnel.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./nudge-agent.mjs", import.meta.url))
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)))

const OUR_ENTRY = {
  serverUrl: "http://192.168.0.24",
  token: "tk_fixture0000000000000000000",
  baseTopic: "nudge-fixture",
}

let passed = 0
const failures = []
const test = (name, fn) => {
  try {
    fn()
    console.log(`  ok - ${name}`)
    passed++
  } catch (error) {
    console.error(`  FAIL - ${name}\n    ${error.message}`)
    failures.push(name)
  }
}

/* ---------------------------------------------------------------- fixtures */

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const withHome = (fn) => {
  const home = tmp("nudge-cli-home-")
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// A CLI copy outside any plugin checkout, so pluginDir()'s "checkout containing
// this CLI" fallback cannot match — i.e. how an npm or brew install looks.
const withDetachedCli = (fn) => {
  const dir = tmp("nudge-cli-copy-")
  try {
    const copy = join(dir, "nudge-agent.mjs")
    copyFileSync(CLI, copy)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }))
    return fn(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fixtureConfig = (home, config) => {
  const file = join(home, ".config/opencode/opencode.json")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return file
}

const readJsonFile = (file) => JSON.parse(readFileSync(file, "utf8"))

// docker/cloudflared/launchctl/tailscale are shimmed so inventory is fast and
// deterministic, and so no test can touch the real container or tunnel.
const shims = () => {
  const dir = tmp("nudge-cli-bin-")
  const shim = (name, body) => {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${body}\nexit 0\n`)
    chmodSync(file, 0o755)
  }
  shim("docker", `case "$1" in info) exit 0 ;; ps) : ;; esac`)
  shim("launchctl", ":")
  shim("cloudflared", `case "$1 $2" in "tunnel list") printf 'ID NAME CREATED CONNECTIONS\\n' ;; esac`)
  shim("tailscale", "exit 1")
  shim("hermes", ":")
  shim("npm", ":")
  return dir
}
const SHIMS = shims()

const baseEnv = (home) => ({
  ...process.env,
  HOME: home,
  PATH: `${SHIMS}:${process.env.PATH}`,
  NTFY_PLUGIN_DIR: REPO,
  NTFY_SETUP_DIR: join(home, "ntfy"),
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: "",
  NTFY_CONFIG_FILE: "",
  NTFY_REMOVE_PATHS: "",
})

const runCli = (args, home, env = {}, cli = CLI) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: home, env: { ...baseEnv(home), ...env }, timeout: 30000 })

/* ---------------------------------------------------------------- tests */

console.log("nudge-agent (CLI surface)")

test("--help exits 0 and documents every command", () =>
  withHome((home) => {
    const r = runCli(["--help"], home)
    assert.equal(r.status, 0)
    for (const command of ["install", "status", "update", "add", "remove", "uninstall"]) {
      assert.ok(r.stdout.includes(command), `help should mention ${command}`)
    }
    assert.match(r.stdout, /Exit codes: 0 ok/)
  }))

test("--version prints the CLI version", () =>
  withHome((home) => {
    const r = runCli(["--version"], home)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^nudge-agent \d+\.\d+\.\d+/)
  }))

test("no arguments prints usage and exits 0", () =>
  withHome((home) => {
    const r = runCli([], home)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /nudge-agent — manage a Nudge install/)
  }))

test("unknown command → exit 2 with a pointer to --help", () =>
  withHome((home) => {
    const r = runCli(["frobnicate"], home)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown command: frobnicate/)
  }))

test("status --json: single JSON object, harnesses absent when nothing is wired", () =>
  withHome((home) => {
    fixtureConfig(home, { plugin: ["some-other-plugin"] })
    const r = runCli(["status", "--json"], home)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout) // throws if any human text leaked to stdout
    assert.equal(out.ok, true)
    assert.equal(out.kind, "status")
    assert.equal(out.harnesses.opencode.present, false)
    assert.equal(out.harnesses.codex.present, false)
    for (const name of ["command-code", "pi", "hermes"]) assert.equal(out.harnesses[name].present, false)
    assert.equal(out.plugin.dir, REPO)
    assert.equal(out.plugin.kind, "checkout")
  }))

test("status --json: reports the opencode entry and its enabled events", () =>
  withHome((home) => {
    fixtureConfig(home, {
      plugin: [["some-other-plugin"], [REPO, { ...OUR_ENTRY, events: { error: { enabled: false } } }]],
    })
    const r = runCli(["status", "--json"], home)
    const out = JSON.parse(r.stdout)
    assert.equal(out.harnesses.opencode.present, true)
    assert.equal(out.harnesses.opencode.entry, REPO)
    assert.equal(out.topic, "nudge-fixture")
    assert.deepEqual(out.harnesses.opencode.events, ["question", "permission", "finished", "custom"])
  }))

test("status human output names both harnesses", () =>
  withHome((home) => {
    fixtureConfig(home, { plugin: [[REPO, OUR_ENTRY]] })
    const r = runCli(["status"], home)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /opencode ✓ .*opencode\.json/)
    assert.match(r.stdout, /codex {4}not wired/)
  }))

test("status --json: no plugin anywhere → plugin null", () =>
  withHome((home) => {
    withDetachedCli((cli) => {
      const r = runCli(["status", "--json"], home, { NTFY_PLUGIN_DIR: "" }, cli)
      assert.equal(r.status, 0)
      assert.equal(JSON.parse(r.stdout).plugin, null)
      const human = runCli(["status"], home, { NTFY_PLUGIN_DIR: "" }, cli)
      assert.equal(human.status, 1)
      assert.match(human.stdout, /not installed/)
    })
  }))

test("update on a machine with no install → exit 3", () =>
  withHome((home) => {
    withDetachedCli((cli) => {
      const r = runCli(["update"], home, { NTFY_PLUGIN_DIR: "" }, cli)
      assert.equal(r.status, 3)
      assert.match(r.stderr, /not installed/)
    })
  }))

test("update --dry-run prints the plan and changes nothing", () =>
  withHome((home) => {
    const r = runCli(["update", "--dry-run"], home)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /git -C .* pull --ff-only/)
  }))

// An archive install: the plugin dir exists but is not a git checkout, so update
// must re-run the installer rather than git pull. The default source is GitHub —
// the website is not deployed, so a site URL here would be unreachable.
const fakeArchivePlugin = () => {
  const dir = tmp("nudge-cli-plugin-")
  for (const entry of ["scripts", "src", "adapters"]) cpSync(join(REPO, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, "index.ts"), "export {}\n")
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "opencode-ntfy", version: "0.0.9" })}\n`)
  return dir
}

test("update --dry-run on an archive install plans the GitHub source", () =>
  withHome((home) => {
    const plugin = fakeArchivePlugin()
    try {
      const r = runCli(["update", "--dry-run"], home, { NTFY_PLUGIN_DIR: plugin })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /raw\.githubusercontent\.com\/tomfc23\/nudge\/main\/install\.sh/)
      assert.match(r.stdout, /NTFY_REPO_URL=https:\/\/github\.com\/tomfc23\/nudge/, "must clone the repo, not fetch a dead site")
      assert.doesNotMatch(r.stdout, /NTFY_SITE_URL=/)
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  }))

test("update --dry-run keeps an explicit NTFY_SITE_URL (website archive installs)", () =>
  withHome((home) => {
    const plugin = fakeArchivePlugin()
    try {
      const r = runCli(["update", "--dry-run"], home, { NTFY_PLUGIN_DIR: plugin, NTFY_SITE_URL: "https://example.test" })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /NTFY_SITE_URL=https:\/\/example\.test/)
      assert.doesNotMatch(r.stdout, /NTFY_REPO_URL=/)
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  }))

test("installer replaces an existing archive before running its preflight", () =>
  withHome((home) => {
    const source = join(home, "source")
    const installed = join(home, "installed")
    const downloaded = join(home, "install.sh")
    mkdirSync(join(source, "src"), { recursive: true })
    mkdirSync(join(source, "scripts"), { recursive: true })
    mkdirSync(join(installed, "scripts"), { recursive: true })
    writeFileSync(join(source, "src/index.ts"), "export {}\n")
    writeFileSync(join(source, "scripts/setup-server.sh"), "#!/bin/sh\nprintf '{\"checks\":[]}\\n'\nexit 3\n")
    writeFileSync(join(source, "scripts/install-harnesses.mjs"), "")
    writeFileSync(join(source, "scripts/configure-opencode.mjs"), "")
    writeFileSync(join(source, "package-lock.json"), "{}")
    writeFileSync(join(installed, "scripts/setup-server.sh"), "old archive")
    copyFileSync(join(REPO, "install.sh"), downloaded)
    assert.equal(spawnSync("git", ["init", "-q", source]).status, 0)
    assert.equal(spawnSync("git", ["-C", source, "add", "."]).status, 0)
    assert.equal(spawnSync("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"]).status, 0)
    const env = {
      ...baseEnv(home), NTFY_REPO_URL: source, NTFY_PLUGIN_DIR: installed,
      NTFY_MODE: "local", LAN_IP: "192.168.1.5", NTFY_HARNESSES: "pi",
      NTFY_SCOPE: "global", NTFY_EVENTS: "all", NTFY_PHONE: "none",
      NTFY_INSTALL_DEPS: "0", NTFY_SKIP_CONFIRM: "1",
    }
    const result = spawnSync("bash", [downloaded], { cwd: home, env, encoding: "utf8", timeout: 30000 })
    assert.notEqual(result.status, 0, "fixture preflight stops the installer")
    assert.equal(readFileSync(join(installed, "src/index.ts"), "utf8"), "export {}\n")
    assert.equal(existsSync(join(installed, "scripts/install-harnesses.mjs")), true)
    assert.equal(existsSync(join(installed, "scripts/setup-server.sh")), true)
  }))

test("install: unreachable source → exit 3, nothing executed", () =>
  withHome((home) => {
    const r = runCli(["install"], home, { NTFY_INSTALL_URL: "http://127.0.0.1:9/install.sh" })
    assert.equal(r.status, 3)
    assert.match(r.stderr, /could not download/)
  }))

// A checkout whose git pull cannot succeed — the case a rewritten upstream left
// users in, where git's own "fatal: Not possible to fast-forward" was the whole
// answer. The CLI must name the way out and exit 4 (conflict), not 1.
const fakeUnpullablePlugin = () => {
  const dir = fakeArchivePlugin()
  // Real checkouts always carry the lockfile — update reads it before pulling.
  writeFileSync(join(dir, "package-lock.json"), "{}\n")
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("remote", "add", "origin", "http://127.0.0.1:9/nudge.git")
  return dir
}

test("update: an unpullable checkout gets a remedy, not a bare fatal", () =>
  withHome((home) => {
    const plugin = fakeUnpullablePlugin()
    try {
      const r = runCli(["update"], home, { NTFY_PLUGIN_DIR: plugin, GIT_TERMINAL_PROMPT: "0" })
      assert.equal(r.status, 4, `expected exit 4, got ${r.status}\n${r.stdout}${r.stderr}`)
      assert.match(r.stdout, /could not fast-forward/)
      assert.match(r.stdout, /git -C .* fetch origin && git -C .* reset --hard origin\/main/)
      assert.match(r.stdout, /what differs/)
      assert.doesNotMatch(r.stdout, /already current/, "must not claim success after a failed pull")
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  }))

console.log("nudge-agent (add / remove)")

const wireOpencode = (home) => fixtureConfig(home, { plugin: [[REPO, OUR_ENTRY]] })

test("add codex copies serverUrl/token/topic from the wired opencode entry", () =>
  withHome((home) => {
    wireOpencode(home)
    const r = runCli(["add", "codex"], home)
    assert.equal(r.status, 0, r.stderr)

    const config = readJsonFile(join(home, ".codex/nudge.json"))
    assert.equal(config.serverUrl, OUR_ENTRY.serverUrl)
    assert.equal(config.token, OUR_ENTRY.token)
    assert.equal(config.topic, OUR_ENTRY.baseTopic)
    assert.deepEqual(config.events, { question: true, permission: true, finished: true })

    const hooks = readJsonFile(join(home, ".codex/hooks.json"))
    for (const event of ["Stop", "PermissionRequest"]) {
      const commands = hooks.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command))
      assert.equal(commands.length, 1, `${event} should carry exactly our hook`)
      assert.match(commands[0], /codex-hook\.mjs/)
    }
    assert.match(r.stdout, /trust Nudge's two hooks/, "must warn that untrusted hooks never fire")
  }))

test("add codex is idempotent (no duplicate hooks on a second run)", () =>
  withHome((home) => {
    wireOpencode(home)
    runCli(["add", "codex"], home)
    const second = runCli(["add", "codex"], home)
    assert.equal(second.status, 0)
    assert.match(second.stdout, /already wired/)
    assert.equal(readJsonFile(join(home, ".codex/hooks.json")).hooks.Stop.flatMap((g) => g.hooks).length, 1)
  }))

test("status --json reports codex hooks and how many are trusted", () =>
  withHome((home) => {
    wireOpencode(home)
    runCli(["add", "codex"], home)

    const untrusted = JSON.parse(runCli(["status", "--json"], home).stdout)
    assert.equal(untrusted.harnesses.codex.present, true)
    assert.equal(untrusted.harnesses.codex.hooks, 2)
    assert.equal(untrusted.harnesses.codex.trusted, 0)

    // Trust is recorded per hook position in the global Codex config.toml.
    const hooksFile = join(home, ".codex/hooks.json")
    mkdirSync(join(home, ".codex"), { recursive: true })
    writeFileSync(
      join(home, ".codex/config.toml"),
      [
        `[hooks.state."${hooksFile}:stop:0:0"]`,
        'trusted_hash = "sha256:aaa"',
        `[hooks.state."${hooksFile}:permission_request:0:0"]`,
        'trusted_hash = "sha256:bbb"',
      ].join("\n"),
    )
    const trusted = JSON.parse(runCli(["status", "--json"], home).stdout)
    assert.equal(trusted.harnesses.codex.trusted, 2)
  }))

test("add with no harness wired → exit 3 (nothing to copy settings from)", () =>
  withHome((home) => {
    fixtureConfig(home, { plugin: ["some-other-plugin"] })
    const r = runCli(["add", "codex"], home)
    assert.equal(r.status, 3)
    assert.match(r.stderr, /nothing to copy/)
  }))

test("add rejects a missing or unknown harness", () =>
  withHome((home) => {
    wireOpencode(home)
    assert.equal(runCli(["add"], home).status, 2)
    assert.match(runCli(["add", "unknown"], home).stderr, /add needs a harness/)
  }))

test("add, status, and remove support Command Code, Pi, and Hermes", () =>
  withHome((home) => {
    wireOpencode(home)
    for (const name of ["command-code", "pi", "hermes"]) {
      const added = runCli(["add", name, "--global"], home)
      assert.equal(added.status, 0, `${name}: ${added.stderr}`)
      assert.equal(runCli(["add", name, "--global"], home).status, 0, "add is idempotent")
    }
    const shared = readJsonFile(join(home, ".config/ntfy-archive/config.json"))
    assert.equal(shared.baseTopic, OUR_ENTRY.baseTopic)
    assert.equal(shared.token, OUR_ENTRY.token)
    const status = JSON.parse(runCli(["status", "--json"], home).stdout)
    for (const name of ["command-code", "pi", "hermes"]) assert.equal(status.harnesses[name].present, true)
    assert.ok(status.inventory.some((item) => item.id.startsWith("shared-config:") && item.status === "present"))
    for (const name of ["command-code", "pi", "hermes"]) {
      const removed = runCli(["remove", name, "--json"], home)
      assert.equal(removed.status, 0, `${name}: ${removed.stderr}`)
      assert.equal(JSON.parse(removed.stdout).removed.length, 1)
    }
    const after = JSON.parse(runCli(["status", "--json"], home).stdout)
    for (const name of ["command-code", "pi", "hermes"]) assert.equal(after.harnesses[name].present, false)
    assert.equal(after.harnesses.opencode.present, true)
  }))

test("a standalone-only install supplies settings and survives update detection", () =>
  withHome((home) => {
    const plugin = fakeArchivePlugin()
    try {
      const shared = join(home, ".config/ntfy-archive/config.json")
      mkdirSync(dirname(shared), { recursive: true })
      writeFileSync(shared, JSON.stringify({ serverUrl: OUR_ENTRY.serverUrl, token: OUR_ENTRY.token, baseTopic: OUR_ENTRY.baseTopic, events: {} }))
      const loader = join(home, ".pi/agent/extensions/ntfy.ts")
      mkdirSync(dirname(loader), { recursive: true })
      writeFileSync(loader, `export { default } from ${JSON.stringify(join(plugin, "adapters/pi.ts"))}\n`)
      const env = { NTFY_PLUGIN_DIR: "" }
      const status = JSON.parse(runCli(["status", "--json"], home, env).stdout)
      assert.equal(status.topic, OUR_ENTRY.baseTopic)
      assert.equal(status.harnesses.pi.present, true)
      const update = runCli(["update", "--dry-run"], home, env)
      assert.equal(update.status, 0, update.stderr)
      assert.match(update.stdout, /NTFY_HARNESSES=pi/)
      const add = runCli(["add", "command-code", "--global"], home, env)
      assert.equal(add.status, 0, add.stderr)
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  }))

test("remove codex strips the hooks and leaves opencode alone", () =>
  withHome((home) => {
    const config = wireOpencode(home)
    runCli(["add", "codex"], home)
    const r = runCli(["remove", "codex"], home)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /codex {4}✓/)
    assert.equal(existsSync(join(home, ".codex/nudge.json")), false)
    assert.deepEqual(readJsonFile(join(home, ".codex/hooks.json")).hooks.Stop, [], "our hooks are gone")
    assert.equal(readJsonFile(config).plugin.length, 1, "opencode entry untouched")
  }))

test("remove opencode strips only our entry and leaves codex alone", () =>
  withHome((home) => {
    const config = wireOpencode(home)
    runCli(["add", "codex"], home)
    const r = runCli(["remove", "opencode"], home)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readJsonFile(config).plugin, [], "our entry removed")
    assert.match(readJsonFile(join(home, ".codex/hooks.json")).hooks.Stop[0].hooks[0].command, /codex-hook\.mjs/)

    const after = JSON.parse(runCli(["status", "--json"], home).stdout)
    assert.equal(after.harnesses.opencode.present, false)
    assert.equal(after.harnesses.codex.present, true)
  }))

test("remove keeps a foreign plugin entry", () =>
  withHome((home) => {
    const config = fixtureConfig(home, { plugin: ["foreign-plugin", [REPO, OUR_ENTRY]] })
    assert.equal(runCli(["remove", "opencode"], home).status, 0)
    assert.deepEqual(readJsonFile(config).plugin, ["foreign-plugin"])
  }))

test("add opencode copies settings back from a codex-only install", () =>
  withHome((home) => {
    fixtureConfig(home, { plugin: ["foreign-plugin"] })
    mkdirSync(join(home, ".codex"), { recursive: true })
    writeFileSync(
      join(home, ".codex/nudge.json"),
      `${JSON.stringify({ ...OUR_ENTRY, topic: "nudge-codex", events: { question: true, permission: true, finished: true } }, null, 2)}\n`,
    )
    writeFileSync(
      join(home, ".codex/hooks.json"),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/scripts/codex-hook.mjs /x/nudge.json" }] }] } }, null, 2)}\n`,
    )
    const r = runCli(["add", "opencode"], home)
    assert.equal(r.status, 0, r.stderr)

    const entry = readJsonFile(join(home, ".config/opencode/opencode.json")).plugin.find((e) => Array.isArray(e))
    assert.equal(entry[0], REPO)
    assert.equal(entry[1].baseTopic, "nudge-codex")
    assert.equal(entry[1].serverUrl, OUR_ENTRY.serverUrl)
  }))

console.log("nudge-agent (uninstall)")

test("uninstall defaults to level 1 and removes only the config entry", () =>
  withHome((home) => {
    const config = wireOpencode(home)
    const r = runCli(["uninstall"], home)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readJsonFile(config).plugin, [])
  }))

test("uninstall removes the three standalone loaders and keeps shared settings for review", () =>
  withHome((home) => {
    wireOpencode(home)
    for (const name of ["command-code", "pi", "hermes"]) {
      assert.equal(runCli(["add", name, "--global"], home).status, 0)
    }
    const r = runCli(["uninstall", "--json"], home)
    assert.equal(r.status, 0, r.stderr)
    const items = JSON.parse(r.stdout).items
    for (const name of ["command-code", "pi", "hermes"]) {
      assert.ok(items.some((item) => item.id.startsWith(`${name}:`) && item.status === "removed"), name)
    }
    assert.ok(items.some((item) => item.id.startsWith("shared-config:") && item.status === "manual"))
    assert.equal(existsSync(join(home, ".commandcode/mods/ntfy.ts")), false)
    assert.equal(existsSync(join(home, ".pi/agent/extensions/ntfy.ts")), false)
    assert.equal(existsSync(join(home, ".hermes/plugins/ntfy")), false)
    assert.equal(existsSync(join(home, ".config/ntfy-archive/config.json")), true)
  }))

test("uninstall --level 3 refuses without --yes and deletes nothing", () =>
  withHome((home) => {
    const config = wireOpencode(home)
    mkdirSync(join(home, "ntfy"), { recursive: true })
    writeFileSync(join(home, "ntfy/docker-compose.yml"), "services: {}\n")
    const r = runCli(["uninstall", "--level", "3"], home)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--yes/)
    assert.equal(existsSync(join(home, "ntfy")), true, "data dir intact")
    assert.equal(readJsonFile(config).plugin.length, 1, "config intact")
  }))

test("uninstall rejects a bad level", () =>
  withHome((home) => {
    wireOpencode(home)
    assert.equal(runCli(["uninstall", "--level", "9"], home).status, 2)
  }))

console.log("")
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED: ${failures.join(", ")}`)
  process.exitCode = 1
} else {
  console.log(`all ${passed} CLI tests passed`)
}
