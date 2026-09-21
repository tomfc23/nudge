/**
 * Manual smoke test: resolve config (incl. {env:NAME} token) and publish one
 * notification to a local capture server. Start capture.mjs first.
 */
import { readConfig } from "../src/config"
import { Notifier } from "../src/publish"

async function main() {
  const storage = { get: async () => undefined, set: async () => {} }
  const { config, info, problems } = await readConfig(
    { serverUrl: "http://127.0.0.1:9876", token: "{env:SMOKE_TOK}" },
    storage,
  )
  console.log("[ntfy] " + info.join("\n[ntfy] "))
  if (problems.length) console.log("[ntfy] problems:", problems)
  if (!config) return
  const n = new Notifier(config)
  await n.custom({ message: "smoke: agent finished the deploy", title: "smoke-test" })
  await new Promise((r) => setTimeout(r, 300))
}

await main()
