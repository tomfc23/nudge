# opencode-ntfy

Get [ntfy](https://ntfy.sh) push notifications on your phone when [OpenCode](https://opencode.ai)
needs you — **questions & permission requests**, **finished tasks**, and **errors** — plus an
`ntfy_notify` tool so the agent itself can ping you.

Works with your **self-hosted ntfy server** and the official **ntfy iOS/Android app**.

## Quick start (5 minutes)

### 1. Run an ntfy server

> ntfy has no native macOS server — use Docker:

```bash
mkdir ntfy && cd ntfy
cat > docker-compose.yml <<'EOF'
services:
  ntfy:
    image: binwiederhier/ntfy
    command: serve
    ports: ["80:80"]
    environment:
      NTFY_BASE_URL: http://your-server-ip
      NTFY_BEHIND_PROXY: true
    volumes:
      - ./cache:/var/cache/ntfy
      - ./etc:/etc/ntfy
    restart: unless-stopped
EOF
docker compose up -d
```

Sanity check: `curl http://localhost:80/v1/health` → `{"health":"healthy"}`.

### 2. Add the plugin

Add the plugin to your project's `opencode.json` (or `~/.config/opencode/opencode.json` to use
it in every project):

```json
{
  "plugins": [
    { "package": "/path/to/opencode-ntfy", "options": { "serverUrl": "http://your-server-ip" } }
  ]
}
```

`serverUrl` (or `NTFY_SERVER_URL`) is the **only** required setting — topics are generated and
persisted automatically on first run.

> **No config entry needed?** Drop a one-line file into a plugins directory and configure via
> environment variables instead:
>
> ```bash
> mkdir -p .opencode/plugins        # or ~/.config/opencode/plugins (applies everywhere)
> printf 'export { default } from "/path/to/opencode-ntfy/index.ts"\n' > .opencode/plugins/ntfy.ts
> export NTFY_SERVER_URL=http://your-server-ip
> ```

> ⚠️ **Do not run `opencode plugin add opencode-ntfy`** — a *different* plugin by another author
> exists on npm under that name. Install from your local checkout as shown above.
>
> Both config spellings work on OpenCode v2: `plugins: [{ package, options }]` (docs form, shown
> above) and `plugin: [["/path", { …options }]]` (tuple form from the config schema).

### 3. Subscribe on your phone

1. Install the **ntfy** app ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / Android).
2. Add your server URL (Settings → default server), or use `ntfy.sh` for a hosted try-out.
3. Start OpenCode once and look for the startup log:

```
[ntfy] server: http://your-server-ip
[ntfy] subscribe in your ntfy app → server http://your-server-ip , topics: question=opencode-1a2b3c4d5e-question finished=opencode-1a2b3c4d5e-finished error=opencode-1a2b3c4d5e-error custom=opencode-1a2b3c4d5e-custom
```

4. Subscribe to those four topics in the app (topic = the random-looking name; anyone who knows
   it can read it, which is why it has an unguessable suffix).

> **iOS background delivery:** set `upstream-base-url: "https://ntfy.sh"` on your ntfy server
> (see next section). Your server then forwards a tiny wake-up signal (message ID only — never
> the content) to ntfy.sh, which pushes to your phone via Firebase/APNS. This is ntfy's
> official mechanism for self-hosted + iOS, and it is verified working: notifications land on
> the lock screen even with the app closed.

### 4. iOS instant push + public access (recommended)

Three one-liners make the setup work from anywhere, delivered instantly even with the app
backgrounded — this is the exact configuration this plugin was developed and verified against:

```yaml
# ~/ntfy/etc/server.yml
base-url: "https://ntfy.yourdomain.com"     # your public URL
auth-file: "/var/cache/ntfy/user.db"        # enable auth ...
auth-default-access: "read-only"            # ... anonymous may SUBSCRIBE, but NOT publish
upstream-base-url: "https://ntfy.sh"         # iOS background push via APNS (content never leaves your server)
```

Then create a user + token for the plugin (the phone needs no credentials — it only subscribes):

```bash
NTFY_PASSWORD=... docker compose exec -T ntfy ntfy user add --role=admin you
docker compose exec -T ntfy ntfy token add you   # → put in "token" below
```

**Publishing auth** (required once `auth-default-access` is not `read-write`):

```json
"options": { "serverUrl": "https://ntfy.yourdomain.com", "token": "tk_..." }
```

