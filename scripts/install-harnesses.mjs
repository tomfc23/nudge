#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"

const [repo, scope, harnesses] = process.argv.slice(2)
const selected = harnesses.split(",")
const home = homedir()
const cwd = process.env.NTFY_PROJECT_DIR || process.cwd()
const projectKey = createHash("sha256").update(cwd).digest("hex")
const configFile = scope === "project" ? join(home, ".config/ntfy-archive/projects", `${projectKey}.json`) : join(home, ".config/ntfy-archive/config.json")
let config = {}
if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, "utf8"))
config.serverUrl = process.env.NTFY_SERVER_URL
config.token = process.env.NTFY_TOKEN
config.baseTopic = selected.includes("opencode") ? process.env.NTFY_TOPIC : (config.baseTopic || process.env.NTFY_TOPIC)
const enabled = process.env.NTFY_EVENTS === "all" ? ["question", "permission", "finished", "error", "custom"] : process.env.NTFY_EVENTS.split(",")
config.events ||= {}
for (const kind of ["question", "permission", "finished", "error", "custom"]) {
  config.events[kind] ||= {}
  config.events[kind].enabled = enabled.includes(kind)
}
mkdirSync(dirname(configFile), { recursive: true })
writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
chmodSync(configFile, 0o600)

function loader(target, source) {
  mkdirSync(dirname(target), { recursive: true })
  const text = `export { default } from ${JSON.stringify(resolve(repo, source))}\n`
  if (existsSync(target) && readFileSync(target, "utf8") !== text && !readFileSync(target, "utf8").includes("/adapters/")) {
    throw new Error(`${target} already exists and is not a Nudge loader`)
  }
  writeFileSync(target, text)
  console.log(`installed: ${target}`)
}

if (selected.includes("command-code")) loader(scope === "project" ? join(cwd, ".commandcode/mods/ntfy.ts") : join(home, ".commandcode/mods/ntfy.ts"), "adapters/command-code.ts")
if (selected.includes("pi")) loader(scope === "project" ? join(cwd, ".pi/extensions/ntfy.ts") : join(home, ".pi/agent/extensions/ntfy.ts"), "adapters/pi.ts")
if (selected.includes("hermes")) {
  const target = join(home, ".hermes/plugins/ntfy")
  const source = resolve(repo, "adapters/hermes")
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
    if (!lstatSync(target).isSymbolicLink() || resolve(dirname(target), readlinkSync(target)) !== source) {
      throw new Error(`${target} already exists; remove it manually before installing Nudge`)
    }
  } else symlinkSync(source, target, "dir")
  const enabled = spawnSync("hermes", ["plugins", "enable", "ntfy"], { encoding: "utf8" })
  if (enabled.error?.code === "ENOENT") console.log("Hermes is not installed yet; run `hermes plugins enable ntfy` after installing it")
  else if (enabled.status !== 0) throw new Error(`Hermes plugin was placed but could not be enabled: ${enabled.stderr || enabled.stdout}`)
  console.log(`installed: ${target}`)
}
console.log(`topic: ${config.baseTopic}`)
console.log(`config: ${configFile}`)
