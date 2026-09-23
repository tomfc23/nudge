# Nudge

# Nudge sends [ntfy](https://ntfy.sh) push notifications from [OpenCode](https://opencode.ai) and Codex
to your phone. OpenCode alerts you when it
needs you — **questions & permission requests**, **finished tasks**, and **errors** — plus an
`ntfy_notify` tool so the agent itself can ping you.

Works with your **self-hosted ntfy server** and the official **ntfy iOS/Android app**.

## Install OpenCode, Codex, or both

Run `sh install.sh` from a checkout, or download it from `https://nudge.tommyek.com/install.sh`.
The wizard asks which agents to configure; `NTFY_HARNESSES=both|opencode|codex` selects one non-interactively.
Both agents share one server and phone topic. For Codex, the installer adds `Stop` and
`PermissionRequest` entries to your existing `~/.codex/hooks.json` (or the current
project's `.codex/hooks.json`) and stores the ntfy token in a mode-0600 `nudge.json`.
Open Codex's `/hooks` screen once to review and trust the new hooks. Codex requires
this for [non-managed hooks](https://developers.openai.com/codex/hooks); until trusted,
Codex skips them. Existing hooks and the `notify` command stay in place.

Codex currently sends **finished**, **question** (when its final reply asks one), and
**permission** notifications. OpenCode also supports tool/session **errors** and the
`ntfy_notify` custom tool. Codex's hook data does not provide the same OpenCode event
stream, so these latter two features are OpenCode-only.

## OpenCode manual setup

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

`serverUrl` (or `NTFY_SERVER_URL`) is the **only** required setting — a single topic is
generated and persisted automatically on first run.

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
[ntfy] subscribe in your ntfy app → server http://your-server-ip , topic: opencode-1a2b3c4d5e
```

4. Subscribe to that one topic in the app (the topic = the random-looking name; anyone who
   knows it can read it, which is why it has an unguessable suffix). Every event kind —
   question, permission, finished, error, custom — arrives on this single topic, distinguished
   by the title prefix, emoji tag, and priority.

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

## Access modes: local / Tailscale / Cloudflare

The plugin talks plain HTTP to whatever `serverUrl` you give it, so all three ways of
reaching a self-hosted ntfy server work out of the box.

**New install? Run the wizard** — download it from the project site, or run it from a checkout:

```bash
curl -fsSL https://nudge.tommyek.com/install.sh -o install.sh && sh install.sh
```

The website serves the plugin archive used by the downloaded installer; no Git checkout is needed.
`sh install.sh` asks which agents to configure, then walks through access mode,
config scope, notifications, and phone. It installs missing tools *with your consent*,
provisions the server, writes the selected agent configs, and sends a test push you confirm on the
phone. Every question has an env override (`NTFY_MODE=cloudflare CF_HOSTNAME=... sh
install.sh`), so an agent can drive the exact same wizard non-interactively — or just
hand [`INSTALL.md`](./INSTALL.md) to your agent and answer its questions in chat.

For a single mode — or full control — one script provisions any of them:

```bash
./scripts/setup-server.sh local        # phone on the same Wi-Fi  → http://192.168.x.x
./scripts/setup-server.sh tailscale    # private tailnet          → https://<machine>.<tailnet>.ts.net
./scripts/setup-server.sh cloudflare   # public via CF Tunnel     → https://ntfy.example.com
./scripts/setup-server.sh preflight [mode]  # readiness check only, makes no changes (--json for machines)
```

The script is **idempotent** — re-run it with another mode to switch (then re-add the
phone subscriptions, which are keyed by server URL). It writes the compose file, enables
auth (anonymous read-only + token), configures iOS instant push, handles the mode extras
(`tailscale serve` proxy / cloudflared tunnel + DNS + launchd persistence), smoke-tests
the result, and prints your exact `opencode.json` snippet.

> **First run on a tailnet?** Tailscale gates `serve` behind a one-time admin
> approval — the script prints the `login.tailscale.com/f/serve` link, waits
> briefly, then tells you to approve it and re-run. Nothing else blocks.

| Mode | Phone needs | Works | Notes |
|---|---|---|---|
| **local** | same Wi-Fi | home only | simplest; plain http fine on a trusted LAN |
| **tailscale** | Tailscale app (enable *Connect on Demand*) | anywhere | private, no public exposure; free `*.ts.net` TLS names |
| **cloudflare** | nothing | anywhere | public URL; keep server auth on (script does) |

**iOS instant push caveat:** the server's `base-url` must equal the URL the phone
subscribes with (the wake-up signal is keyed to `SHA256(base-url + "/" + topic)`).
The script sets this per mode — that's why switching modes means re-subscribing.

The plugin auto-detects the mode from `serverUrl` and prints guidance at startup:

```
[ntfy] access mode: cloudflare — phone reaches the server over the public internet via a tunnel/proxy
[ntfy] hint: works anywhere (cellular, work, travel) — no VPN or same-Wi-Fi needed
```

If detection can't see your intent (e.g. the plugin publishes via `http://127.0.0.1`
while the phone uses a tunnel URL), set `"accessMode": "local" | "tailscale" | "cloudflare"`
explicitly in the options.

## Managing Nudge

Already installed? The `nudge-agent` CLI wraps the scripts above, so you don't have to
remember paths:

```bash
npm install -g nudge-agent      # or: brew tap tomfc23/nudge && brew install nudge-agent
```

| Command | What it does |
|---|---|
| `nudge-agent install` | runs the wizard (same as `sh install.sh`) |
| `nudge-agent status [--json]` | what is wired up right now — per harness, server reachability, and whether Codex has actually *trusted* the hooks |
| `nudge-agent update [--dry-run]` | `git pull` for a checkout, re-runs the installer for an archive install |
| `nudge-agent add <opencode\|codex>` | wires one more harness, copying `serverUrl`/`token`/`topic` from the harness already configured. Asks global or project unless `--global`/`--project` says |
| `nudge-agent remove <opencode\|codex>` | unwires one harness — the other and the server are untouched |
| `nudge-agent uninstall [--level 1\|2\|3]` | delegates to `scripts/uninstall.sh`; level 3 also wipes server data and needs `--yes` |

Exit codes match the scripts (`0` ok · `2` usage/input · `3` missing or partial · `4` conflict
· `5` runtime). The CLI is only a dispatcher — it calls the scripts in the plugin
directory, so `install.sh` / `setup-server.sh` / `uninstall.sh` stay the single
implementation, and nothing but the CLI itself is published anywhere.

By default the installer is fetched from `raw.githubusercontent.com/tomfc23/nudge/main` and the
plugin is cloned from this repo. Set `NTFY_SITE_URL` to use a website's `install.sh` +
`plugin.tar.gz` instead.

## What you get

| Event | Trigger | Caption (what you see without opening anything) | Priority |
|---|---|---|---|
| **Question** ❓ | A form, or the agent ends its turn asking you something (`?` or "should I…" phrasing) | the question itself — the extracted question sentence, or the form's fields with their choices | urgent (5) |
| **Permission** 🔒 | The agent needs your approval to continue | the structured ask, e.g. `read · permtest.env` | urgent (5) |
| **Finished** ✅ | Turn completes without a question | telemetry, e.g. `Done in 1m 52s · 9 tools · 1 failed` | default (3) |
| **Error** 🚨 | Session/tool execution error (60 s cooldown per session) | who failed + first line, e.g. `edit failed · Could not find oldString in …` | high (4) |
| **Custom** 📣 | Agent calls `ntfy_notify` | whatever the agent wrote | as requested |

All events arrive on your one subscribed topic — the title prefix and emoji tag
(❓/🔒/✅/🚨) tell you which kind it is.

Captions are built to be useful *from the lock screen alone*: ≤ ~160–200 chars, no markdown
noise, never cut mid-word.

Dedupe: a question suppresses a “finished” within 10 s (never the other way around);
permission asks and turn completions are separate moments and both fire. Errors collapse
repeats into `(+N similar errors suppressed)` instead of paging you again.

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
        "accessMode": "auto",

        "events": {
          "question": { "enabled": true, "priority": "urgent", "tags": ["question"],
                        "idleMode": "heuristic", "patterns": ["\\\\bshould i\\\\b", "…"] },
          "finished": { "enabled": true, "priority": "default", "tags": ["heavy_check_mark"] },
          "error":    { "enabled": true, "priority": "high", "tags": ["rotating_light"], "cooldownSec": 60 },
          "permission": { "enabled": true, "priority": "urgent", "tags": ["lock"] }
        },

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
- **`baseTopic`** – the one topic every event publishes to; auto-generated once and
  persisted on first run if unset. Your phone subscribes to it exactly once.
- **`accessMode`** – `"auto"` (default) detects local/tailscale/cloudflare from `serverUrl`
  for startup guidance; set explicitly when the publishing URL differs from the phone's URL.
- **`events.*.priority`** – `min|low|default|high|urgent` or `1`–`5`.
- **`events.question.idleMode`** – how a plain turn-end is classified:
  - `"heuristic"` (default): trailing `?` or a question phrase anywhere → question.
  - `"always"`: every turn-end is a question ping. `"off"`: never.
- **`events.question.patterns`** – replaces the built-in phrase list (case-insensitive regexes).
- **`events.permission.*`** – permission requests are their own kind (default `urgent`, tag `lock`)
  with an independent toggle: an agent blocked waiting on you is a different signal from a question.

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
| Repeated failures spam logs | First failure logs, repeats log at most every `failureLogIntervalMs` (default 10 min) per topic+class. |

## Development

```bash
npm install
npm run typecheck
npm test          # OpenCode event flow, installer/uninstaller contracts, Codex hooks, nudge-agent CLI
```
