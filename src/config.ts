/**
 * Config parsing (SPEC.md §5). Designed for the easiest possible setup:
 *
 *   - serverUrl can come from options OR the NTFY_SERVER_URL env var.
 *   - token can come from options (literal or "{env:NAME}"), or NTFY_TOKEN.
 *   - No token at all is fine (auth-disabled self-hosted servers are common);
 *     a 401/403 from the server produces actionable guidance instead.
 *   - baseTopic is auto-generated once and persisted, so a zero-config user
 *     only has to read the topic names from the startup log once.
 */

import type { PluginOptions } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { resolveAccess } from "./access"
import type { IdleMode } from "./classify"

/** Structural view of ctx.storage (Plugin.Context["storage"]). */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface EventCfg {
  enabled: boolean
  priority: number
  tags: string[]
}

export interface QuestionCfg extends EventCfg {
  idleMode: IdleMode
  /** When provided, replaces DEFAULT_QUESTION_PATTERNS (SPEC.md §6.1). */
  patterns?: string[]
}

export interface ErrorCfg extends EventCfg {
  cooldownMs: number
}

export interface Config {
  serverUrl: string
  token?: string
  topics: { question: string; finished: string; error: string; custom: string }
  events: { question: QuestionCfg; finished: EventCfg; error: ErrorCfg }
  dedupeWindowMs: number
  publishTimeoutMs: number
  failureLogIntervalMs: number
}

export interface ConfigResult {
  config?: Config
  /** Human-readable setup guidance, logged verbatim on failure. */
  problems: string[]
  /** Startup lines to log when config is OK (topics to subscribe to, etc). */
  info: string[]
}

const PRIORITY_NAMES: Record<string, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Exported for the ntfy_notify tool: accepts names or 1–5. */
export function priorityValue(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  return priority(value, 3)
}

function priority(value: unknown, fallback: number): number {
  if (typeof value === "number" && value >= 1 && value <= 5) return Math.round(value)
  if (typeof value === "string") {
    const named = PRIORITY_NAMES[value.toLowerCase()]
    if (named) return named
    const n = Number(value)
    if (n >= 1 && n <= 5) return Math.round(n)
  }
  return fallback
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[]
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean)
  return fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function sanitizeTopic(topic: string): string {
  return topic.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)
}

/** SPEC.md §5.1: works whether or not the config loader pre-resolves {env:…}. */
function resolveToken(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return process.env.NTFY_TOKEN || undefined
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
  if (match) return process.env[match[1]] || process.env.NTFY_TOKEN || undefined
  return raw
}

function obj(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

export async function readConfig(options: PluginOptions, storage: StorageLike): Promise<ConfigResult> {
  const problems: string[] = []
  const info: string[] = []

  const serverUrl =
    typeof options.serverUrl === "string" && options.serverUrl
      ? (options.serverUrl as string).replace(/\/+$/, "")
      : process.env.NTFY_SERVER_URL?.replace(/\/+$/, "") || process.env.NTFY_BASE_URL?.replace(/\/+$/, "") || ""

  if (!serverUrl) {
    problems.push(
      "no ntfy server configured — set \"serverUrl\" in the plugin options, or export NTFY_SERVER_URL. " +
        "See the README (Quick start). Notifications are disabled until this is set.",
    )
    return { problems, info }
  }

  // --- topic names (auto-generated once, persisted so the phone can subscribe) ---
  let baseTopic =
    (typeof options.baseTopic === "string" && options.baseTopic) ||
    process.env.NTFY_BASE_TOPIC ||
    ""

  if (!baseTopic) {
    const stored = await storage.get("baseTopic").catch(() => undefined)
    if (typeof stored === "string" && stored) {
      baseTopic = stored
    } else {
      baseTopic = `opencode-${randomUUID().replace(/-/g, "").slice(0, 10)}`
      await storage.set("baseTopic", baseTopic).catch(() => undefined)
      info.push(`generated topic base "${baseTopic}" (persisted)`)
    }
  }
  baseTopic = sanitizeTopic(baseTopic)

  const topicOverrides = obj(options.topics)
  const topic = (key: string) => sanitizeTopic(typeof topicOverrides[key] === "string" && topicOverrides[key] ? topicOverrides[key] : `${baseTopic}-${key}`)

  const ev = obj(options.events)
  const evQuestion = obj(ev.question)
  const evFinished = obj(ev.finished)
  const evError = obj(ev.error)

  const idleMode: IdleMode =
    evQuestion.idleMode === "always" || evQuestion.idleMode === "off" ? evQuestion.idleMode : "heuristic"

  const patterns = Array.isArray(evQuestion.patterns)
    ? (evQuestion.patterns.filter((p: unknown) => typeof p === "string") as string[])
    : undefined

  const config: Config = {
    serverUrl,
    token: resolveToken(options.token),
    topics: {
      question: topic("question"),
      finished: topic("finished"),
      error: topic("error"),
      custom: topic("custom"),
    },
    events: {
      question: {
        enabled: bool(evQuestion.enabled, true),
        priority: priority(evQuestion.priority, 5), // urgent
        tags: stringArray(evQuestion.tags, ["question"]),
        idleMode,
        ...(patterns ? { patterns } : {}),
      },
      finished: {
        enabled: bool(evFinished.enabled, true),
        priority: priority(evFinished.priority, 3),
        tags: stringArray(evFinished.tags, ["heavy_check_mark"]),
      },
      error: {
        enabled: bool(evError.enabled, true),
        priority: priority(evError.priority, 4),
        tags: stringArray(evError.tags, ["rotating_light"]),
        cooldownMs: num(evError.cooldownSec, 60) * 1000,
      },
    },
    dedupeWindowMs: num(options.dedupeWindowMs, 10_000),
    publishTimeoutMs: num(options.publishTimeoutMs, 5_000),
    failureLogIntervalMs: num(options.failureLogIntervalMs, 600_000),
  }

  info.push(`server: ${serverUrl}`)
  // Access mode: local / tailscale / cloudflare (auto-detected, or forced via the
  // `accessMode` option). Only affects guidance — publishing is mode-agnostic.
  const access = resolveAccess(serverUrl, options.accessMode)
  info.push(`access mode: ${access.mode} — ${access.summary}`)
  for (const hint of access.hints) info.push(`hint: ${hint}`)
  for (const warning of access.warnings) info.push(`warning: ${warning}`)
  info.push(
    config.token
      ? "auth: access token configured"
      : "auth: none configured (fine if your server allows anonymous publishing)",
  )
  info.push(
    `subscribe in your ntfy app → server ${serverUrl} , topics: ` +
      `question=${config.topics.question} finished=${config.topics.finished} ` +
      `error=${config.topics.error} custom=${config.topics.custom}`,
  )

  return { config, problems, info }
}
