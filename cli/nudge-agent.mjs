#!/usr/bin/env node
/*
 * nudge-agent — manage a Nudge install (phone notifications for OpenCode and Codex).
 *
 * Deliberately a dispatcher: every action is delegated to the scripts in the
 * plugin directory — install.sh, scripts/setup-server.sh, scripts/uninstall.sh,
 * scripts/configure-opencode.mjs, scripts/configure-codex.mjs — so there is one
 * implementation of each behaviour and nothing here re-implements the installer.
 * status is the exception: it only reads.
 *
 * Zero runtime dependencies, ESM, Node >= 18.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const KINDS = ["question", "permission", "finished", "error", "custom"]
const CODEX_KINDS = ["question", "permission", "finished"]
const SITE_URL = (process.env.NTFY_SITE_URL || "https://nudge.tommyek.com").replace(/\/+$/, "")
const HOME = process.env.HOME || homedir()
const DATA_DIR = process.env.NTFY_SETUP_DIR || join(HOME, "ntfy")
const CLONE_DEFAULT = join(HOME, ".local/share/opencode-ntfy")
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex")
const CLI_PATH = fileURLToPath(import.meta.url)
const CLI_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "unknown"
  } catch {
    return "unknown"
  }
})()

let JSON_MODE = false
const say = (line = "") => (JSON_MODE ? process.stderr : process.stdout).write(`${line}\n`)
const emit = (object) => process.stdout.write(`${JSON.stringify(object, null, JSON_MODE ? 0 : 2)}\n`)
const fail = (message, code = 2) => {
  process.stderr.write(`ERROR: ${message}\n`)
  return code
}

const sh = (cmd, args, env) => spawnSync(cmd, args, { encoding: "utf8", env: env || process.env })
const run = (cmd, args, env) => spawnSync(cmd, args, { stdio: "inherit", env: env || process.env })

/* ------------------------------------------------------------------ paths */

// The installed plugin dir, resolved the way the shell scripts resolve it:
// explicit override → whatever opencode.json is actually wired to → the default
// clone → a checkout containing this CLI. Never guessed.
function pluginDir() {
  const candidates = []
  if (process.env.NTFY_PLUGIN_DIR) candidates.push(process.env.NTFY_PLUGIN_DIR)
  for (const file of configFiles()) {
    const wired = readJson(file)?.plugin
    if (Array.isArray(wired)) {
      wired.forEach((entry) => {
        if (Array.isArray(entry) && typeof entry[0] === "string") candidates.push(entry[0])
      })
    }
  }
  candidates.push(CLONE_DEFAULT)
  candidates.push(join(CLI_PATH, "..", ".."))
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "scripts/setup-server.sh")) && existsSync(join(candidate, "src/index.ts"))) {
      return candidate
    }
  }
  return null
}

const pluginScript = (plugin, name) => join(plugin, "scripts", name)

function configFiles() {
  if (process.env.NTFY_CONFIG_FILE) return [process.env.NTFY_CONFIG_FILE]
  const files = [join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/opencode.json")]
  const project = join(process.cwd(), "opencode.json")
  if (existsSync(project)) files.push(project)
  return files
}

function codexDirs() {
  const dirs = [CODEX_HOME]
  const project = join(process.cwd(), ".codex")
  if (project !== CODEX_HOME) dirs.push(project)
  return dirs
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// "|"-separated, same contract as uninstall.sh's TARGETS.
function targets(plugin) {
  const extra = (process.env.NTFY_REMOVE_PATHS || "").split(":").filter(Boolean)
  return [plugin, ...extra].filter(Boolean).join("|")
}

/* ------------------------------------------------------------------ settings */

// Codex stores booleans, opencode stores objects with an optional enabled:false.
const kindEnabled = (events, kind) => {
  const value = events?.[kind]
  if (value === undefined) return true
  if (typeof value === "boolean") return value
  return value?.enabled !== false
}
const enabledKinds = (events, kinds = KINDS) => kinds.filter((kind) => kindEnabled(events, kind))

function opencodeSettings(plugin) {
  for (const file of configFiles()) {
    const result = sh("node", [pluginScript(plugin, "configure-opencode.mjs"), "--show", file, targets(plugin)])
    const parsed = result.stdout ? readJsonText(result.stdout) : null
    if (parsed?.status === "present") {
      return { source: "opencode", file, options: parsed.options || {}, pluginPath: parsed.path }
    }
  }
  return null
}

function codexSettings() {
  for (const dir of codexDirs()) {
    const hooksFile = join(dir, "hooks.json")
    if (!ourHooks(hooksFile).length) continue
    const config = readJson(join(dir, "nudge.json"))
    if (!config) continue
    return { source: "codex", dir, hooksFile, config }
  }
  return null
}

const readJsonText = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Whichever harness is already wired — the settings a new harness copies from.
function currentSettings(plugin) {
  const opencode = opencodeSettings(plugin)
  if (opencode) {
    return {
      harness: "opencode",
      scope: isProjectPath(opencode.file) ? "project" : "global",
      serverUrl: opencode.options.serverUrl,
      token: opencode.options.token,
      topic: opencode.options.baseTopic,
      events: opencode.options.events,
    }
  }
  const codex = codexSettings()
  if (codex) {
    return {
      harness: "codex",
      scope: isProjectPath(codex.dir) ? "project" : "global",
      serverUrl: codex.config.serverUrl,
      token: codex.config.token,
      topic: codex.config.topic,
      events: codex.config.events,
    }
  }
  return null
}

const isProjectPath = (path) => path.startsWith(`${process.cwd()}/`)

function ourHooks(hooksFile) {
  const config = readJson(hooksFile)
  const found = []
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, gi) => {
      if (!Array.isArray(group?.hooks)) return
      group.hooks.forEach((hook, hi) => {
        if (typeof hook?.command === "string" && hook.command.includes("codex-hook.mjs")) found.push({ event, gi, hi })
      })
    })
  }
  return found
}

