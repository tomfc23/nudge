import { standalone } from "../src/standalone"

export default async function (cmd: any) {
  const app = await standalone(cmd.cwd, "Command Code")
  if (!app) return
  cmd.hooks({ onRunEnd: async ({ result }: any) => {
    if (!["interrupted", "permission_denied"].includes(result?.stopReason)) await app.done(result?.finalText || "")
  } })
  cmd.on("tool_denied", (event: any) => app.permission(`${event.toolName || "Tool"} was denied`, "Permission denied"))
  cmd.on("tool_errored", (event: any) => app.error(String(event.error || event.toolName || "tool failed")))
  cmd.on("run_error", (event: any) => app.error(String(event.error?.message || event.error || "run failed")))
  cmd.addTool({
    schema: {
      name: "ntfy_notify",
      description: "Send a custom push notification to the user's phone via ntfy.",
      input_schema: { type: "object", properties: { message: { type: "string" }, title: { type: "string" },
        priority: { type: "string", enum: ["min", "low", "default", "high", "urgent"] },
        tags: { type: "array", items: { type: "string" } }, topic: { type: "string" } }, required: ["message"] },
    },
    run: async ({ input }: any) => {
      if (typeof input?.message !== "string" || !input.message.trim()) return { ok: false, error: "message is required" }
      await app.custom(input)
      return { ok: true, content: [{ type: "text", text: "Notification sent." }] }
    },
  })
}
