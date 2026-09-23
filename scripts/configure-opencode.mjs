#!/usr/bin/env node
/*
 * OpenCode config writer — the single implementation of "add / remove / scan
 * Nudge's entry in opencode.json", shared by install.sh, scripts/uninstall.sh
 * and the nudge-agent CLI.
 *
 *   node scripts/configure-opencode.mjs --scan   <configFile> [targets]
 *   node scripts/configure-opencode.mjs --remove <configFile> [targets]
 *   node scripts/configure-opencode.mjs <configFile> <pluginPath>
 *
 * --scan and --remove print "<status>\t<detail>" on stdout — statuses are
 * present | absent | ambiguous | removed | failed — and always exit 0, so a
 * caller only has to check for empty output.
 *
 * add reads its settings from NTFY_W ("<serverUrl>|<token>|<proposedTopic>|
 * <all>|<list>"), prints the resulting topic, and exits 2 on bad input or 5 if
 * the write cannot be verified.
 *
 * `targets` is "|"-separated. An entry is ours when it is one of the targets or
 * named opencode-ntfy; an untargeted entry carrying our option shape is reported
 * as stale and never touched (SPEC §15.2 D17c: ambiguous candidates are never
 * guessed). Foreign entries and sibling keys are always preserved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname } from "node:path"

const KINDS = ["question", "permission", "finished", "error", "custom"]

const clean = (value) => String(value === undefined ? "" : value).replace(/[\t\n]/g, " ")
const out = (status, detail) => console.log(`${status}\t${clean(detail)}`)

const args = process.argv.slice(2)
const mode = args[0] === "--scan" ? "scan" : args[0] === "--remove" ? "remove" : "add"
if (mode !== "add") args.shift()

if (mode === "add") add()
else manage()

/* ------------------------------------------------------------------ remove/scan */

function manage() {
  const [file, targetArg = ""] = args
  if (!file) {
    out("failed", "usage: configure-opencode.mjs --scan|--remove <configFile> [targets]")
    return
  }
  const targets = targetArg.split("|").filter(Boolean)
  const ours = (p) => typeof p === "string" && (targets.indexOf(p) >= 0 || basename(p) === "opencode-ntfy")
  const looksLikeOurs = (o) =>
    !!o && typeof o === "object" && typeof o.serverUrl === "string" && ("baseTopic" in o || "token" in o)

  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if (error && error.code === "ENOENT") return out("absent", "file not present")
    return out("failed", `cannot read/parse: ${error.message || error}`)
  }
  if (cfg.plugin !== undefined && !Array.isArray(cfg.plugin)) return out("failed", '"plugin" is not an array')
  if (cfg.plugins !== undefined && !Array.isArray(cfg.plugins)) return out("failed", '"plugins" is not an array')

  const matched = []
  const stale = []
  const plugin = Array.isArray(cfg.plugin) ? cfg.plugin : null
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : null
  if (plugin) {
    plugin.forEach((entry) => {
      const p = Array.isArray(entry) ? entry[0] : undefined
      const o = Array.isArray(entry) ? entry[1] : undefined
      if (ours(p)) matched.push(String(p))
      else if (looksLikeOurs(o)) stale.push(String(p))
    })
  }
  if (plugins) {
    plugins.forEach((entry) => {
      const p = entry && entry.package
      const o = entry && entry.options
      if (ours(p)) matched.push(String(p))
      else if (looksLikeOurs(o)) stale.push(String(p === undefined ? "?" : p))
    })
  }

  if (mode === "scan") {
    if (matched.length) {
      out("present", `${matched.length} entry/entries: ${matched.join(", ")}` + (stale.length ? `; stale: ${stale.join(", ")}` : ""))
    } else if (stale.length) {
      out("ambiguous", `stale (not at a known path): ${stale.join(", ")}`)
    } else {
      out("absent", "0 entries")
    }
    return
  }

  const removed = []
  if (plugin) {
    const kept = []
    plugin.forEach((entry) => {
      if (Array.isArray(entry) && ours(entry[0])) removed.push(String(entry[0]))
      else kept.push(entry)
    })
    cfg.plugin = kept
  }
  if (plugins) {
    const kept = []
    plugins.forEach((entry) => {
      if (entry && ours(entry.package)) removed.push(String(entry.package))
      else kept.push(entry)
    })
    cfg.plugins = kept
  }
  if (!removed.length) {
    return stale.length
      ? out("ambiguous", `stale (not removed; confirm with NTFY_REMOVE_PATHS): ${stale.join(", ")}`)
      : out("absent", "0 entries")
  }
  try {
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)
  } catch (error) {
    return out("failed", `write failed: ${error.message || error}`)
  }
  const left = []
  try {
    const back = JSON.parse(readFileSync(file, "utf8"))
    ;(Array.isArray(back.plugin) ? back.plugin : []).forEach((entry) => {
      if (Array.isArray(entry) && ours(entry[0])) left.push(String(entry[0]))
    })
    ;(Array.isArray(back.plugins) ? back.plugins : []).forEach((entry) => {
      if (entry && ours(entry.package)) left.push(String(entry.package))
    })
  } catch (error) {
    return out("failed", `verify read failed: ${error.message || error}`)
  }
  if (left.length) return out("failed", `verify: still present: ${left.join(", ")}`)
  out(
    "removed",
    `${removed.length} entry/entries removed: ${removed.join(", ")}` +
      (stale.length ? `; stale left — confirm with NTFY_REMOVE_PATHS if yours: ${stale.join(", ")}` : ""),
  )
}

