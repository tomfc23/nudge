# INSTALL.md — have your agent install `opencode-ntfy`

Give this file (or its contents) to a coding agent with shell access — OpenCode,
Claude Code, or similar. It is a complete runbook: the agent asks you a few
questions in chat, provisions a self-hosted ntfy server, wires the plugin, and
proves delivery to your phone with a test push.

**If you are the agent reading this:** follow the steps in order. Do not
re-implement anything the scripts do — they are the single, tested
implementation (SPEC §14). Ask the user the questions below in chat, resolve
every preflight failure before running the wizard, and never report success
without the verification table.

---

## Contract

- **One core:** `scripts/setup-server.sh` provisions the server;
  `install.sh` drives it and writes `opencode.json`. Never hand-roll either step.
- **Exit codes (both scripts):** `0` ok · `2` usage/bad input · `3` missing
  dependency/login/input · `4` port conflict · `5` server/verification failure.
- **Idempotent:** re-running is always safe (same user, same token, same topic
  kept on re-runs). A *mode switch* requires the phone to **re-subscribe** —
  the iOS wake hash is `sha256(base-url + "/" + topic)`.
- **Never:** `pkill` cloudflared (persistence is detection-based), overwrite
  unrelated keys in `opencode.json`, or regenerate an existing `baseTopic`.
- **Consent:** ask the user before `brew install` or browser logins unless
  they already said yes. Nothing runs before the questions are answered.

## Ask the user these questions (one chat round is enough)

| # | Question | Answers map to |
|---|---|---|
| 1 | **How should the phone reach the server?** local (same Wi-Fi) / tailscale (private VPN) / cloudflare (public URL) | `NTFY_MODE` |
| 1a | cloudflare only: **public hostname?** (e.g. `ntfy.example.com`) | `CF_HOSTNAME` |
| 1b | local only: show the detected LAN IP from preflight and confirm it | `LAN_IP` |
| 2 | **Where to configure?** global (`~/.config/opencode/opencode.json`, all projects) or project (`<project>/opencode.json`) | `NTFY_SCOPE` |
| 3 | **Which notifications?** all five (recommended) or which to disable: question, permission, finished, error, custom | `NTFY_EVENTS` (`all` or csv of the **enabled** kinds) |
| 4 | **Which phone?** ios / android / none | `NTFY_PHONE` |
| 5 | **May I install missing tools via Homebrew and run cloudflared/tailscale logins in your browser?** | `NTFY_INSTALL_DEPS` (`1`/`0`) |

Run every command below **from the repo root** (the directory containing
`install.sh`). If you do not have the repo, ask the user for its URL and
`git clone <url>` first.

---

## Step 1 — preflight (you run it; parse the JSON)

