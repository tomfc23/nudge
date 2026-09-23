/**
 * Event-stream watchers (SPEC.md §6). All triggers are structured V2 events:
 *   permission.asked                → permission notifications (blocked agent)
 *   form.created                    → question notifications
 *   session.text.ended              → capture final assistant message text
 *   session.execution.succeeded     → turn boundary: classify question vs
 *     finished (§6.1; session.idle kept as forward-compat secondary — the
 *     server never emits it, verified live)
 *   session.execution.started /
 *   session.tool.*                  → per-turn telemetry for captions (§6.4)
 *   session.execution.failed /
 *   session.tool.failed             → error notifications (cooldown §6.3)
 */

import {
  errorCaption,
  finishedCaption,
  formCaption,
  permissionCaption,
  questionCaption,
  type TurnStats,
} from "./caption"
import { classify } from "./classify"
import type { Config } from "./config"
import type { Notifier } from "./publish"

/** Minimal structural view of the plugin context pieces we use (testable fakes). */
export interface EventsDeps {
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
  session: {
    get(input: { sessionID: string }): Promise<{ title?: string; outcome?: string }>
  }
}

interface StructuredError {
  type: string
  message: string
  status?: number
}

interface TextState {
  messageID: string
  parts: string[]
}

const log = (message: string) => console.error(`[ntfy] ${message}`)