/* ------------------------------------------------------------------ add */

function add() {
  const [file, pluginPath] = args
  const [serverUrl, token, proposed, evAll, evList = ""] = (process.env.NTFY_W || "").split("|")
  if (!file || !pluginPath) {
    console.error("usage: configure-opencode.mjs <configFile> <pluginPath>   (settings via NTFY_W)")
    process.exit(2)
  }
  const enabled = evAll === "1" ? KINDS : evList.split(" ").filter(Boolean)

  let cfg = {}
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error(`cannot parse ${file}: ${error.message || error}`)
      process.exit(2)
    }
  }
  if (cfg.plugin !== undefined && !Array.isArray(cfg.plugin)) {
    console.error(`${file}: "plugin" is not an array`)
    process.exit(2)
  }
  if (cfg.plugins !== undefined && !Array.isArray(cfg.plugins)) {
    console.error(`${file}: "plugins" is not an array`)
    process.exit(2)
  }

  const mine = (v) => typeof v === "string" && (v === pluginPath || basename(v) === "opencode-ntfy")
  let entry = null
  let form = null
  if (Array.isArray(cfg.plugin)) {
    cfg.plugin.forEach((e) => {
      if (!entry && Array.isArray(e) && mine(e[0])) {
        entry = e
        form = "plugin"
      }
    })
  }
  if (!entry && Array.isArray(cfg.plugins)) {
    cfg.plugins.forEach((e) => {
      if (!entry && e && mine(e.package)) {
        entry = e
        form = "plugins"
      }
    })
  }
  if (!entry) {
    if (!Array.isArray(cfg.plugin)) cfg.plugin = []
    if (form === "plugins") {
      entry = { package: pluginPath, options: {} }
      cfg.plugins.push(entry)
    } else {
      entry = [pluginPath, {}]
      cfg.plugin.push(entry)
      form = "plugin"
    }
  }

  const opts = form === "plugin" ? (entry[1] = entry[1] || {}) : (entry.options = entry.options || {})
  opts.serverUrl = serverUrl
  opts.token = token
  opts.baseTopic = typeof opts.baseTopic === "string" && opts.baseTopic ? opts.baseTopic : proposed
  const events = opts.events && typeof opts.events === "object" ? opts.events : {}
  KINDS.forEach((kind) => {
    if (enabled.indexOf(kind) === -1) {
      events[kind] = Object.assign({}, events[kind], { enabled: false })
    } else if (events[kind] && events[kind].enabled === false) {
      delete events[kind].enabled
      if (events[kind] && Object.keys(events[kind]).length === 0) delete events[kind]
    }
  })
  if (Object.keys(events).length > 0) opts.events = events
  else delete opts.events

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)

  const back = JSON.parse(readFileSync(file, "utf8"))
  const installed =
    form === "plugin"
      ? Array.isArray(back.plugin) && back.plugin.some((e) => Array.isArray(e) && mine(e[0]))
      : Array.isArray(back.plugins) && back.plugins.some((e) => e && mine(e.package))
  if (!installed) {
    console.error(`config verification failed for ${file}`)
    process.exit(5)
  }
  process.stdout.write(opts.baseTopic)
}
