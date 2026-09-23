/**
 * The `ntfy_notify` tool (SPEC.md §8) so the agent can send custom
 * notifications: message required; title / priority / tags / topic optional.
 */

import { priorityValue, type Config } from "./config"
import type { Notifier } from "./publish"

interface ToolEditorLike {
  namespace(namespace: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options?: { namespace?: string; codemode?: boolean }
    execute: (
      input: any,
      context: { signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> },
    ) => Promise<{ content?: string }>
  }): void
}

export interface ToolDeps {
  tool: {
    transform(callback: (editor: ToolEditorLike) => void): Promise<{ dispose(): Promise<void> }>
  }
}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/
const PRIORITY_VALUES = ["min", "low", "default", "high", "urgent"]

interface NotifyInput {
  message: string
  title?: string
  priority?: string
  tags?: string[]
  topic?: string
}

export async function registerTool(ctx: ToolDeps, notifier: Notifier, config: Config): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "ntfy",
      description: "Send push notifications to the user's phone via ntfy",
    })
    editor.add({
      name: "notify",
      description:
        "Send a push notification to the user's ntfy app. Use for custom alerts the built-in " +
        "events do not cover (e.g. long task milestones, deploy done, needs review). " +
        "Pings the user's phone, so only use it when their attention is actually useful.",
      input: {
        type: "object",
        properties: {
          message: { type: "string", description: "Notification body (required)" },
          title: { type: "string", description: "Notification title" },
          priority: {
            type: "string",
            enum: PRIORITY_VALUES,
            description: "Notification priority/urgency (default: ntfy default)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "ntfy tags/emoji shortcodes, e.g. ['rocket','tada']",
          },
          topic: {
            type: "string",
            description: "Optional topic override; defaults to the plugin's topic",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      options: { namespace: "ntfy" },
      execute: async (input: NotifyInput) => {
        if (!input?.message || typeof input.message !== "string") {
          return { content: "Failed: 'message' is required." }
        }
        if (input.topic !== undefined && !TOPIC_RE.test(input.topic)) {
          return {
            content: `Failed: invalid topic "${input.topic}" (allowed: letters, digits, "-", "_", max 64 chars).`,
          }
        }
        if (input.priority !== undefined && !PRIORITY_VALUES.includes(input.priority)) {
          return { content: `Failed: invalid priority "${input.priority}".` }
        }
        const priority = priorityValue(input.priority)
        try {
          await notifier.custom({
            message: input.message,
            title: `OpenCode · ${input.title ?? "ntfy"}`,
            ...(priority !== undefined ? { priority } : {}),
            ...(input.tags ? { tags: input.tags } : {}),
            ...(input.topic ? { topic: input.topic } : {}),
          })
          return { content: `Notification sent to topic "${input.topic ?? config.topic}".` }
        } catch (error) {
          return { content: `Failed to send notification: ${(error as Error)?.message ?? error}` }
        }
      },
    })
  })
}