Preflight reads `CF_HOSTNAME`, `NTFY_PORT` and `LAN_IP` from the **environment**
— pass what you collected in Q1/Q1a/Q1b (omit what doesn't apply to the mode):

```bash
CF_HOSTNAME=ntfy.example.com bash scripts/setup-server.sh preflight cloudflare --json
# local:     LAN_IP=192.168.0.24 bash scripts/setup-server.sh preflight local --json
# tailscale: bash scripts/setup-server.sh preflight tailscale --json
```

Exit `0` = ready. Otherwise each `checks[]` entry with `"ok": false` needs one
of these actions — do them yourself or ask the user (per consent above), then
re-run until exit 0:

| check id | action |
|---|---|
| `docker-cli` / `docker-compose` | `brew install colima docker` (macOS) |
| `docker-daemon` | `colima start` (or start Docker Desktop) |
| `tailscale-cli` / `cloudflared-cli` | `brew install tailscale` / `brew install cloudflared` |
| `tailscale-login` | run `tailscale up` (browser finishes the login) |
| `cloudflared-login` | run `cloudflared login` (browser) |
| `cloudflare-hostname` | you should already have `CF_HOSTNAME` from Q1a |
| `port-<N>` | **ask the user which free port** (offer 8080), export `NTFY_PORT=<port>` |
| `lan-ip` | no auto-detect: ask the user for the machine's LAN IP, export `LAN_IP=<ip>` |

Carry the final values forward: `CF_HOSTNAME`, `NTFY_PORT`, `LAN_IP`.

## Step 2 — run the wizard non-interactively

`install.sh` with these env vars asks **zero** prompts. Run it as **one line**
— a `# comment` after a `\` line-continuation breaks the command and silently
drops every env var (put comments on their own line, or don't use any):

```bash
NTFY_MODE=cloudflare CF_HOSTNAME=ntfy.example.com NTFY_SCOPE=global NTFY_EVENTS=all NTFY_PHONE=ios NTFY_INSTALL_DEPS=1 NTFY_SKIP_CONFIRM=1 sh install.sh
```

Env values (from Q1-Q5): `NTFY_MODE` = local|tailscale|cloudflare ·
`CF_HOSTNAME` cloudflare only (`LAN_IP=...` for local) · `NTFY_SCOPE` =
global|project (for project, run from the project root) · `NTFY_EVENTS` = `all`
or csv of the enabled kinds · `NTFY_PHONE` = ios|android|none ·
`NTFY_INSTALL_DEPS=1` only after the user said yes in Q5 · `NTFY_SKIP_CONFIRM=1`
— you own the phone-confirmation in chat (Steps 3-4) · optional
`NTFY_CONFIG_FILE=<path>` = exact config file, overrides the scope (only for
dry runs into a scratch file — never needed for a normal install).

- Exit **0** → continue. Record from its output, for Step 5's table: the
  provisioning status and the smoke line
  (`anonymous ... (403) ✓  token ... (200) ✓  via <serverUrl>: 200`), plus the
  printed `config written: <path>` — that file is your source of truth.
- Exit **2** mentioning "no input": a prompt appeared that env vars didn't
  cover (usually a *new* port conflict). Re-run Step 1, set the missing env,
  retry. Never answer prompts by piping fake stdin guesses.
- Exit **3/4/5** → show the user the error; fix via Step 1's table and retry.

The wizard also sends one **server-side** test push immediately — watch for
`test push sent (HTTP 200)`; that, together with the provisioning status and
smoke line above, is where Step 5's "server setup" row comes from. The
*user-visible* confirmation push is yours, in Step 4.

## Step 3 — verify the config, then walk the user through the phone

Read back what was written (use the path from `config written:`):

```bash
node -e '
var fs=require("fs");
var cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
var e=(cfg.plugin||[]).find(function(x){return Array.isArray(x)&&x[1]&&x[1].serverUrl&&x[1].baseTopic;});
if(!e){console.error("no opencode-ntfy entry found");process.exit(1);}
console.log("serverUrl="+e[1].serverUrl);
console.log("baseTopic="+e[1].baseTopic);
console.log("token="+(e[1].token||"(none)"));' <config-path>
```

All three fields present (or token intentionally absent for unauthenticated
servers). Then post the phone steps to the user — iOS has **no one-tap
subscribe**, this is the one manual step:

> 1. Install the **ntfy** app ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / Android)
> 2. Default server: `<serverUrl>` 3. Subscribe to topic: `<baseTopic>`
>    (local: phone on the same Wi-Fi · tailscale: install the phone Tailscale
>    app, Connect on Demand enabled · ios: instant push is pre-configured via
>    ntfy.sh → APNS)

**Wait for the user to reply that they subscribed.** Do not proceed on
assumption — this step cannot be automated.

## Step 4 — the visible test push

Set the three values from Step 3's output (its labels `serverUrl` / `baseTopic`
/ `token` become `SERVER_URL` / `TOPIC` / `TOKEN`):

```bash
SERVER_URL="https://ntfy.example.com"
TOPIC="opencode-xxxxxxxxxx"
TOKEN="tk_..."
curl -s -o /dev/null -w '%{http_code}\n' -m 10 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"topic\":\"$TOPIC\",\"title\":\"opencode-ntfy test\",\"message\":\"If your phone shows this, setup is complete.\",\"tags\":[\"tada\"]}" \
  "$SERVER_URL/"
```

`200` → ask the user: *did it arrive?*

- **Yes** → Step 5, done.
- **No** → check, in order: app default server is *exactly* `<serverUrl>` ·
  subscribed to *exactly* `<baseTopic>` · local = same Wi-Fi / tailscale =
  phone connected / cloudflare = wait ~1 min for DNS · iOS Settings →
  Notifications → ntfy allowed · `bash scripts/setup-server.sh preflight <mode>`.

## Step 5 — finish and report

Remind the user: **start (or restart) OpenCode once** — a newly added plugin
loads on next start; option changes hot-reload afterwards. The `[ntfy]`
startup log prints the subscribe topic — cross-check it against `baseTopic`.

Report exactly this table (checked items only if actually observed):

```
preflight .............. exit 0 (mode: <mode>, port: <port>)
server setup ........... install.sh exit 0, smoke 403/200/200 via <serverUrl> (Step 2 output)
config ................. <path> (serverUrl/token/baseTopic present)
server-side test push ... HTTP 200 (install.sh)
phone test push ......... HTTP 200 + user confirmed arrival: yes/no/pending
OpenCode restart ........ reminded user (needed once for a new plugin)
```

---

## Path B — the user already runs an ntfy server

Skip Steps 1-2 entirely (SPEC D16: provisioning is out of scope). Write the
plugin entry yourself into the chosen `opencode.json`, preserving every
existing key:

```json
"plugin": [["/path/to/opencode-ntfy", { "serverUrl": "<their server>", "token": "<their token, if any>" }]]
```

Leave `baseTopic` out — the plugin generates one on first run and prints it in
the `[ntfy]` startup log (D4). Their server must be reachable at a URL the
phone can use, anonymous **subscribe** allowed (publish needs their token).
Then continue from Step 3 (phone instructions with *their* URL).

## Mode switch / uninstall

- **Switch mode later:** re-run Step 2 with the new `NTFY_MODE`, then tell the
  user to **delete and re-add** the phone subscription (wake hash is keyed to
  the server URL).
- **Uninstall:** remove the plugin entry from `opencode.json`;
  server: `docker compose -f "$HOME/ntfy/docker-compose.yml" down`.
