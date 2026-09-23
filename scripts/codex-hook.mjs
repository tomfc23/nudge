#!/usr/bin/env node
// Codex Stop and PermissionRequest hooks. Input is one JSON object on stdin.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function autoReview() {
  try {
    // ponytail: global config approximates the active reviewer; use a post-routing hook if Codex adds one.
    const root = readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8").split(/^\s*\[/m, 1)[0]
    return /^\s*approvals_reviewer\s*=\s*["']auto_review["']\s*(?:#.*)?$/m.test(root)
  } catch { return false }
}

const clip = (value, max = 160) => {
  const text = String(value ?? "").replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : max).trimEnd()}…`
}

async function main() {
  const event = JSON.parse(await new Promise((resolve, reject) => {
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 1_000_000) reject(new Error("hook input too large")) })
    process.stdin.on("end", () => resolve(input))
    process.stdin.on("error", reject)
  }))
  const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"))
  if (!/^https?:\/\/[^\s]+$/.test(cfg.serverUrl) || !/^[A-Za-z0-9_-]{1,64}$/.test(cfg.topic)) throw new Error("invalid config")

  let kind, title, message, priority, tags
  if (event.hook_event_name === "PermissionRequest") {
    if (["bypassPermissions", "dontAsk"].includes(event.permission_mode) || autoReview()) return
    kind = "permission"
    title = "Codex: Permission needed"
    message = clip(event.tool_input?.description || event.tool_name || "Codex needs approval to continue.")
    priority = 5
    tags = ["lock"]
  } else if (event.hook_event_name === "Stop") {
    const reply = String(event.last_assistant_message || "")
    kind = /\?\s*$|\b(?:should i|would you like|do you want|can you|could you)\b/i.test(reply) ? "question" : "finished"
    title = kind === "question" ? "Codex: Question" : "Codex: Finished"
    message = kind === "question" ? clip(reply.match(/[^.!?\n]*\?/g)?.at(-1) || reply || "Codex is waiting for your input.") : "Codex finished its turn."
    priority = kind === "question" ? 5 : 3
    tags = [kind === "question" ? "question" : "heavy_check_mark"]
  } else return
  if (cfg.events?.[kind] === false) return

  const headers = { "Content-Type": "application/json" }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
  const response = await fetch(`${cfg.serverUrl.replace(/\/+$/, "")}/`, {
    method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ topic: cfg.topic, title, message, priority, tags }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

main().catch((error) => {
  console.error(`nudge: Codex notification failed (${error.message})`)
}).finally(() => {
  // Stop hooks must return JSON and must never hold the Codex turn open.
  process.stdout.write("{}\n")
})
