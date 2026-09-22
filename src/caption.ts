/**
 * Notification caption builders — "Direction 3, hybrid" (SPEC.md §6.4):
 * structured facts first; one extracted sentence only where the text IS the
 * payload (questions). Captions target the iOS lock screen: ~160-200 chars
 * max, never cut mid-word, no markdown noise — the notification must be
 * valuable without opening anything.
 */

import { DEFAULT_QUESTION_PATTERNS, preprocess } from "./classify"

/** Strip markdown headers/bullets (preprocess already handles emphasis/code/urls) + collapse whitespace. */
export function cleanText(text: string): string {
  return preprocess(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Hard cap at a word boundary with an ellipsis (never mid-word). */
export function truncateAt(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(" ")
  const kept = space > max * 0.5 ? cut.slice(0, space) : cut
  return kept.replace(/[\s,;:.—-]+$/, "") + "…"
}

/**
 * Question captions: the QUESTION, not the recap around it.
 * 1) trailing-? rule → the last sentence ending in "?"
 * 2) pattern rule → the first sentence matching any question pattern
 * 3) fallback → the first sentence
 */
export function questionCaption(text: string, patterns?: readonly string[]): string {
  const clean = cleanText(text)
  if (!clean) return "The agent is waiting for your input."
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean)

  const withQuestionMark = [...sentences].reverse().find((s) => s.endsWith("?"))
  if (withQuestionMark) return truncateAt(withQuestionMark, 160)

  const list = patterns && patterns.length > 0 ? patterns : DEFAULT_QUESTION_PATTERNS
  for (const sentence of sentences) {
    for (const pattern of list) {
      let re: RegExp
      try {
        re = new RegExp(pattern, "i")
      } catch {
        continue
      }
      if (re.test(sentence)) return truncateAt(sentence, 160)
    }
  }
  return truncateAt(sentences[0] ?? clean, 160)
}

export interface TurnStats {
  /** Set by session.execution.started; absent when the watcher started mid-turn. */
  startedAt?: number
  endedAt: number
  tools: number
  failed: number
}

export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** Finished captions are pure telemetry — no message text at all. */
export function finishedCaption(stats?: TurnStats | null): string {
  const parts: string[] = []
  if (stats?.startedAt !== undefined) parts.push(`Done in ${formatDuration(stats.endedAt - stats.startedAt)}`)
  if (stats && stats.tools > 0) parts.push(`${stats.tools} tool${stats.tools === 1 ? "" : "s"}`)
  if (stats && stats.failed > 0) parts.push(`${stats.failed} failed`)
  return parts.length > 0 ? parts.join(" · ") : "Agent finished its turn."
}

/** Error captions: who failed + the first line of why (errors are multi-line). */
export function errorCaption(scope: "tool" | "session", tool: string | undefined, raw: string): string {
  const firstLine = String(raw ?? "").split("\n")[0]?.trim() || "unknown error"
  const who = scope === "tool" ? `${tool || "Tool"} failed` : "Session failed"
  return `${who} · ${truncateAt(firstLine, 160)}`
}

/** Permission captions: the structured ask, exactly as the event carries it. */
export function permissionCaption(action?: string, resources?: unknown, message?: string): string {
  const list = Array.isArray(resources) ? resources.map(String).filter(Boolean) : []
  const base = [action, ...list].filter(Boolean).join(" · ")
  const withMessage = message ? (base ? `${base} — ${message}` : message) : base
  return withMessage || "The agent needs permission to continue."
}

interface FormFieldLike {
  key?: string
  title?: string
  type?: string
  hidden?: boolean
  options?: Array<{ label?: string; value?: string }>
}

function formatField(field: FormFieldLike): string {
  const label = cleanText(String(field.title ?? field.key ?? ""))
  if (!label) return ""
  if (field.type === "boolean") return `${label}: yes | no`
  if (Array.isArray(field.options) && field.options.length > 0) {
    const options = field.options.map((o) => String(o?.label ?? o?.value ?? "")).filter(Boolean)
    const shown = options.slice(0, 4).join(" | ")
    return `${label}: ${shown}${options.length > 4 ? " …" : ""}`
  }
  return label
}

/** Form captions: the form title + visible field labels with their choices. */
export function formCaption(title?: string, fields?: unknown): string {
  const base = (title ? cleanText(title) : "") || "The agent asked you a question."
  const list = Array.isArray(fields) ? (fields as FormFieldLike[]) : []
  const rendered = list
    .filter((f) => f && f.hidden !== true)
    .slice(0, 4)
    .map(formatField)
    .filter(Boolean)
  return truncateAt([base, ...rendered].join(" · "), 200)
}
