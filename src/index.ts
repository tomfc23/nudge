/**
 * opencode-ntfy — notifications from OpenCode to a self-hosted ntfy server.
 * Entry point: see README.md for setup, SPEC.md for the design.
 */

import { Plugin } from "@opencode/plugin"
import { readConfig } from "./config"
import { watchEvents } from "./events"
import { Notifier } from "./publish"
import { registerTool } from "./tool"

const log = (message: string) => console.error(`[ntfy] ${message}`)

export default Plugin.define({
  id: "ntfy",
  async setup(ctx) {
    const { config, problems, info } = await readConfig(ctx.options, ctx.storage)

    for (const problem of problems) log(`setup incomplete: ${problem}`)
    if (!config) return

    for (const line of info) log(line)

    const notifier = new Notifier(config)
    const controller = new AbortController()

    // Fire the event watcher; it stops when the plugin unloads.
    void watchEvents(ctx, notifier, config, controller.signal)

    // Custom notifications from the agent.
    await registerTool(ctx, notifier, config)

    return () => {
      controller.abort()
    }
  },
})