const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()

// Codex records trust per hook position in the global config.toml. Configured but
// untrusted hooks are silently inert, so status has to say so.
function trustState(hooksFile, hooks) {
  const trusted = new Set()
  try {
    const toml = readFileSync(join(CODEX_HOME, "config.toml"), "utf8")
    for (const match of toml.matchAll(/hooks\.state\."([^"]+)"/g)) trusted.add(match[1])
  } catch {
    // no config.toml → nothing trusted
  }
  return hooks.map((hook) => ({
    key: `${hooksFile}:${snake(hook.event)}:${hook.gi}:${hook.hi}`,
    trusted: trusted.has(`${hooksFile}:${snake(hook.event)}:${hook.gi}:${hook.hi}`),
  }))
}

function serverInfo() {
  let url = null
  try {
    const match = readFileSync(join(DATA_DIR, "etc/server.yml"), "utf8").match(/^base-url:\s*"?([^"\s]+)"?/m)
    if (match) url = match[1]
  } catch {
    return null
  }
  if (!url) return null
  return { url, mode: modeFor(url) }
}

function modeFor(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "http:") return "local"
    if (/\.ts\.net$/.test(parsed.hostname)) return "tailscale"
    return "cloudflare"
  } catch {
    return "unknown"
  }
}

function inventory(plugin) {
  const result = sh("bash", [pluginScript(plugin, "uninstall.sh"), "--json", "inventory"])
  return readJsonText(result.stdout)?.items || []
}

const pluginVersion = (plugin) => readJson(join(plugin, "package.json"))?.version || "unknown"

/* ------------------------------------------------------------------ status */

async function gather(plugin) {
  const items = plugin ? inventory(plugin) : []
  const item = (id) => items.find((entry) => entry.id === id)
  const settings = plugin ? currentSettings(plugin) : null
  const server = serverInfo()
  const opencode = plugin ? opencodeSettings(plugin) : null
  const codex = codexSettings()
  const hooks = codex ? ourHooks(codex.hooksFile) : []
  const trust = codex ? trustState(codex.hooksFile, hooks) : []
  const health = server ? await probe(server.url) : null

  return {
    ok: true,
    kind: "status",
    cli: { version: CLI_VERSION, path: CLI_PATH },
    plugin: plugin
      ? {
          dir: plugin,
          kind: existsSync(join(plugin, ".git")) ? "checkout" : "clone",
          version: pluginVersion(plugin),
        }
      : null,
    server: server ? { ...server, ...health } : null,
    topic: settings?.topic || null,
    harnesses: {
      opencode: opencode
        ? {
            present: true,
            config: opencode.file,
            entry: opencode.pluginPath,
            events: enabledKinds(opencode.options.events),
          }
        : { present: false },
      codex: codex
        ? {
            present: true,
            dir: codex.dir,
            hooks: hooks.length,
            trusted: trust.filter((entry) => entry.trusted).length,
            events: enabledKinds(codex.config.events, CODEX_KINDS),
          }
        : { present: false },
    },
    dataDir: DATA_DIR,
    inventory: items,
    container: item("container")?.status || "unknown",
  }
}

