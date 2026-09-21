/**
 * Event-stream watchers (SPEC.md §6). All triggers are structured V2 events:
 *   permission.asked / form.created  → question notifications
 *   session.text.ended               → capture final assistant message text
 *   session.idle + session outcome   → classify question vs finished (§6.1)
 *   session.execution.failed /
 *   session.tool.failed              → error notifications (cooldown §6.3)
 */

import { classify, excerpt } from "./classify"
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

export async function watchEvents(
  ctx: EventsDeps,
  notifier: Notifier,
  config: Config,
  signal: AbortSignal,
): Promise<void> {
  const texts = new Map<string, TextState>()

  const titleOf = async (sessionID: string): Promise<string> => {
    try {
      const info = await ctx.session.get({ sessionID })
      if (info?.title) return info.title
    } catch {
      // Session may live in another location; fall through to a stable fallback.
    }
    return `session …${sessionID.slice(-6)}`
  }

  const onText = (data: { sessionID: string; assistantMessageID: string; text: string }): void => {
    const state = texts.get(data.sessionID)
    if (state && state.messageID === data.assistantMessageID) {
      state.parts.push(data.text)
    } else {
      texts.set(data.sessionID, { messageID: data.assistantMessageID, parts: [data.text] })
    }
  }

  const onIdle = async (sessionID: string): Promise<void> => {
    const state = texts.get(sessionID)
    const turnText = state ? state.parts.join("\n") : ""
    texts.delete(sessionID)

    let outcome = "succeeded"
    let title = ""
    try {
      const info = await ctx.session.get({ sessionID })
      outcome = info?.outcome ?? "succeeded"
      title = info?.title ?? ""
    } catch {
      /* fallback below */
    }

    // Interrupted turns: the user stopped it — not a completion worth pinging.
    // Failed turns: session.execution.failed already produced an error ping.
    if (outcome === "interrupted" || outcome === "failed") return
    if (!title) title = await titleOf(sessionID)

    const q = config.events.question
    const f = config.events.finished

    if (classify(turnText, q.idleMode, q.patterns) === "question") {
      if (q.enabled) {
        notifier.notify("question", sessionID, {
          title: `Question: ${title}`,
          message: excerpt(turnText, 300) || "The agent is waiting for your input.",
        })
      } else if (f.enabled) {
        // SPEC.md §6.1: classified question but questions disabled → fall back to finished.
        notifier.notify("finished", sessionID, {
          title: `Finished: ${title}`,
          message: excerpt(turnText, 240) || "Agent finished its turn.",
        })
      }
      return
    }

    if (f.enabled) {
      notifier.notify("finished", sessionID, {
        title: `Finished: ${title}`,
        message: excerpt(turnText, 240) || "Agent finished its turn.",
      })
    }
  }

  const onError = (sessionID: string, error: StructuredError, prefix: string): void => {
    void titleOf(sessionID).then((title) => {
      notifier.notify("error", sessionID, {
        title: `Error: ${title}`,
        message: `${prefix}${excerpt(error?.message ?? "unknown error", 200)}`,
      })
    })
  }

  try {
    for await (const raw of ctx.event.subscribe({ signal })) {
      const event = raw as { type?: string; data?: any }
      switch (event.type) {
        case "session.text.ended":
          onText(event.data)
          break

        case "session.idle":
          await onIdle(event.data?.sessionID)
          break

        case "permission.asked": {
          const d = event.data
          if (!d?.sessionID) break
          const resources = Array.isArray(d.resources) ? d.resources.join(", ") : ""
          const detail = [`${d.action}`, resources, d.message].filter(Boolean).join(" — ")
          void titleOf(d.sessionID).then((title) => {
            notifier.notify("question", d.sessionID, {
              title: `Permission needed: ${title}`,
              message: detail || "The agent needs permission to continue.",
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
              message: excerpt(form.title || "The agent asked you a question.", 300),
            })
          })
          break
        }

        case "session.execution.failed":
          if (event.data?.sessionID) onError(event.data.sessionID, event.data.error, "Session error: ")
          break

        case "session.tool.failed":
          if (event.data?.sessionID) onError(event.data.sessionID, event.data.error, "Tool failed: ")
          break

        default:
          break
      }
    }
  } catch (error) {
    if (!signal.aborted) log(`event stream stopped: ${(error as Error)?.message ?? error}`)
  }
}
