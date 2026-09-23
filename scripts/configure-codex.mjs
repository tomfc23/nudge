#!/usr/bin/env node
// Add Nudge hooks without replacing a user's other Codex hooks or notify command.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const removing = process.argv[2] === "--remove"
const scanning = process.argv[2] === "--scan"
const [hooksFile, configFile, scriptFile, topic] = process.argv.slice(removing || scanning ? 3 : 2)
const ours = (hook) => hook?.type === "command" && hook.command?.includes("scripts/codex-hook.mjs")
const hooks = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, "utf8")) : { hooks: {} }
if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) || !hooks.hooks || typeof hooks.hooks !== "object" || Array.isArray(hooks.hooks)) {
  throw new Error(`${hooksFile}: invalid hooks.json`)
}
const present = ["Stop", "PermissionRequest"].some((event) => (hooks.hooks[event] ?? []).some((group) => (group.hooks ?? []).some(ours)))
if (scanning) {
  console.log(present ? "present" : "absent")
  process.exit(0)
}
if (removing) {
  if (present) {
    for (const event of ["Stop", "PermissionRequest"]) {
      hooks.hooks[event] = (hooks.hooks[event] ?? []).map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !ours(hook)) })).filter((group) => group.hooks.length)
    }
    writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`)
    if (existsSync(configFile)) unlinkSync(configFile)
  }
  console.log(present ? "removed" : "absent")
  process.exit(0)
}
const [serverUrl, token, , all, enabledList] = (process.env.NTFY_W || "").split("|")
if (!hooksFile || !configFile || !scriptFile || !/^https?:\/\/[^\s]+$/.test(serverUrl) || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
  throw new Error("invalid Codex setup inputs")
}
const enabled = all === "1" ? ["question", "permission", "finished"] : enabledList.split(" ").filter(Boolean)
const config = { serverUrl, token, topic, events: Object.fromEntries(["question", "permission", "finished"].map((kind) => [kind, enabled.includes(kind)])) }
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`
const command = `${quote(process.execPath)} ${quote(scriptFile)} ${quote(configFile)}`
for (const event of ["Stop", "PermissionRequest"]) {
  const groups = hooks.hooks[event] ?? []
  if (!Array.isArray(groups)) throw new Error(`${hooksFile}: ${event} must be an array`)
  hooks.hooks[event] = groups.map((group) => ({
    ...group,
    hooks: (group.hooks ?? []).filter((hook) => !ours(hook)),
  })).filter((group) => group.hooks.length > 0)
  hooks.hooks[event].push({ hooks: [{ type: "command", command, timeout: 10 }] })
}
mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 })
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
chmodSync(configFile, 0o600)
mkdirSync(dirname(hooksFile), { recursive: true })
writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`)