async function probe(url) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/health`, { signal: AbortSignal.timeout(3000) })
    return { reachable: response.ok, http: response.status }
  } catch {
    return { reachable: false, http: null }
  }
}

const yes = (value) => (value ? "✓" : "✗")

async function cmdStatus() {
  const plugin = pluginDir()
  const status = await gather(plugin)

  if (JSON_MODE) {
    emit(status)
    return status.cli ? 0 : 0
  }
  if (!plugin) {
    say("plugin   not installed")
    say("")
    say("Run: nudge-agent install")
    return 1
  }

  say(`plugin   ${status.plugin.dir} (${status.plugin.kind}, v${status.plugin.version})`)
  const server = status.server
  say(
    `server   ${
      server
        ? `${server.url} (${server.mode}) — ${server.reachable ? `reachable, HTTP ${server.http}` : "unreachable"}`
        : "(no server.yml)"
    }`,
  )
  say(`topic    ${status.topic || "(none)"}`)
  const opencode = status.harnesses.opencode
  say(
    `opencode ${opencode.present ? `${yes(true)} ${opencode.config}` : "not wired"}` +
      (opencode.present ? ` — events: ${describe(opencode.events, KINDS)}` : ""),
  )
  const codex = status.harnesses.codex
  say(
    `codex    ${codex.present ? `${yes(true)} ${codex.dir}/hooks.json` : "not wired"}` +
      (codex.present
        ? ` — ${codex.hooks} hooks, ${codex.trusted} trusted${codex.trusted < codex.hooks ? " (trust them in /hooks)" : ""}`
        : ""),
  )
  say(`data     ${status.dataDir} — container: ${status.container}`)
  if (!opencode.present && !codex.present) {
    say("")
    say("Nothing is wired to a harness yet — run: nudge-agent install")
  }
  return 0
}

const describe = (enabled, all) => (enabled.length === all.length ? `all ${all.length}` : enabled.join(", ") || "none")

/* ------------------------------------------------------------------ install / update */

function cmdInstall(args) {
  const harness = flag(args, "--harness")
  const dir = mkdtempSync(join(tmpdir(), "nudge-agent-"))
  const file = join(dir, "install.sh")
  try {
    say(`downloading ${SITE_URL}/install.sh`)
    const curl = run("curl", ["-fsSL", `${SITE_URL}/install.sh`, "-o", file])
    if (curl.status !== 0 || !existsSync(file)) return fail(`could not download ${SITE_URL}/install.sh`, 3)
    const env = { ...process.env, NTFY_SITE_URL: process.env.NTFY_SITE_URL || SITE_URL }
    if (harness) env.NTFY_HARNESSES = harness
    return run("bash", [file], env).status ?? 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Fill in the wizard's answers from what is already installed, so update runs
// unattended; anything the caller set explicitly still wins, and stdio stays
// inherited so a prompt we could not answer can still be answered.
function detectedInstallerEnv(plugin) {
  const detected = {}
  const wired = []
  if (opencodeSettings(plugin)) wired.push("opencode")
  if (codexSettings()) wired.push("codex")
  if (wired.length) detected.NTFY_HARNESSES = wired.length === 2 ? "both" : wired[0]

  const server = serverInfo()
  if (server) {
    detected.NTFY_MODE = server.mode
    const host = new URL(server.url).hostname
    if (server.mode === "local") detected.LAN_IP = host
    if (server.mode === "cloudflare") detected.CF_HOSTNAME = host
  }

  const settings = currentSettings(plugin)
  if (settings) {
    const enabled = enabledKinds(settings.events)
    detected.NTFY_EVENTS = enabled.length === KINDS.length ? "all" : enabled.join(",")
    detected.NTFY_SCOPE = settings.scope
  }
  detected.NTFY_PHONE = "none"
  detected.NTFY_SKIP_CONFIRM = "1"

  const env = { ...process.env }
  for (const [key, value] of Object.entries(detected)) if (process.env[key] === undefined) env[key] = value
  return env
}

function cmdUpdate(args) {
  const plugin = pluginDir()
  if (!plugin) return fail("Nudge is not installed — run: nudge-agent install", 3)
  const checkout = existsSync(join(plugin, ".git"))
  const before = pluginVersion(plugin)

  if (checkout) {
    say(`plugin   ${plugin} (checkout) — git pull`)
    if (args.includes("--dry-run")) {
      say(`  git -C ${plugin} pull --ff-only`)
      return 0
    }
    const lockBefore = readFileSync(join(plugin, "package-lock.json"), "utf8")
    const pull = run("git", ["-C", plugin, "pull", "--ff-only"])
    if (pull.status !== 0) return pull.status ?? 1
    const lockAfter = readFileSync(join(plugin, "package-lock.json"), "utf8")
    if (lockBefore !== lockAfter) {
      say("dependencies changed — npm ci")
      const npm = run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefix", plugin])
      if (npm.status !== 0) return npm.status ?? 1
    }
  } else {
    const env = detectedInstallerEnv(plugin)
    say("plugin   downloaded install — re-running the installer")
    if (args.includes("--dry-run")) {
      say(`  ${SITE_URL}/install.sh with ${Object.entries(env).filter(([k]) => k.startsWith("NTFY_")).length} NTFY_* overrides`)
      for (const key of ["NTFY_HARNESSES", "NTFY_MODE", "NTFY_SCOPE", "NTFY_EVENTS"]) say(`  ${key}=${env[key] ?? "(unset)"}`)
      return 0
    }
    const dir = mkdtempSync(join(tmpdir(), "nudge-agent-"))
    const file = join(dir, "install.sh")
    try {
      const curl = run("curl", ["-fsSL", `${SITE_URL}/install.sh`, "-o", file])
      if (curl.status !== 0 || !existsSync(file)) return fail(`could not download ${SITE_URL}/install.sh`, 3)
      if (process.env.NTFY_SITE_URL === undefined) env.NTFY_SITE_URL = SITE_URL
      const result = run("bash", [file], env)
      if (result.status !== 0) return result.status ?? 1
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const after = pluginVersion(pluginDir() || plugin)
  say("")
  say(`plugin   v${before} → v${after}${before === after ? " (already current)" : ""}`)
  say("restart OpenCode once to load the new plugin")
  return 0
}

/* ------------------------------------------------------------------ add / remove */

function writeCodex(plugin, settings, scope) {
  const dir = scope === "project" ? join(process.cwd(), ".codex") : CODEX_HOME
  const enabled = enabledKinds(settings.events, CODEX_KINDS)
  const env = {
    ...process.env,
    NTFY_W: [
      settings.serverUrl,
      settings.token,
      settings.topic,
      enabled.length === CODEX_KINDS.length ? "1" : "0",
      enabled.join(" "),
    ].join("|"),
  }
  const result = sh(
    "node",
    [
      pluginScript(plugin, "configure-codex.mjs"),
      join(dir, "hooks.json"),
      join(dir, "nudge.json"),
      pluginScript(plugin, "codex-hook.mjs"),
      settings.topic,
    ],
    env,
  )
  if (result.status !== 0) return fail(result.stderr.trim() || "writing Codex hooks failed", result.status ?? 1)
  say(`codex    ✓ ${join(dir, "hooks.json")}`)
  say("         open /hooks in Codex and trust Nudge's two hooks, or nothing fires")
  return 0
}

function writeOpencode(plugin, settings, scope) {
  const file =
    scope === "project"
      ? join(process.cwd(), "opencode.json")
      : join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/opencode.json")
  const enabled = enabledKinds(settings.events)
  const env = {
    ...process.env,
    NTFY_W: [
      settings.serverUrl,
      settings.token,
      settings.topic,
      enabled.length === KINDS.length ? "1" : "0",
      enabled.join(" "),
    ].join("|"),
  }
  const result = sh("node", [pluginScript(plugin, "configure-opencode.mjs"), file, plugin], env)
  if (result.status !== 0) return fail(result.stderr.trim() || "writing the opencode config failed", result.status ?? 1)
  say(`opencode ✓ ${file}`)
  say("         restart OpenCode once to load the plugin")
  return 0
}

function cmdAdd(args) {
  const harness = args.find((arg) => !arg.startsWith("-"))
  if (harness !== "opencode" && harness !== "codex") return fail("add needs a harness: opencode | codex")
  const plugin = pluginDir()
  if (!plugin) return fail("Nudge is not installed — run: nudge-agent install", 3)

  const scope = args.includes("--project") ? "project" : args.includes("--global") ? "global" : null
  if (harness === "codex" && codexSettings()) {
    say("codex    already wired")
    return 0
  }
  if (harness === "opencode" && opencodeSettings(plugin)) {
    say("opencode already wired")
    return 0
  }

  const settings = currentSettings(plugin)
  if (!settings) {
    return fail("nothing to copy serverUrl/token/topic from — run: nudge-agent install", 3)
  }
  say(`settings from ${settings.harness} (${settings.topic})`)
  return harness === "codex"
    ? writeCodex(plugin, settings, scope || settings.scope)
    : writeOpencode(plugin, settings, scope || settings.scope)
}

function cmdRemove(args) {
  const harness = args.find((arg) => !arg.startsWith("-"))
  if (harness !== "opencode" && harness !== "codex") return fail("remove needs a harness: opencode | codex")
  const plugin = pluginDir()
  if (!plugin) return fail("Nudge is not installed — run: nudge-agent install", 3)

  const removed = []
  if (harness === "opencode") {
    for (const file of configFiles()) {
      const result = sh("node", [pluginScript(plugin, "configure-opencode.mjs"), "--remove", file, targets(plugin)])
      const [status] = (result.stdout || "").split("\t")
      if (status === "removed") {
        removed.push(file)
        say(`opencode ✓ ${file}`)
      }
    }
    if (!removed.length) say("opencode nothing to remove")
  } else {
    for (const dir of codexDirs()) {
      const hooksFile = join(dir, "hooks.json")
      if (!ourHooks(hooksFile).length) continue
      const result = sh("node", [
        pluginScript(plugin, "configure-codex.mjs"),
        "--remove",
        hooksFile,
        join(dir, "nudge.json"),
      ])
      const status = (result.stdout || "").trim()
      if (status === "removed") {
        removed.push(hooksFile)
        say(`codex    ✓ ${hooksFile}`)
      } else if (status === "failed") {
        return fail(`could not remove ${hooksFile}`, 3)
      }
    }
    if (!removed.length) say("codex    nothing to remove")
  }

  if (JSON_MODE) emit({ ok: true, kind: "remove", harness, removed })
  else if (removed.length) say("")
  return 0
}

/* ------------------------------------------------------------------ uninstall */

function cmdUninstall(args) {
  const plugin = pluginDir()
  if (!plugin) return fail("Nudge is not installed — run: nudge-agent install", 3)

  const level = flag(args, "--level") || "1"
  if (!["1", "2", "3"].includes(level)) return fail("--level must be 1, 2 or 3")
  const dataDir = flag(args, "--data") || DATA_DIR

  if (level === "3") {
    if (args.includes("--data") && dataDir !== DATA_DIR) {
      return fail(`--data must match the data dir byte-for-byte: ${DATA_DIR}`)
    }
    if (!args.includes("--yes") && !args.includes("-y")) {
      return fail(`level 3 deletes ${DATA_DIR} (server data, cache, auth) — re-run with --yes`, 2)
    }
  }

  const scriptArgs = [pluginScript(plugin, "uninstall.sh"), level]
  if (JSON_MODE) scriptArgs.splice(1, 0, "--json")
  if (level === "3") scriptArgs.push(`--confirm-data=${DATA_DIR}`)
  return run("bash", scriptArgs).status ?? 1
}

/* ------------------------------------------------------------------ dispatch */

const USAGE = `nudge-agent — manage a Nudge install (phone notifications for OpenCode and Codex)

  nudge-agent install [--harness both|opencode|codex]     run the setup wizard
  nudge-agent status                                      what is wired up right now
  nudge-agent update [--dry-run]                          bring the plugin up to date
  nudge-agent add <opencode|codex> [--global|--project]   wire one more harness
  nudge-agent remove <opencode|codex>                     unwire one harness
  nudge-agent uninstall [--level 1|2|3] [--yes]           remove Nudge

