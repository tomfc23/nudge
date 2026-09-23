import { standalone } from "../src/standalone"

export default function (pi: any) {
  let app: Awaited<ReturnType<typeof standalone>>
  let lastText = ""
  pi.on("agent_start", () => { lastText = "" })
  pi.on("session_start", async (_event: any, ctx: any) => { app = await standalone(ctx.cwd, "Pi") })
  pi.on("message_end", (event: any) => {
    if (event.message?.role === "assistant" && event.message.stopReason === "error") {
      app?.error("Pi run failed")
      lastText = ""
      return
    }
    if (event.message?.role === "assistant" && event.message.stopReason !== "aborted") lastText = (event.message.content || [])
      .filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
  })
  pi.on("tool_result", (event: any) => {
    if (event.isError) app?.error(`${event.toolName || "tool"} failed`)
  })
  pi.on("agent_settled", async () => { if (lastText) await app?.done(lastText); lastText = "" })
  pi.registerTool({
    name: "ntfy_notify",
    label: "ntfy notify",
    description: "Send a custom push notification to the user's phone via ntfy.",
    parameters: { type: "object", properties: { message: { type: "string" }, title: { type: "string" },
      priority: { type: "string", enum: ["min", "low", "default", "high", "urgent"] },
      tags: { type: "array", items: { type: "string" } }, topic: { type: "string" } }, required: ["message"], additionalProperties: false },
    execute: async (_id: string, input: { message: string; title?: string; priority?: string; tags?: string[]; topic?: string }) => {
      if (!app || typeof input?.message !== "string" || !input.message.trim()) return { content: [{ type: "text", text: "ntfy is not configured or message is empty." }], details: undefined }
      await app.custom(input)
      return { content: [{ type: "text", text: "Notification sent." }], details: undefined }
    },
  })
}