// TEMP DIAGNOSTIC — raw event recorder for the session.idle audit. NOT FOR COMMIT.
import { appendFileSync, existsSync } from "node:fs"
const DEBUG_DIR = "/private/var/folders/jj/n6st40c550z6plwykymq65sc0000gn/T/opencode"
const dlog = (message: string): void => {
  try {
    if (!existsSync(`${DEBUG_DIR}/ntfy-events.enable`)) return
    appendFileSync(`${DEBUG_DIR}/ntfy-events.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* diagnostics only */
  }
}

export async function watchEvents(
  ctx: EventsDeps,
  notifier: Notifier,
  config: Config,
  signal: AbortSignal,
): Promise<void> {
  const texts = new Map<string, TextState>()
  const deltaCounts: Record<string, number> = {}
  // Direction 3 telemetry: per-turn stats (duration/tool counts) + tool-call
  // id → name registry (tool.failed carries the id, not the name).
  const turns = new Map<string, TurnStats>()
  const pendingToolNames = new Map<string, string>()
  dlog("watcher started (armed)")

  const titleOf = async (sessionID: string): Promise<string> => {
    try {
      const info = await ctx.session.get({ sessionID })
      if (info?.title) return `OpenCode · ${info.title}`
    } catch {
      // Session may live in another location; fall through to a stable fallback.
    }
    return `OpenCode · session …${sessionID.slice(-6)}`
  }

  const ensureTurn = (sessionID: string): TurnStats => {
    let turn = turns.get(sessionID)
    if (!turn) {
      turn = { endedAt: Date.now(), tools: 0, failed: 0 }
      turns.set(sessionID, turn)
    }
    return turn
  }

  const onText = (data: { sessionID: string; assistantMessageID: string; text: string }): void => {
    dlog(`text.ended sid=${data.sessionID} len=${data.text.length} msg=${data.assistantMessageID.slice(-6)}`)
    const state = texts.get(data.sessionID)
    if (state && state.messageID === data.assistantMessageID) {
      state.parts.push(data.text)
    } else {
      texts.set(data.sessionID, { messageID: data.assistantMessageID, parts: [data.text] })
    }
  }

  const onIdle = async (sessionID: string): Promise<void> => {
    dlog(`idle enter sid=${sessionID} deltas=${JSON.stringify(deltaCounts)}`)
    const state = texts.get(sessionID)
    const turnText = state ? state.parts.join("\n") : ""
    texts.delete(sessionID)
    const stats = turns.get(sessionID)
    turns.delete(sessionID)
    const ended: TurnStats | undefined = stats ? { ...stats, endedAt: Date.now() } : undefined
    dlog(`idle text turnLen=${turnText.length} parts=${state ? state.parts.length : 0}`)

    let outcome = "succeeded"
    let title = ""
    try {
      const info = await ctx.session.get({ sessionID })
      outcome = info?.outcome ?? "succeeded"
      title = info?.title ? `OpenCode · ${info.title}` : ""
    } catch {
      /* fallback below */
    }

    // Interrupted turns: the user stopped it — not a completion worth pinging.
    // Failed turns: session.execution.failed already produced an error ping.
    dlog(`idle outcome=${outcome} titleLen=${title.length}`)
    if (outcome === "interrupted" || outcome === "failed") {
      dlog(`idle skip: outcome=${outcome}`)
      return
    }
    if (!title) title = await titleOf(sessionID)

    const q = config.events.question
    const f = config.events.finished

    const verdict = classify(turnText, q.idleMode, q.patterns)
    dlog(`idle classify=${verdict} q.enabled=${q.enabled} f.enabled=${f.enabled} idleMode=${q.idleMode}`)
    if (verdict === "question") {
      if (q.enabled) {
        dlog("notify question (boundary)")
        notifier.notify("question", sessionID, {
          title: `Question: ${title}`,
          message: questionCaption(turnText, q.patterns),
        })
      } else if (f.enabled) {
        // SPEC.md §6.1: classified question but questions disabled → fall back to finished.
        dlog("notify finished (question-fallback)")
        notifier.notify("finished", sessionID, {
          title: `Finished: ${title}`,
          message: finishedCaption(ended),
        })
      } else {
        dlog("idle question: both disabled -> no notify")
      }
      return
    }

    if (f.enabled) {
      dlog("notify finished")
      notifier.notify("finished", sessionID, {
        title: `Finished: ${title}`,
        message: finishedCaption(ended),
      })
    } else {
      dlog("idle finished: disabled -> no notify")
    }
  }

  const onError = (sessionID: string, error: StructuredError, scope: "tool" | "session", tool?: string): void => {
    void titleOf(sessionID).then((title) => {
      notifier.notify("error", sessionID, {
        title: `Error: ${title}`,
        message: errorCaption(scope, tool, error?.message ?? "unknown error"),
      })
    })
  }

  try {
    for await (const raw of ctx.event.subscribe({ signal })) {
      const event = raw as { type?: string; data?: any }
      const sid = event.data?.sessionID ?? event.data?.form?.sessionID ?? ""
      if (event.type?.endsWith(".delta")) deltaCounts[event.type] = (deltaCounts[event.type] ?? 0) + 1
      else dlog(`recv ${event.type}${sid ? ` sid=${sid}` : ""}`)
      switch (event.type) {
        case "session.text.ended":
          onText(event.data)
          break

        case "session.execution.started":
          if (event.data?.sessionID) {
            turns.set(event.data.sessionID, { startedAt: Date.now(), endedAt: Date.now(), tools: 0, failed: 0 })
          }
          break

        case "session.tool.input.started":
          if (event.data?.id && event.data?.name) {
            pendingToolNames.set(String(event.data.id), String(event.data.name))
            if (pendingToolNames.size > 1000) pendingToolNames.clear()
          }
          break

        case "session.tool.called":
          if (event.data?.sessionID) ensureTurn(event.data.sessionID).tools += 1
          break

        case "session.tool.success":
          if (event.data?.id) pendingToolNames.delete(String(event.data.id))
          break

        case "session.idle":
        case "session.execution.succeeded":
          // session.idle exists in the V2Event union but the server never emits it
          // (verified live: watcher received session.text.ended + execution.succeeded
          // at the same boundary, zero session.idle). Turn completion arrives as
          // session.execution.succeeded with payload { sessionID } — same shape, same
          // moment (42ms after the final text.ended). The idle case stays as a
          // forward-compat secondary trigger; dedupe collapses both if ever co-emitted.
          dlog(`boundary ${event.type} sid=${event.data?.sessionID ?? "(missing)"}`)
          await onIdle(event.data?.sessionID)
          break

        case "permission.asked": {
          const d = event.data
          if (!d?.sessionID) break
          // Its own kind: a permission ask means the agent is BLOCKED waiting on
          // the user — urgent priority, distinct tag, independent enable toggle.
          void titleOf(d.sessionID).then((title) => {
            notifier.notify("permission", d.sessionID, {
              title: `Permission needed: ${title}`,
              message: permissionCaption(d.action, d.resources, d.message),
            })
          })
          break
        }

        case "form.created": {
          const form = event.data?.form
          if (!form?.sessionID) break
          void titleOf(form.sessionID).then((title) => {
            notifier.notify("question", form.sessionID, {
              title: `Question: ${title}`,
              message: formCaption(form.title, form.fields),
            })
          })
          break
        }

        case "session.execution.failed":
          if (event.data?.sessionID) onError(event.data.sessionID, event.data.error, "session")
          break

        case "session.tool.failed": {
          const d = event.data
          if (!d?.sessionID) break
          const toolName = d.id ? pendingToolNames.get(String(d.id)) : undefined
          if (d.id) pendingToolNames.delete(String(d.id))
          ensureTurn(d.sessionID).failed += 1
          onError(d.sessionID, d.error, "tool", toolName)
          break
        }

        default:
          break
      }
    }
  } catch (error) {
    const msg = (error as Error)?.message ?? String(error)
    if (!signal.aborted) log(`event stream stopped: ${msg}`)
    dlog(`stream stopped: ${msg} (aborted=${signal.aborted})`)
  }
}