Flags:
  --json          machine-readable output on stdout, human text on stderr
  --yes, -y       skip confirmations (required for --level 3)
  --help, -h      this text
  --version, -v   print the CLI version

Env: NTFY_SITE_URL NTFY_PLUGIN_DIR NTFY_SETUP_DIR NTFY_CONFIG_FILE CODEX_HOME
     XDG_CONFIG_HOME, plus any NTFY_* the installer accepts (passed through)

Exit codes: 0 ok · 2 usage/input · 3 missing dependency or partial · 4 conflict · 5 runtime`

function flag(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  JSON_MODE = args.includes("--json")
  const command = args.find((arg) => !arg.startsWith("-"))

  if (args.includes("--help") || args.includes("-h") || (!command && !args.includes("--version"))) {
    say(USAGE)
    return 0
  }
  if (args.includes("--version") || args.includes("-v")) {
    say(`nudge-agent ${CLI_VERSION}`)
    return 0
  }

  // Commands see their arguments without the command word itself, so an
  // operand scan ("add <harness>") cannot mistake the verb for the operand.
  const index = args.indexOf(command)
  const rest = index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 1)]

  switch (command) {
    case "install":
      return cmdInstall(rest)
    case "status":
      return cmdStatus()
    case "update":
      return cmdUpdate(rest)
    case "add":
      return cmdAdd(rest)
    case "remove":
      return cmdRemove(rest)
    case "uninstall":
      return cmdUninstall(rest)
    default:
      return fail(`unknown command: ${command} (see --help)`)
  }
}

process.exitCode = await main()
