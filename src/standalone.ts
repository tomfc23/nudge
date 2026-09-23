import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { finishedCaption, questionCaption } from "./caption"
import { classify } from "./classify"
import { priorityValue, readConfig } from "./config"
import { Notifier } from "./publish"

export async function standalone(cwd: string, harness: string) {
  const projectKey = createHash("sha256").update(cwd).digest("hex")
  const file = process.env.NTFY_CONFIG_FILE || [join(homedir(), ".config/ntfy-archive/projects", `${projectKey}.json`), join(homedir(), ".config/ntfy-archive/config.json")]
    .find((path) => { try { readFileSync(path); return true } catch { return false } })
  if (!file) return
  try {
    const options = JSON.parse(readFileSync(file, "utf8"))
    const { config, problems } = await readConfig(options, {
      async get() { return undefined },
      async set() {},
    })
    if (!config) throw new Error(problems.join("; "))
    const notifier = new Notifier(config)
    const title = basename(cwd) || harness
    const session = `${harness}:${cwd}`
    return {
      config,
      notifier,
      custom(input: { message: string; title?: string; priority?: string; tags?: string[]; topic?: string }) {
        if (typeof input?.message !== "string" || !input.message.trim()) throw new Error("message is required")
        if (input.topic && !/^[A-Za-z0-9_-]{1,64}$/.test(input.topic)) throw new Error("invalid topic")
        if (input.priority && !["min", "low", "default", "high", "urgent"].includes(input.priority)) throw new Error("invalid priority")
        if (input.tags && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string"))) throw new Error("invalid tags")
        return notifier.custom({ title: input.title || "ntfy", message: input.message, topic: input.topic,
          priority: priorityValue(input.priority), tags: input.tags })
      },
      done(text: string) {
        const verdict = classify(text, config.events.question.idleMode, config.events.question.patterns)
        if (verdict === "question" && config.events.question.enabled) {
          return notifier.notify("question", session, { title: `Question: ${title}`, message: questionCaption(text, config.events.question.patterns) })
        } else {
          return notifier.notify("finished", session, { title: `Finished: ${title}`, message: finishedCaption() })
        }
      },
      error(message: string) {
        return notifier.notify("error", session, { title: `Error: ${title}`, message: message.slice(0, 180) })
      },
      permission(message: string, label = "Permission needed") {
        return notifier.notify("permission", session, { title: `${label}: ${title}`, message: message.slice(0, 180) })
      },
    }
  } catch (error) {
    console.error(`[ntfy] ${harness}: ${String(error)}`)
  }
}