`token` accepts a literal, `"{env:NAME}"`, or the `NTFY_TOKEN` env var. If publishing returns
`401/403`, the log tells you exactly this.

**Remote access** — expose the server with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel create ntfy
# ~/.cloudflared/config.yml → hostname ntfy.yourdomain.com → service http://localhost:80
cloudflared tunnel route dns ntfy ntfy.yourdomain.com
cloudflared tunnel run ntfy       # persist via a launchd LaunchAgent (RunAtLoad + KeepAlive)
```

Any reverse proxy (nginx/Caddy/Tailscale Funnel) works the same; plain LAN IP also works if
you only ever need notifications on your own Wi-Fi.

### 5. Test it

Ask the agent: *"send me an ntfy test notification"* — it will use the `ntfy_notify` tool.

## What you get

| Event | Trigger | Default topic | Default priority |
|---|---|---|---|
| **Question** | Permission request, form, or the agent ends its turn asking you something (`?` or "should I…" phrasing) | `…-question` | urgent (5) |
| **Finished** | Turn completes without a question | `…-finished` | default (3) |
| **Error** | Session/tool execution error (60 s cooldown per session) | `…-error` | high (4) |
| **Custom** | Agent calls `ntfy_notify` | `…-custom` | as requested |

Dedupe: a question suppresses a “finished” within 10 s (so you never get two pings for one
moment), never the other way around.

## Configuration

All keys are optional — defaults shown:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-ntfy",
      "options": {
        "serverUrl": "http://your-server-ip",
        "token": "{env:NTFY_TOKEN}",
        "baseTopic": "opencode-mytopic",

        "events": {
          "question": { "enabled": true, "priority": "urgent", "tags": ["question"],
                        "idleMode": "heuristic", "patterns": ["\\\\bshould i\\\\b", "…"] },
          "finished": { "enabled": true, "priority": "default", "tags": ["heavy_check_mark"] },
          "error":    { "enabled": true, "priority": "high", "tags": ["rotating_light"], "cooldownSec": 60 }
        },
        "topics": { "question": "custom-topic-name" },

        "dedupeWindowMs": 10000,
        "publishTimeoutMs": 5000,
        "failureLogIntervalMs": 600000
      }
    }
  ]
}
```

- **`serverUrl`** – ntfy server base URL (also `NTFY_SERVER_URL` / `NTFY_BASE_URL` env).
  Unset → plugin stays quiet and logs how to fix it.
- **`token`** – literal, `{env:NAME}`, or `NTFY_TOKEN` env. No token → anonymous publishing
  (fine for auth-disabled servers).
- **`baseTopic`** – auto-generated once and persisted on first run if unset; the four topics
  are `{base}-question|finished|error|custom`.
- **`events.*.priority`** – `min|low|default|high|urgent` or `1`–`5`.
- **`events.question.idleMode`** – how a plain turn-end is classified:
  - `"heuristic"` (default): trailing `?` or a question phrase anywhere → question.
  - `"always"`: every turn-end is a question ping. `"off"`: never.
- **`events.question.patterns`** – replaces the built-in phrase list (case-insensitive regexes).
- **`topics.*`** – override individual topic names.

## The `ntfy_notify` tool

The agent can ping you directly:

> *ntfy_notify(message, title?, priority?, tags?, topic?)*

`message` is required; the rest optional. `topic` must be letters/digits/`-`/`_` (≤ 64 chars).
It skips the dedupe rules (deliberate sends always go through).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[ntfy] setup incomplete: no ntfy server configured…` | Set `serverUrl` or `NTFY_SERVER_URL`. |
| `publish … failed: HTTP 401/403` | Token missing/wrong — set `NTFY_TOKEN`, or allow anonymous publishing on the server. |
| `publish … failed: HTTP 404` | `serverUrl` wrong or reverse-proxy path missing. |
| Nothing on iOS while backgrounded | Set `upstream-base-url: "https://ntfy.sh"` on the server (iOS instant push requires it; verified working). Foreground test first. |
| Notification never sent, no error | Check event isn't disabled or deduped — set `failureLogIntervalMs` logs are rate-limited by design. |
| Repeated failures spam logs | First failure logs, repeats log at most every `failureLogIntervalMs` (default 10 min) per topic. |

## Development

```bash
npm install
npm run typecheck
npm test          # 26 tests: classifier, config/token chain, end-to-end event→publish flow
```

Design rationale and decision log: [SPEC.md](./SPEC.md).
