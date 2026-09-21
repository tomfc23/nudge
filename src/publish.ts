/**
 * ntfy publish client (SPEC.md §7) with:
 *  - per-event dedupe + question→finished suppression (§6.2)
 *  - per-session error cooldown (§6.3)
 *  - rate-limited failure logging + recovery lines (§7.1)
 * Failures are logged, never thrown into event loops.
 */

import type { Config } from "./config"

export type EventKind = "question" | "finished" | "error" | "custom"

export interface NotifyInput {
  topic?: string
  title: string
  message: string
  priority?: number
  tags?: string[]
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface ErrorState {
  last: number
  suppressed: number
}

export class Notifier {
  private readonly recent = new Map<string, number>()
  private readonly lastQuestion = new Map<string, number>()
  private readonly errorState = new Map<string, ErrorState>()
  private readonly lastFailureLog = new Map<string, number>()
  private readonly needsRecoveryLog = new Set<string>()

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** Publish an event-kind notification (dedupe/cooldown applied). */
  notify(kind: EventKind, sessionID: string, input: NotifyInput): void {
    const now = Date.now()
    const cfg = this.config.events

    if (kind === "question" && !cfg.question.enabled) return
    if (kind === "finished" && !cfg.finished.enabled) return
    if (kind === "error" && !cfg.error.enabled) return

    let message = input.message

    if (kind === "error") {
      // §6.3: per-session cooldown; count suppressed errors for the next ping.
      const state = this.errorState.get(sessionID)
      if (state && now - state.last < cfg.error.cooldownMs) {
        state.suppressed += 1
        return
      }
      const suppressed = state?.suppressed ?? 0
      this.errorState.set(sessionID, { last: now, suppressed: 0 })
      if (suppressed > 0) message += ` (+${suppressed} similar errors suppressed)`
    } else if (kind !== "custom") {
      // §6.2 dedupe: (sessionID, kind) within the window…
      const key = `${sessionID}:${kind}`
      const last = this.recent.get(key) ?? 0
      if (now - last < this.config.dedupeWindowMs) return
      // …and a fresh question suppresses a concurrent "finished".
      if (kind === "finished") {
        const lastQ = this.lastQuestion.get(sessionID) ?? 0
        if (now - lastQ < this.config.dedupeWindowMs) return
      }
      this.recent.set(key, now)
      if (kind === "question") this.lastQuestion.set(sessionID, now)
    }

    const topic = input.topic ?? this.topicFor(kind)
    const priority = input.priority ?? this.priorityFor(kind)
    const tags = input.tags ?? this.tagsFor(kind)

    void this.publish(topic, {
      topic,
      title: input.title,
      message,
      ...(priority !== undefined ? { priority } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    })
  }

  /** Bypass dedupe (used by the ntfy_notify tool). */
  custom(input: NotifyInput, sessionID = "custom"): Promise<void> {
    const topic = input.topic ?? this.config.topics.custom
    return this.publish(topic, {
      topic,
      title: input.title,
      message: input.message,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    })
  }

  private topicFor(kind: EventKind): string {
    return this.config.topics[kind as "question" | "finished" | "error" | "custom"]
  }

  private priorityFor(kind: EventKind): number | undefined {
    const ev = this.config.events
    if (kind === "question") return ev.question.priority
    if (kind === "finished") return ev.finished.priority
    if (kind === "error") return ev.error.priority
    return undefined
  }

  private tagsFor(kind: EventKind): string[] {
    const ev = this.config.events
    if (kind === "question") return ev.question.tags
    if (kind === "finished") return ev.finished.tags
    if (kind === "error") return ev.error.tags
    return []
  }

  private async publish(topic: string, body: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.config.token) headers["Authorization"] = `Bearer ${this.config.token}`

    try {
      const response = await this.fetchImpl(`${this.config.serverUrl}/`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.publishTimeoutMs),
      })
      if (response.ok) {
        this.logRecovery(topic)
        return
      }
      this.logFailure(topic, statusClass(response.status), `ntfy: publish to "${topic}" failed: HTTP ${response.status}${statusHint(response.status)}`)
    } catch (error) {
      this.logFailure(topic, "transport", `ntfy: publish to "${topic}" failed: ${(error as Error)?.message ?? error}`)
    }
  }

  /** §7.1: first failure logs immediately, then at most once per interval, per (topic, class). */
  private logFailure(key: string, statusClass: string, message: string): void {
    const logKey = `${key}:${statusClass}`
    const now = Date.now()
    const last = this.lastFailureLog.get(logKey)
    if (last !== undefined && now - last < this.config.failureLogIntervalMs) return
    this.lastFailureLog.set(logKey, now)
    this.needsRecoveryLog.add(logKey)
    console.error(message)
  }

  private logRecovery(topic: string): void {
    for (const logKey of [...this.needsRecoveryLog]) {
      if (logKey.startsWith(`${topic}:`)) {
        this.needsRecoveryLog.delete(logKey)
        console.error(`ntfy: publishing recovered (topic=${topic})`)
      }
    }
  }
}

function statusClass(status: number): string {
  if (status === 401 || status === 403) return "auth"
  if (status >= 400 && status < 500) return "client"
  return "server"
}

function statusHint(status: number): string {
  if (status === 401 || status === 403)
    return " — check token (ntfy token) or allow anonymous publishing on your server"
  if (status === 404) return " — check serverUrl (is the ntfy server reachable at that path?)"
  return ""
}
