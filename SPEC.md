# Spec: `opencode-ntfy` — ntfy notifications plugin for OpenCode

**Status:** Implemented (rev 5 — D10 turn-boundary trigger, D11 permission kind, D12 captions, §14 installation flows; verified against OpenCode v2.0.12)
**Target:** OpenCode V2 plugin API (`@opencode/plugin`)

## 1. Overview

An OpenCode plugin that publishes notifications to a **self-hosted ntfy server**, delivered to the **ntfy iOS app**. Covers built-in events (permission requests, agent questions, task finished, errors) plus custom notifications triggered by the agent via a tool. All events are individually configurable.

Key references:

- OpenCode plugins guide: https://opencode.ai/v2/docs/build/plugins
- OpenCode config guide: https://opencode.ai/v2/docs/config/
- OpenCode plugins config: https://opencode.ai/v2/docs/plugins/
- ntfy install (self-hosting): https://docs.ntfy.sh/install/
- ntfy publishing: https://docs.ntfy.sh/publish/

## 2. Decisions (confirmed)

| Topic | Decision |
| --- | --- |
| Routing | **Single topic** — every event publishes to `baseTopic`; kind carried by title/priority/tags (§13-D9) |
| Default events | Question (forms + plain text), **permission** (blocked agent, own kind since D11), task finished, errors, custom |
| Captions | **Direction 3 hybrid** (§6.4, D12) — structured telemetry/facts per kind; extracted question *sentence* for text questions |
| Configurability | Per-event `enabled` / `priority` / `tags` map |
| Custom notifications | **Agent tool** (`ntfy_notify`) only; no slash command, no RPC in v1 |
| Auth | **ntfy access token**, resolved from env (see §5 for resolution rules) |
| Click action | **None** — no `click` header; tapping opens the ntfy app (iOS default) |
| Delivery path | ntfy iOS app subscribes to server topics; smoke-test background delivery first |
| Install & distribution | **Website + `install.sh` wizard + `INSTALL.md` agent runbook** over one non-interactive core (§14, D13–D16) |

## 3. Architecture

```
OpenCode server
  └─ opencode-ntfy plugin
       ├─ event watcher (ctx.event.subscribe)
       │    ├─ session.execution.succeeded (§13-D10) → §6.1 classify → question / finished
       │    ├─ permission.asked                      → permission notifications (§13-D11)
       │    ├─ form.created                          → question notifications
       │    ├─ session.execution.started / session.tool.*  → per-turn telemetry (§6.4)
       │    └─ session.execution.failed / session.tool.failed → errors (cooldown §6.3)
       ├─ caption.ts (Direction 3 caption builders, §6.4 / §13-D12)
       └─ ntfy_notify tool (ctx.tool.transform)    → custom notifications
            └─ publish.ts (fetch, JSON POST, bearer auth)
                 └─ self-hosted ntfy server (HTTP)
                      └─ ntfy iOS app (subscribed to the single topic)
```

The plugin only **publishes**. All rendering, sound, and delivery to the phone is handled by the ntfy server + iOS app.

## 4. Repository layout

```
opencode-ntfy/
  index.ts                # root re-export (REQUIRED: opencode's loader probes the package root,
                          #   it does not follow package.json "main"/"exports" — §13-D5)
  package.json            # name: opencode-ntfy, type: module, main/exports: ./index.ts
  install.sh              # wizard installer — sh install.sh (SPEC §14.4 Channel A)
  INSTALL.md              # agent runbook — paste to your agent (SPEC §14.4 Channel B)
  src/
    index.ts              # Plugin.define({ id: "ntfy", setup }) + cleanup
    config.ts             # options parsing, defaults, single derived topic, token resolution
    publish.ts            # ntfy HTTP client (fetch, JSON publish, bearer auth, timeout)
    events.ts             # event watcher: turn boundary (D10), permission/form/question kinds,
                          #   per-turn telemetry, finished/error, dedupe/cooldown
    classify.ts           # turn-end classification: question vs finished (heuristic, §6.1)
    caption.ts            # Direction 3 caption builders per kind (§6.4, D12)
    tool.ts               # ntfy_notify tool registration
  README.md
  SPEC.md                 # this document
  scripts/setup-server.sh # provision any access mode — idempotent, --json contract (§14.3)
  scripts/uninstall.sh    # inventory-first removal — all 3 levels (L2/L3 behind PATH shims) (§15, D17)
  scripts/test.ts         # 79-test suite (npm test via tsx)
```

Local alternative: one-line drop-in at `.opencode/plugins/ntfy.ts` (or `~/.config/opencode/plugins/ntfy.ts`):
`export { default } from "/abs/path/opencode-ntfy/index.ts"` — auto-loaded, no config entry needed;
configure via env vars only (no per-event options in this mode).

## 5. Configuration

Passed as plugin options in `opencode.json(c)` (verified form, §13-D4):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/abs/path/opencode-ntfy", "options": {
    "serverUrl": "https://ntfy.example.com",
    "token": "{env:NTFY_TOKEN}",
    "baseTopic": "opencode-a8f3k2",       // THE one topic for all events; unguessable = password
    "events": {
      "question": {
        "enabled": true,
        "priority": "urgent",
        "tags": ["question"],
        "idleMode": "heuristic",           // "heuristic" | "always" | "off"  (§6.1)
        "patterns": null                   // optional replacement pattern list (§6.1)
      },
      "finished": { "enabled": true, "priority": "default", "tags": ["heavy_check_mark"] },
      "error":    { "enabled": true, "priority": "high", "tags": ["rotating_light"], "cooldownSec": 60 },
      "permission": { "enabled": true, "priority": "urgent", "tags": ["lock"] }   // agent blocked (D11)
      },
      "dedupeWindowMs": 10000,
      "publishTimeoutMs": 5000,
      "failureLogIntervalMs": 600000         // §7
    }
  }]
}
```

Rules:

- All events publish to the single topic `${baseTopic}` (§13-D9); the event kind travels in title/priority/tags. `ntfy_notify` may override per call via its `topic` input.
- Unknown/missing options fail soft: log a warning, disable the affected event, never crash plugin setup.
- Per-event `priority` accepts ntfy names (`min|low|default|high|urgent`) or IDs 1–5.

### 5.1 Token resolution (env substitution — verified)

**Verified empirically:** a run with `options.token = "{env:SMOKE_TOK}"` and `SMOKE_TOK=abc123` published with `Authorization: Bearer abc123`, so the token chain works end to end. Which stage resolved it (loader pre-resolution vs. the plugin's own regex fallback) is indistinguishable — §5.1's dual-path order handles either behavior, so no assumption is required.

`config.ts` resolves the token with an order that works under *either* behavior:

1. If `options.token` is absent → use `process.env.NTFY_TOKEN` (documented default env var).
2. If `options.token` matches `/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/` (i.e. it arrived **unresolved**) → read `process.env[match[1]]`.
3. Otherwise → use the value verbatim (covers both literal tokens and loader-resolved values).

If the result is empty: log one clear warning (`"ntfy: no token available; publishing unauthenticated"` or `"disabling publishes"` per auth mode below) and continue in **unauthenticated** mode only if `allowAnonymous: true` (default `false` → publishes are disabled and each attempted event logs at the §7 cadence). Resolution behavior is verified empirically in step 1 and this section updated accordingly.

## 6. Notification events

| Event kind | Default priority / tag | Detection |
| --- | --- | --- |
| **Permission** (D11) | `urgent` (5) / `lock` | `permission.asked` on the event stream; payload `{id, sessionID, action, resources[], message?}` → caption `read · path` |
| Question — form | `urgent` (5) / `question` | `form.created`; payload `{title, fields}` → caption = visible fields + choices (§6.4) |
| Question — plain text (agent waiting on user) | `urgent` (5) / `question` | Turn boundary (`session.execution.succeeded`, D10) **and** §6.1 classifies the final assistant message as a question |
| Task finished | `default` (3) / `heavy_check_mark` | Same boundary, §6.1 verdict not-a-question; caption = per-turn telemetry (§6.4) |
| Error | `high` (4) / `rotating_light` | `session.execution.failed` and `session.tool.failed` (tool name resolved from the call id via `session.tool.input.started`); cooldown §6.3 |
| Custom | caller-defined | `ntfy_notify` tool input (§8) |

All events publish to the one `baseTopic` (§13-D9); the kind travels in title/priority/tags. All events honor `events.<name>.enabled: false` to suppress. Note (D11): a permission ask is its own kind — it no longer counts as a question, so it does **not** suppress a subsequent finished ping (§6.2).

### 6.1 Turn-end classification: question vs finished (primary gap resolution)

**Structured-signal check (done):** the OpenCode V2 plugins guide and API schema expose `session.execution.succeeded` (turn ended), forms (`form.created`, pending state), and `permission.asked` — but **no structured "the agent is asking the user something" flag** at a turn boundary. Permission asks and forms are already handled as first-class structured signals (permission is its own kind since D11 — table above). For plain conversational questions, no structured signal exists, so a **text heuristic on the final assistant message** is the fallback.

**Trigger (D10):** exactly one notification per turn boundary, driven by `session.execution.succeeded`. (`session.idle` exists in the `V2Event` union but is never emitted — proven live, §13-D10 — so `case "session.idle"` is kept only as a forward-compat secondary.) The classifier maps the boundary to `question` XOR `finished`; no boundary produces both or neither (unless one of the two events is disabled in config, in which case it produces the other).

**Inputs:** the last assistant message before the boundary. Preprocess by concatenating its text parts, then stripping: fenced code blocks, inline code spans, URLs, and markdown emphasis/heading markers.

**Classification rule (deterministic, in order):**

1. If `events.question.idleMode === "off"` → `finished`.
2. If `events.question.idleMode === "always"` → `question`.
3. (heuristic) If the last non-whitespace character of the preprocessed text is `?` → `question`.
4. (heuristic) If the preprocessed text matches any pattern in the question pattern list (case-insensitive, anywhere in the text) → `question`.
5. Otherwise → `finished`.

**Default question pattern list** (concrete; `events.question.patterns`, when provided, **replaces** this list entirely):

```
\bshould i\b            \bshould we\b          \bshall i\b
\bwould you like\b      \bdo you want\b        \bwant me to\b
\bdo you prefer\b       \bdo you mind\b        \bdoes that work\b
\blet me know\b         \bwhich one\b          \bwhich option\b
\bhow about\b           \bany thoughts\b       \bany questions\b
\bsound good\b          \blook good to you\b
```

**Error asymmetry & bias direction.** Both branches **always notify** — a misclassified question still produces a `finished` notification (default priority/topic/sound), so the failure mode is "wrong urgency/topic", not "no ping". Given that:

- The residual harm of a **false question** = one extra urgent ping with a question sound.
- The residual harm of a **missed question** = the user gets a "done" ping they may treat as non-actionable and delay responding to.

The missed-question case is worse *for action-taking* even though delivery occurs either way, so the rule is **biased toward `question`**: any single pattern hit anywhere in the final message (not just the trailing sentence) classifies as question. Known accepted false positives: agents ending with offers ("…want me to commit? All tests pass.") and rhetorical closes — both warrant a ping anyway. Known accepted false negatives: questions phrased without `?` and outside the pattern list (e.g. "Your call on the tradeoff.") → classified `finished`; the ping still arrives at default priority.

**Escape hatches (config):**

- `idleMode: "off"` — every turn-end → `finished` (pure turn-complete workflow).
- `idleMode: "always"` — every turn-end → `question` (user considers any turn-end worth an urgent ping).
- `patterns: [...]` — replace the default list for workflow-specific phrasing.

**Heuristic details [judgment call — confirm]:**

- Classification uses **only the final assistant message**, not the whole turn — avoids mid-conversation questions that were already answered.
- The whole message is scanned for pattern matches (rule 4), but only the **end** of the message is checked for `?` (rule 3) — a `?` mid-message in a status report ("2 tests failed. Investigating?") shouldn't dominate, but "let me know if…" trailing offers usually sit mid/final sentence.

### 6.2 Dedupe & precedence (symmetry resolved)

- **Per-boundary exclusivity:** §6.1 guarantees exactly one of `question`/`finished` per turn boundary — no same-moment double fire is possible by construction.
- **Dedupe key:** `(sessionID, kind)` within `dedupeWindowMs` (default 10s), process-shared (D8), cleared on cleanup. Retained for permission-ask storms and duplicate event-stream deliveries.
- **Question → finished suppression:** a `finished` notification for session S is suppressed if a `question` for S was published within `dedupeWindowMs`. Covers a classified-question boundary followed by a duplicate boundary inside the window (D10 handles both event names at one boundary; D8 dedupe collapses the three concurrent instances). Permission asks no longer set this state (D11) — a permission ask and the turn's completion are different moments, and both pings are wanted.
- **Finished → question: never suppressed.** A question has strictly higher value; a `finished` published moments earlier does not make a new question stale. This is the deliberate asymmetry [judgment call — confirm]: the reverse rule would risk the exact missed-urgent-ping failure the classifier is biased to avoid. Form asks still fire *mid-turn*, before the boundary that follows them, so a form→finished pair inside the window stays suppressed.
- **Beyond the window:** a `finished` more than `dedupeWindowMs` after the last question fires normally — if the user took 30s to answer and the turn then genuinely completed, the completion ping is correct and wanted.

### 6.3 Error rate limiting (v1, not deferred)

**Included in v1** rather than future work: a flapping tool inside a single agent turn can emit error events back-to-back for many seconds, and the 10s `(sessionID, event)` dedupe only collapses near-simultaneous duplicates — a retry loop spaced at 15s intervals would pass straight through and page the phone dozens of times.

- **Rule:** per-session **error cooldown**, default `events.error.cooldownSec: 60`. First error fires immediately; subsequent error notifications for that session are suppressed until 60s after the last *published* error. Steady-state ceiling: **≤1 error ping per session per 60s**.
- Suppressed errors are counted; when the next error publishes after cooldown, its message appends `(+N similar errors suppressed)` so recurrence isn't hidden.
- Questions and finished need no equivalent cooldown — their rate is naturally bounded by turn cadence (one idle per turn) and the dedupe window.

### 6.4 Captions — Direction 3 hybrid (D12)

Captions must be valuable from the lock screen alone: ≤ ~160–200 chars, no markdown noise, never cut mid-word. Raw first-N-chars message excerpts were rejected (markdown noise, mid-word cuts, low signal); each kind now gets a purpose-built caption (`src/caption.ts` — pure functions, unit-tested):

| Kind | Caption construction | Example |
| --- | --- | --- |
| Question (text) | **the question itself**: last sentence ending in `?` → else first sentence matching a pattern → else first sentence | `what caption text does the Question notification on my phone show?` |
| Question (form) | form title + visible fields with choices (`hidden` skipped, ≤4 fields / ≤4 options + `…`) | `Pick env · Environment: staging \| prod · Dry run?: yes \| no` |
| Finished | **pure per-turn telemetry** — duration, tools, failures; no message text (a statement's prose adds nothing a glance needs) | `Done in 1m 52s · 9 tools · 1 failed` |
| Permission | structured ask as carried by the event (+ ` — message` only when present) | `read · permtest.env` |
| Error | `{tool} failed · first line of the error` (tool name resolved from the call id) | `shell failed · ECONNRESET` |
| Custom | caller-provided text, untouched | — |

Telemetry inputs: `session.execution.started` opens a turn, `session.tool.called` increments the tool count, `session.tool.failed` the failure count; stats are consumed at the boundary and cleared. Fallback when a boundary arrives without an open turn (e.g. the plugin loaded mid-turn): `Agent finished its turn.` All cuts happen at word boundaries; unknown/missing data degrades to a shorter caption, never an error.

## 7. Publish client (`publish.ts`)

```ts
fetch(serverUrl + "/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,   // omitted when token absent (§5.1)
  },
  body: JSON.stringify({ topic, message, title, priority, tags }),
  signal: AbortSignal.timeout(publishTimeoutMs),
})
```

- JSON publish (avoids UTF-8 HTTP header encoding pitfalls).
- Fire-and-forget: rejections are caught and logged, never propagated into event loops or hooks. Executor tools (`ntfy_notify`) return a short failure string to the model instead of throwing.
- No `click`, no `actions`, no attachments in v1.

### 7.1 Failure log suppression (defined)

Replaces the previous ambiguous "one warning log per event type per run":

- **Log key:** `(topic, statusClass)` where `statusClass` is `auth` (401/403), `client` (other 4xx), or `transport` (5xx / timeout / network). With the single-topic scheme (§13-D9) the topic component is constant, so this effectively groups by `statusClass`: an outage logs one line per class instead of one per event kind.
- **Rule:** log the **first** failure for a key immediately; thereafter log at most **once per `failureLogIntervalMs` (default 600 000 ms = 10 minutes)** per key. The interval is **wall-clock, evaluated at failure time**, and applies across sessions — not per-session, not per plugin-process-lifetime, not reset by unrelated successes.
- **Recovery log:** on the first successful publish after any failure was logged for that key, emit one `info`: `ntfy: publishing recovered (topic=…)`.
- Consequence: a persistent auth failure in a long-running server logs ~6 warnings/hour plus one recovery line when fixed — never fully silent, never spammy. A 10-minute interval still catches the "token rotated, still broken 3 hours later" case because each new interval logs again.

## 8. Custom notification tool

Registered via `ctx.tool.transform`:

- Namespace: `ntfy` → effective tool id `ntfy_notify`
- Input schema:

```jsonc
{
  "type": "object",
  "properties": {
    "message":  { "type": "string" },
    "title":    { "type": "string" },
    "priority": { "type": "string", "enum": ["min","low","default","high","urgent"] },
    "tags":     { "type": "array", "items": { "type": "string" } },
    "topic":    { "type": "string" }   // optional override; defaults to the single plugin topic
  },
  "required": ["message"],
  "additionalProperties": false
}
```

- Description makes clear it pings the user's phone; normal OpenCode permission rules gate its use.
- Executor honors `context.signal` for cancellation; returns a short confirmation string.

## 9. Plugin lifecycle

```ts
export default Plugin.define({
  id: "ntfy",
  async setup(ctx) {
    const config = readConfig(ctx.options)      // config.ts (incl. §5.1 token resolution)
    const controller = new AbortController()
    void watchEvents(ctx, config, controller.signal)  // events.ts: boundary (D10) + permission/form
                                                      //   + telemetry + classify (§6.1) + captions (§6.4)
    await registerTool(ctx, config)              // tool.ts
    return () => controller.abort()              // cleanup
  },
})
```

- Event subscription aborted on unload; no timers left running.
- Transforms disposed automatically on unload.

## 10. Self-hosted server (README content)

Per https://docs.ntfy.sh/install/ — Docker recommended (ntfy server is not supported natively on macOS):

```yaml
# docker-compose.yml
services:
  ntfy:
    image: binwiederhier/ntfy
    command: [serve]
    environment: [TZ=UTC]
    user: "1000:1000"
    volumes:
      - ./cache:/var/cache/ntfy
      - ./server.yml:/etc/ntfy/server.yml
    ports: ["80:80"]
    restart: unless-stopped
    init: true
```

- `server.yml`: template from https://github.com/binwiederhier/ntfy/blob/main/server/server.yml ; set `base-url` when behind a domain/TLS.
- Token: `ntfy token` → export `NTFY_TOKEN`.
- Security: topic names are effectively passwords — use an unguessable `baseTopic` suffix. Enable server auth as defense in depth.

### iOS delivery caveat (verify in step 0) — ✅ RESOLVED, verified 2026-09-21

iOS background delivery for a self-hosted server **requires the server-side `upstream-base-url: "https://ntfy.sh"` setting** — ntfy's official mechanism (flag help: *"needed for iOS push notifications for self-hosted servers"*). Flow: each publish forwards a *poll request* — message ID + SHA256(topic URL) only, never the content — to ntfy.sh; ntfy.sh wakes the phone via Firebase/APNS; the app fetches the real message from the self-hosted server. Poll requests are deliberately not cached (`cache = false` when `X-Poll-ID` is set), so they are invisible to `?poll=1` by design. Verified end-to-end: notification delivered to a locked iPhone with the app fully backgrounded. UnifiedPush is Android-only and was not needed; no app rebuild required. Without `upstream-base-url`, delivery falls back to iOS background refresh — documented by ntfy as unreliable (hours).

## 11. Build order

0. **Server + iOS smoke test**: docker compose up → token → iOS app subscribes to `opencode-test-xyz` → `curl -H "Authorization: Bearer $NTFY_TOKEN" -d "hello" http://server/opencode-test-xyz` → confirm delivery while app is backgrounded. Decide delivery strategy here if flaky. **✅ Done (2026-09-21): strategy = `upstream-base-url: https://ntfy.sh`, see §10 caveat + §13.**
1. **Scaffold + publish client**: package, `Plugin.define`, config parsing, `publish.ts`. **Verify empirically whether `{env:NTFY_TOKEN}` arrives resolved or literal in `ctx.options`** (log a redacted marker in a throwaway run); confirm §5.1's dual-path resolution handles the observed behavior; update §5.1 with the finding. Standalone script proves publish works.
2. **Finished + error notifications**: event watcher, dedupe, error cooldown (§6.3), config gating, failure logging (§7.1).
3. **Question + permission notifications**: `permission.asked` watcher (own kind, D11), form watcher, turn-boundary classifier (§6.1, D10), question-over-finished precedence (§6.2), captions (§6.4, D12).
4. **`ntfy_notify` tool.**
5. **README**: server setup, token creation, iOS subscribe steps, config reference (incl. `idleMode`/`patterns`), security notes, future work.
6. **Test matrix** (manual):

   - [x] Permission ask → **permission** kind (urgent, `lock`), exactly one push — live 2026-09-21 (D11)
   - [x] Boundary ending in a trailing `?` → question, caption = the extracted question sentence — live 2026-09-21 (D10+D12)
   - [x] Boundary after a plain statement → finished — live 2026-09-21 (D10)
   - [ ] Boundary with `?` mid-message only, no trailing `?` → finished (trailing rule)
   - [ ] `idleMode: "always"` / `"off"` / custom `patterns` behave as specified
   - [ ] Boundary <10s after a published question → finished suppressed (§6.2)
   - [ ] `finished` >10s after last question → fires normally (reverse case un-suppressed)
   - [x] Form prompt → question — live 2026-09-21
   - [ ] Flapping tool errors ≤1 ping/60s/session, `(+N suppressed)` on re-fire *(suppression counts observed live; cadence not stress-tested)*
   - [x] `ntfy_notify` with defaults + priority/tags — live 2026-09-21; topic override unit-tested
   - [ ] `events.<name>.enabled: false` suppresses
   - [ ] Missing/invalid token → soft failure per §5.1, plugin still loads; failure logs at §7.1 cadence (first immediately, then ≤1/10min), recovery line on fix
   - [x] Delivery while iOS app backgrounded (2026-09-21, via `upstream-base-url` → ntfy.sh → APNS)
   - [ ] Plugin unload → no dangling subscriptions/timers
7. **Installation flows** (post-v1, plan approved 2026-09-21): non-interactive core ✅ → `install.sh` wizard → `INSTALL.md` runbook → website → dogfood verification — see §14.6.

## 12. Future work (out of scope for v1)

- `clickUrl` deep link to OpenCode web UI (`Click` header).
- Action buttons (e.g. "Approve" → `http` action → `POST /api/session/{id}/permission/{requestID}/reply`).
- RPC export so other plugins can publish (`./rpc` entrypoint).
- Slash command `/notify` for manual sends.
- CLI plugin (TUI) badge/pane for pending questions.
- Attachments (screenshots/diffs) via ntfy `Attach`.
- Smarter question classification (whole-turn context, LLM-assisted classification via `ctx.generate.text`) — v1 heuristic + escape hatches first; revisit only if real-world misclassification rate is painful.

## 13. Implementation results (empirical, OpenCode v2.0.12)

### Verified

- **Plugin loads in a real server:** `opencode serve` in a test project with our package in config → `/api/plugin` reports `id: "ntfy"`, `source.type: "local"`, `state.status: "active"`, and the `[ntfy]` startup lines (server / auth / subscribe topic) print.
- **Config forms (both load a local package dir with options):**
  - `"plugins": [{ "package": "/abs/path", "options": {…} }]` — docs form
  - `"plugin": [["/abs/path" or "./rel/path", {…}]]` — tuple form from the published config schema
  - All earlier silent load failures traced to D5, not to the config key or path form.
- **`{env:NAME}` token:** `token: "{env:SMOKE_TOK}"` + `SMOKE_TOK=abc123` → published `Authorization: Bearer abc123` (loader pre-resolution and the plugin's regex path are indistinguishable; §5.1 handles both).
- **Publish path:** `scripts/smoke-publish.ts` against a local capture server received `POST /` with the expected topic, body, and auth header.
- **Regression:** `npm test` (**87 tests**: classifier, captions (§6.4), config/token chain, access modes, event→publish flow, dedupe/cooldown incl. concurrent-instance sharing, log rate-limit, tool, **setup-server.sh non-interactive contract (§14.3)**, **install.sh wizard + INSTALL.md drift contract (§14.4)**, **uninstall.sh contract incl. L2/L3 under PATH shims + UNINSTALL.md drift/table-identity (§15)**) and `tsc --noEmit` both green after all changes.
- **Real self-hosted server, production hardening:** ntfy 2.28.0 in Docker on Colima (macOS has no native server); auth enabled with `auth-file` + `auth-default-access: read-only` (anonymous may subscribe, publish denied 403 — verified) and an admin user + token for the plugin (publish 200 — verified). Note: config key is `auth-default-access`, *not* `auth-default-permissions` (the latter is silently ignored — koanf is not strict-parse).
- **Public remote access:** Cloudflare Tunnel (dedicated tunnel `ntfy`, existing tunnels untouched) → `https://ntfy.example.com`, DNS routed, health 200 through the public URL; persisted via launchd `LaunchAgent` (RunAtLoad + KeepAlive) with `brew services start colima` + `restart: unless-stopped` covering reboot recovery.
- **iOS background delivery (build-order step 0):** `upstream-base-url: "https://ntfy.sh"` → server log confirms poll request forwarded (matching SHA256 topic hash, no WARN = HTTP 200); notification received on a **locked iPhone with the app fully backgrounded**. See §10 caveat.
- **Live `ntfy_notify` → phone (custom path e2e):** fired from a real session's tool catalog → server received authenticated publish → poll request forwarded → notification displayed on locked iPhone.
- **Single-topic scheme (D9):** all kinds publish to `baseTopic`; startup log prints one subscribe line; `tsc --noEmit` + 39/39 tests green after the change. **Live verified end-to-end in local mode:** phone subscribed once (`http://192.168.0.24` / `opencode-998bdf81cc`); a custom, a tool-error (deliberate failing edit), and a question (form) produced **exactly 3 pushes, once each** (user-confirmed on the phone) and exactly 3 matching rows on the bare topic. Publish path was direct LAN — cloudflared's log showed no tunnel traffic in the window — confirming config changes are picked up by plugin reloads without a service restart (also proven earlier: the 19:14 config was live in the 16:46-started service by 20:05). One diagnostic artifact observed: an error row carrying `(+398 similar errors suppressed)` — fully reconciled as residue of an earlier aborted-tool burst (first failure published to the old `-error` topic, the rest accumulated as suppressed until the next failure minutes later), not a loop.
- **Access-mode support — all three modes (D7):** mode detection covered by tests (loopback, RFC1918, `*.ts.net`, CGNAT `100.64–127`, public https/http, trycloudflare, unparseable, override). `scripts/setup-server.sh` executed end-to-end: **local** fresh run (LAN IP auto-detect, auth smoke: anon 403 / token 200 / via-LAN 200) and idempotent re-run (user + same token reused); **cloudflare** run against the real deployment (existing tunnel reused, public URL publish → 200 through the actual tunnel into a scratch instance, existing LaunchAgent correctly not duplicated). Production container restored and healthy (localhost + public) after all tests. Debug traps found & fixed: `set -o pipefail` + `grep -q` SIGPIPE poisoning, ntfy CLI stream ambiguity (`2>&1` everywhere), blocking `tailscale serve --bg` (bounded with `run_with_timeout`).
- **Tailscale (all three branches exercised; Serve activation live-verified 2026-09-21):** the script's tailscale mode ran end-to-end against a real logged-in tailnet: CLI detection, MagicDNS name extraction (`status --json` → python3), `base-url` derivation, and graceful handling of pending Serve activation (the blocking `serve --bg` is bounded by `run_with_timeout` — the printed activation link is surfaced with re-run guidance, then the script continues: auth smoke passed, `000` via the not-yet-proxied ts.net URL reported as a non-fatal warning, exit 0). The approval flow was then exercised for real end-to-end: one-time `login.tailscale.com/f/serve` link approved by the tailnet admin → serve command **re-run after approval** to apply the config (approval alone leaves no config — the killed first attempt must be re-issued) → `tailscale serve status` shows the proxy → `https://<machine>.<tailnet>.ts.net/v1/health` → **200** (the first request immediately after start can race the proxy warm-up; a retry succeeds) → full script re-run: `via …ts.net: 200`, zero warnings. Access is hostname-keyed — a bare self-IP request without matching SNI does not route (expected). **E2E phone delivery over the Serve path live-verified:** subscription re-added on the phone with the ts.net URL; test push, forwarding probe, and turn-boundary pushes all received with the app backgrounded (user: "all tests worked"). iOS wake forwarding was source-verified along the way (`forwardPollRequest`: attempt logged only at DEBUG, success silent, failures WARN — so zero WARN lines at INFO = every forward returned 200; hash = `sha256(base-url + "/" + topic)`, matching the computed value). Fresh users are walked through the same one-time approval by the script's output. Afterwards the session switched back to **cloudflare** (the maintainer's normal development mode) with an idempotent script re-run: `via https://ntfy.tommyek.com: 200`, LaunchAgent reused, same user/token. **All three access modes (D7) are now live-verified end to end.**
- **Duplicate notifications from concurrent plugin instances (D8, bug found in live use):** a single question produced **3 identical notifications** on the phone. Evidence chain: ntfy cache DB showed identical rows published in the **same millisecond** (also for `permission.asked` and `session.tool.failed` — even the 60s error cooldown was beaten); config had exactly one plugin entry (no ancestor/project configs); the service log showed the plugin loading in **bursts of 3 `setup()` runs within ~1 ms**, all on the shared event bus of one process (`role=server`), ~100 loads over the session. Instance-local dedupe maps meant each copy treated the same event as "first seen". Fixed by process-shared state (D8): `sharedState()` on `globalThis` via `Symbol.for` key, synchronous check-and-set on the single-threaded event loop. Tool path was never affected (tool registration is last-wins — one handler). New tests cover singleton state, instance-local default (test isolation), 3-instance single-publish + cross-instance question→finished suppression, and cross-instance error cooldown: 35 → 39 tests.

- **D10 — turn-boundary trigger live-proven and fixed:** an armed raw-event recorder captured `session.text.ended` and `session.execution.succeeded` 42 ms later at the same boundary with **zero** `session.idle` across the whole window — `case "session.idle"` was dead code, which is exactly why `finished` and text-classified `question` had never once fired live. Switched the boundary case to `session.execution.succeeded` (identical `{sessionID}` payload; `session.idle` retained as forward-compat secondary; D8 dedupe collapses both if upstream ever co-emits). **Live verified 2026-09-21:** Finished push (user: "it worked!") and then the first-ever live text-classified question with the D12 extraction caption (user: "a question push with a good question as the caption").
- **D11 — permission kind live-verified:** `permission.asked` ×3 concurrent instances → **exactly one** push in the same second as the ask; DB row carries `priority=5 tags=lock`; user saw both the ask dialog and the phone push; `permission.replied` arrived 14 s later. Default OpenCode policy that produces asks (v2.0.12): base allow-all except `read *.env` → ask and `external_directory` → ask.
- **D12 — Direction 3 captions (§6.4):** `src/caption.ts` shipped; tests 43 → 53 with exact-string assertions per kind. Live-verified: question extraction caption (user-confirmed: "a question push with a good question as the caption") and the finished telemetry caption (row 21:10:20 = `Done in 4m 56s · 35 tools` — real duration + tool count, failure segment correctly absent, no fallback). The `read · permtest.env` permission caption is unit-verified (its live row at 20:53:33 predates D12).

### Not verified (environment limits)

- **Automatic triggers → phone inside a live session** — **superseded for the main paths**: permission ask, turn-boundary classification (question + finished), form question, tool error, and custom sends are all live-verified above. Still unit-tested only: `idleMode`/`patterns` escape hatches, `events.<name>.enabled: false` at runtime, error-cooldown cadence under sustained flapping, plugin unload.

### Deviations from rev 2

- **D1 — events, not a permission hook.** Question triggers are `permission.asked` (fires exactly when the request is published) and `form.created`, plus the idle classifier; `questions.ts` was folded into `events.ts`.
- **D2 — missing token publishes unauthenticated** (supersedes A6/B5): zero-config bias; a `401/403` response logs an actionable hint (set `NTFY_TOKEN` or allow anonymous publishing) instead of silently disabling.
- **D3 — idle fallback clarified:** a question-classified idle with `events.question` disabled falls back to a finished ping; a finished-classified idle with finished disabled sends nothing.
- **D4 — zero-config topics:** `baseTopic` is auto-generated (`opencode-<10hex>`) and persisted in `ctx.storage` on first run when unset; the startup log prints the subscribe topic (single topic per D9).
- **D5 — root `index.ts` required:** the local-plugin loader probes the package root and ignores `package.json` `main`/`exports` pointing into `src/`; without a root `index.ts` the entry is skipped *silently* (no error, no log). Ship `index.ts` re-exporting `src/index.ts`.
- **D6 — npm name collision:** `opencode-ntfy` already exists on npm (stephanvs, v0.1.3 — a different plugin). Local-path installs are unaffected; README warns against `opencode plugin add opencode-ntfy`. ~~Decide on a rename/scope before ever publishing.~~ **Resolved 2026-09-21 (§14-D13):** distribution goes through the project website + `install.sh` — **no npm publish** — so the collision is moot; the rename/scope question revives only if npm publishing is ever reconsidered.
- **D7 — three access modes + setup script (post-v1 enhancement).** `src/access.ts` auto-detects local / tailscale / cloudflare from `serverUrl` and prints per-mode startup guidance (`access mode:` / `hint:` / `warning:` lines); an explicit `accessMode` option overrides detection (invalid values fall back to auto). `scripts/setup-server.sh` provisions a server in any mode — idempotent, sets `base-url` to the phone-facing URL (required for the iOS wake hash), and handles mode extras (`tailscale serve` / cloudflared tunnel + DNS + launchd). Tests: 26 → 35.
- **D8 — process-shared dedupe state (bug fix).** OpenCode can run `setup()` several times concurrently in one process on the shared event bus (observed: 3 copies within ~1 ms). Dedupe/cooldown/log-rate-limit state therefore lives in a `globalThis` store keyed by `Symbol.for("opencode-ntfy.dedupe-state")` and is shared by every `Notifier` via `sharedState()`; `new Notifier(config)` without an explicit state stays instance-local (tests, embedding). Rationale: the first instance to check-and-set wins on the single-threaded event loop, so duplicate copies suppress each other — this also fixed cross-instance question→finished suppression and error-cooldown counting, which were equally broken. Tests: 35 → 39.
- **D9 — single topic for everything (before first publish).** All four event kinds publish to `baseTopic` itself; the `-question|-finished|-error|-custom` suffixes and the per-kind `topics` override map are removed (the `ntfy_notify` per-call `topic` input stays as a power-user escape hatch). The kind travels in title/priority/tags (default tags: `question` / `heavy_check_mark` / `rotating_light`). Rationale: the ntfy iOS app has no wildcard subscriptions and no one-tap subscribe links (`ntfy://` deep links are Android-only), so the old scheme forced **four** manual subscriptions on iPhone — the app's absolute minimum is one server URL + one topic, which is what this yields, matching the project's top priority (easiest possible setup). Zero migration cost: the project has never been published (D6 still open). Trade-off accepted: per-kind phone-side subscription settings (mute one kind, loud another) are lost — `events.<name>.enabled/priority/tags` in plugin config provide the same control desktop-side. Side effect: §7.1 log buckets collapse to one topic (an outage logs one line per status class, not four — an improvement). Supersedes the routing row of §2, §5's `topics` option, §6's topic-suffix column, and D4's "four topics" wording. Tests: 39 (assertions updated; the transport rate-limit test now expects a single line).
- **D10 — turn-boundary trigger: `session.execution.succeeded` (primary), `session.idle` (secondary).** `session.idle` and `session.status` exist in the `V2Event` union but the server never emits them: an armed recorder captured `session.text.ended` + `session.execution.succeeded` 42 ms later at one boundary, zero `session.idle` — so the old `case "session.idle"` never ran, and `finished`/text-classified `question` had never fired live. The boundary case now handles both event names (same `{sessionID}` payload, same moment; the 10s D8 dedupe collapses both if upstream ever co-emits); outcome filtering (`interrupted`/`failed`) still runs in the handler as defense-in-depth. Live-verified 2026-09-21 (Finished push + user confirmation; text question with extraction caption confirmed next).
- **D11 — permission is its own event kind.** `permission.asked` publishes as `permission` (not `question`): defaults `urgent` (5) + tag `lock`, independent `events.permission.enabled` toggle. Rationale: a permission ask means the agent is *blocked waiting on the user* — different urgency and toggle semantics from a conversational question. Consequence: permission no longer sets question-suppression state, so it does not suppress a later `finished` (different moments — §6.2 updated). Live-verified 2026-09-21 20:53:33: `permission.asked` ×3 → exactly one push, row `priority=5 tags=lock`, `permission.replied` 14 s later.
- **D12 — Direction 3 hybrid captions (§6.4).** Structured telemetry/facts for finished/permission/error/form; the extracted question *sentence* for text questions (the only kind where the text itself is the payload). Supersedes first-N-chars message excerpts for every kind. Implementation: new `src/caption.ts`; per-turn telemetry from `session.execution.started` + `session.tool.*`, consumed at the boundary. Tests: 43 → 53.

## 14. Installation flows (post-v1; plan approved 2026-09-21)

Two delivery channels over **one shared non-interactive core** — the project's top priority (easiest possible setup) extended to installation itself. Both channels drive the same script; there is only ever one implementation of the steps.

### 14.1 Decisions (D13–D16, author-approved 2026-09-21)

| # | Decision |
| --- | --- |
| **D13** | **Distribution = project website + `install.sh`** (`curl -fsSL <site>/install.sh -o install.sh && sh install.sh`); **no npm publish** — resolves D6 (the `opencode-ntfy` name collision becomes moot; §13-D6 updated) |
| **D14** | **The CLI *is* the shell script** (no Node bin): sh drives prompts/flow; embedded `node -e` does JSON-safe `opencode.json` edits (Node is guaranteed — OpenCode requires it) |
| **D15** | **Agent channel = `INSTALL.md`** in the repo — paste to any agent; it asks the same questions conversationally and runs the same commands. An OpenCode command/skill wrapper is an optional later nicety |
| **D16** | Wizard scope: **provision-focused** — bring-your-own-server and the ntfy.sh hosted trial are **out of the wizard** (existing-server users keep the README manual path, so nobody is locked out); the **customize step stays in** (per-kind multi-select, all five on by default) |

### 14.2 Question flow (both channels ask the same questions)

**Tier 1 — always ask:**

1. **Access mode** — `local` (super-local LAN) / `tailscale` / `cloudflare`, with branch inputs (`CF_HOSTNAME`, login checks, LAN-IP confirm)
2. **Config scope** — global `~/.config/opencode/opencode.json` vs this project's `opencode.json`
3. **Which notifications** — all five (recommended default) or *customize* → per-kind toggles (`question` / `permission` / `finished` / `error` / `custom`) → written as `events.<kind>.enabled`

**Tier 2 — only when detection forces it (never routine prompts):**

- missing dependency → consent prompt ("not found — install via Homebrew?")
- default port occupied → offer `NTFY_PORT` (e.g. 8080); the URL is adjusted automatically
- phone OS → only tailors the final instructions (iOS wake explanation vs Android/FCM note)

**Never asked** (auto — this is where the seamlessness comes from): topic (auto-generated, D4/D9), auth + token (always on: anonymous read-only; token created and wired silently by the tool), `upstream-base-url` (always — required for iOS), priorities/tags/`idleMode`/`patterns`/cooldown/dedupe (defaults, surfaced as a commented *advanced* block), Docker engine choice, tunnel/LaunchAgent reuse, idempotent re-runs.

### 14.3 Shared non-interactive core — contract (Phase 1 ✅ live-verified 2026-09-21)

`scripts/setup-server.sh` is the single implementation that `install.sh`, `INSTALL.md`, and the README manual path all drive.

```
$ setup-server.sh [--json] local|tailscale|cloudflare   # provision/switch mode (idempotent)
$ setup-server.sh [--json] preflight [mode]             # readiness report: no writes, no prompts, no daemon start
```

- **Env:** `NTFY_PORT` (default 80), `CF_HOSTNAME` (cloudflare; required without a TTY), `LAN_IP` (local mode — overrides LAN auto-detection), `NTFY_SETUP_DIR`, `NTFY_USER`
- **Exit codes:** `0` ok · `2` usage · `3` missing dependency/login/input · `4` port conflict · `5` runtime/verification failure (any other non-zero = unexpected command failure — the JSON still reports it)
- **`--json`:** human text → **stderr**; exactly **one JSON object → stdout**:
  - setup success: `{"ok":true,"kind":"setup","mode","serverUrl","user","token","port","smoke":{"anon","tokenPublish","public"},"warnings":[…]}` — warning codes: `public-url-unreachable`, `tailscale-serve-pending`
  - any failure: `{"ok":false,"kind","mode","code","error"}`
  - preflight: `{"ok":…,"kind":"preflight","mode","port","checks":[{"id","ok","value"?,"hint"?}]}` — checks: `docker-cli`, `docker-compose`, `docker-daemon` (stopped-but-colima-installed counts as ok — setup auto-starts it), `port-<N>` (severity 4; skipped when our own container already holds port 80), plus per-mode `lan-ip` / `tailscale-cli`+`tailscale-login` / `cloudflared-cli`+`cloudflared-login`+`cloudflare-hostname`. Scoring: exit `4` if any port check failed, else `3` if any required check failed, else `0`
- **Evidence (2026-09-21, maintainer machine):** `--help` → 0; `bogus` / no-mode-non-TTY / conflicting-modes / non-numeric `NTFY_PORT` → **2 + JSON**; `preflight --json` → **0** with a parsed 4-check machine report; `preflight cloudflare` without hostname → **3** (`cloudflare-hostname.ok:false`); occupied `NTFY_PORT` (live `node` listener) → **4**, owner named, **died before any file writes**; full idempotent `--json cloudflare` re-run → **0, exactly one stdout line**, `smoke 403/200/200` through the live tunnel, same user/token reused, `warnings:[]`. Tests **53 → 59**: the hermetic contract suite pins usage/exit-codes/JSON-shape/preflight/port-conflict (no full run in-suite — no network or server mutation).

**Topic surface — resolved (Phase 2):** the installer *proposes* a fresh `opencode-<10hex>` (crypto-random) and the config writer keeps any `baseTopic` already present (re-run safety), writing it as an explicit option — so the phone instructions are complete before OpenCode ever starts, and the test push targets the exact topic. D4's `ctx.storage` + startup-log path remains the zero-config fallback for manual installs.

### 14.4 The two channels (Phases 2–3)

**Channel A — website → `install.sh`:** preflight (offer to install missing deps, with consent) → Tier-1 questions → clone the plugin to a stable path (or use the checkout it runs from) → `setup-server.sh --json <mode>` → `node -e` config write (JSON-safe merge: preserves unrelated keys/entries, keeps an existing `baseTopic`) → print topic + phone steps → test push → success summary (mode-switch + uninstall notes). Every question has an env override (`NTFY_MODE`, `NTFY_SCOPE`, `NTFY_EVENTS`, `NTFY_PHONE`, `NTFY_INSTALL_DEPS`, `NTFY_SKIP_CONFIRM`, plus the core's `CF_HOSTNAME`/`NTFY_PORT`/`LAN_IP` and `NTFY_CONFIG_FILE` for an exact config path), so the same wizard runs with zero prompts for agents and tests. Exit codes: `0` ok · `2` usage/input · `3` missing dependency · otherwise `setup-server.sh`'s code passes through. Portability: POSIX `sh` + ubiquitous `local` only — temp-file redirection instead of herestrings, guarded `pipefail`, no `$''`/`[[` (so `sh install.sh` works under bash/dash/ash).

**Channel B — `INSTALL.md`:** the runbook drives **the same `install.sh` via env vars** (single implementation — no second config writer to drift), but the *conversation* belongs to the agent: it asks the Tier-1 questions in chat, runs `setup-server.sh preflight --json` itself first and resolves every check (deps with user consent, port, hostname, LAN IP) so the wizard runs with **zero prompts**, executes Steps 1-5: preflight → wizard → config read-back → phone instructions → *wait for the user's confirmation in chat* → visible test push → verification table. It also covers Path B (bring-your-own-server, D16's carve-out) by writing the plugin entry directly with `baseTopic` left to D4 auto-generation, plus the restart reminder (new plugin loads on next start).

### 14.5 Gotchas both flows encode (paid for in live testing)

1. Tailscale Serve: approval link → **re-run the serve command after approval** (approval alone applies nothing); the first request after start can race proxy warm-up → retry
2. Mode switch ⇒ phone must **re-subscribe** (wake hash = `sha256(base-url + "/" + topic)`; iOS subscriptions are keyed by server URL)
3. macOS: ntfy has no native server → Colima/Docker path; **never kill existing cloudflared** (LaunchAgent reuse is detection-based)
4. Adding the plugin needs one OpenCode (re)start; changing its options hot-reloads
5. Local-path installs need the root `index.ts` (D5); both config spellings documented
6. Anonymous access = read-only by design (topic = read secret); only the plugin's token may publish

### 14.6 Build phases

1. ✅ **Non-interactive core** — `--json`, exit codes, `preflight`, `NTFY_PORT` (implemented + live-verified 2026-09-21; tests 53 → 59)
2. ✅ **`install.sh` wizard** — implemented + live-verified 2026-09-21: env-driven run with zero prompts; re-run merge (topic kept + per-kind `enabled: false`); piped-answers interactive run; test push HTTP 200 → DB rows on both wizard topics; all invalid-env paths exit 2 before any change (tests 59 → 65). One bug found & fixed live: octal emoji escapes are not interpreted in bash string assignment → literal invalid JSON escape → ntfy 400 (now a literal UTF-8 emoji in the payload).
3. ✅ **`INSTALL.md` runbook** — written + dogfooded 2026-09-21: a **clean subagent (fresh context, runbook alone)** executed it end-to-end — preflight → wizard (env-driven, zero prompts) → config read-back → both test pushes, all exit 0 / HTTP 200, scratch config only, real config untouched (mtime proof) — and surfaced **5 doc defects, all fixed**: (1) Step-1 preflight snippet omitted the `CF_HOSTNAME` env (fresh run exits 3), (2) env block with `#` comments after `\` continuations — a literal paste silently drops every env var, (3) `NTFY_CONFIG_FILE` undocumented, (4) Step-4 curl used `$SERVER_URL/$TOPIC/$TOKEN` never defined, (5) Step-5 table fields (smoke 403/200/200, provisioning status) never flagged for capture in Step 2. Drift test extended to guard #2/#3/#4 (tests 65 → 66).
4. ⬜ Website (repo Pages: overview, both install paths, config reference, troubleshooting) + README restructure around the two channels
5. ⬜ Dogfood: wizard fresh in all three modes (the `INSTALL.md` clean-subagent half is done — Phase 3)

---

## 15. Uninstall flows (plan approved 2026-09-21)

### 15.1 Component inventory (what uninstall must reverse)

| # | Component | Where | Auto? |
|---|---|---|---|
| 1 | Plugin config entry | global/project `opencode.json` | ✅ `node -e` JSON edit — exact mirror of the installer's matcher (`plugin` tuple **and** `plugins` object form) |
| 2 | Plugin code | `~/.local/share/opencode-ntfy` (clone) vs the user's own checkout | ⚠️ only the provably-ours clone (exact default path); a user checkout is never deleted |
| 3 | ntfy container | Docker `ntfy-ntfy` via `~/ntfy/docker-compose.yml` | ✅ `compose down`, data kept |
| 4 | Server data | `~/ntfy` (`server.yml`, `cache.db`, auth/token) | ✅ highest-consent tier only |
| 5 | Tunnel + persistence | cloudflared tunnel `ntfy` + LaunchAgent (`~/Library/LaunchAgents/*.plist`, detected by `<string>ntfy</string>` **content**, not filename — older installs may differ) + `launchctl` | ✅ proper APIs (`launchctl bootout`, `cloudflared tunnel delete`) — never `pkill` |
| 6 | DNS route | Cloudflare dashboard | ❌ manual step printed; harmless if left |
| 7 | Tailscale Serve | `tailscale serve reset` | ✅ serve config only — never the tailnet/TS app |
| 8 | Phone subscription | ntfy app | ❌ always manual — printed instructions |
| 9 | colima / docker / brew tools | — | 🚫 never — shared tools |
| 10 | OpenCode load state | — | restart-once reminder after config removal |

### 15.2 Decisions (D17)

- **D17a — three fixed levels, default L1** (author-approved; a component multi-select was rejected as more questions + more odd half-states):
  - **L1 — plugin only** (the common "stop bothering me"): remove the config entry in every scope where found, restart reminder. Server keeps running; phone subscription left (manual instructions offered).
  - **L2 — + server & infra:** `compose down`, LaunchAgent unloaded + plist deleted, `cloudflared tunnel delete`, `tailscale serve reset`. **Data kept** → re-installable via `setup-server.sh` (idempotent).
  - **L3 — + full wipe:** `rm -rf ~/ntfy` + our clone dir, gated by typed confirmation (the literal string `DELETE` in chat / script flag `--confirm-data=<exact path>` must match byte-for-byte). DNS + phone printed as manual steps.
  - Every level ends with the manual-steps block: phone subscription, DNS route, restart OpenCode once.
- **D17b — deliverable = script + runbook, no human wizard** (author-approved):
  - `scripts/uninstall.sh [--json] inventory|<level>` — same conventions as `setup-server.sh`: per-item status (`removed` / `skipped-already-gone` / `failed` / `manual`); exit `0` all requested done (already-gone counts) · `2` usage/no consent/bad input · `3` partial failure; honors `NTFY_SETUP_DIR`, `NTFY_CONFIG_FILE`, `NTFY_PLUGIN_DIR`; **`inventory --json` = read-only, always exit 0** (the safety net).
  - `UNINSTALL.md` — agent runbook with install's discipline: ask level → inventory → consent (typed `DELETE` for L3) → execute → **verify** (re-read config, `docker ps`, `launchctl`, tunnel list, serve status) → report table + manual steps.
  - A root interactive `uninstall.sh` wizard is deferred until demanded.
- **D17c — safety invariants:** inventory before any action (report-only default); config removal touches only our entry via the installer's matcher — ambiguous/stale-path candidates (moved checkout) are listed and confirmed with the user, never guessed; `rm -rf` only the exact default clone path (custom paths → printed manual command instead); data-deletion consent must name the exact path; idempotent (already-gone = `skipped`, exit 0); never `pkill` cloudflared, never remove brew/colima, never touch other config keys or the tailnet.
- **D17d — testing: no live destruction during development** (author-approved; shim fixtures instead):
  - L1 hermetic against the Phase-2 scratch configs (`/tmp/wizard-e2e.json`, `/tmp/wizard-pipe.json`, `/tmp/dogfood-agent.json` — real entries, disposable files) + fixtures for the `plugins` object form, stale/moved paths, and preservation of foreign sibling entries/keys.
  - L2/L3 via PATH-shim fixtures (fake `docker`/`launchctl`/`cloudflared`/`tailscale` binaries recording argv) asserting exact commands + consent gating.
  - Live runs are **inventory-only** (read-only). `UNINSTALL.md` dogfooded by a clean subagent: live inventory + scratch L1 for real, infra against shims.
  - An optional real L3 on this machine may run only after publish prep, at the author's discretion (the server is the dev default + demo, so default is to keep it).

### 15.3 Verification / report table (runbook output)

```
config entry ......... removed from <path> (re-read verified; sibling keys intact) | absent | ambiguous (stale left — ask user)
data dir ............. removed <path> (L3, irreversible) | kept | absent
clone dir ............ removed | left in place (user checkout) | absent
container ............ compose down (data kept) | absent
LaunchAgent .......... booted out + plist deleted | absent
cloudflared tunnel ... deleted (DNS route left — delete in dashboard if desired) | absent
tailscale serve ...... reset | not configured
dns route ............ MANUAL: delete it in the Cloudflare dashboard if desired
phone subscription ... MANUAL: delete it in the ntfy app
OpenCode ............. restart once to unload the plugin
```

(Extended during the U3 dogfood: `data dir` + `dns route` rows added so L3's
headline irreversible wipe and the DNS manual step have a place to be reported;
each row carries the cell vocabulary for `absent`/`ambiguous`/`kept` states.)

### 15.4 Build phases

1. ✅ **U1 — `scripts/uninstall.sh` core + L1** — implemented + live-inventoried 2026-09-21: `inventory --json` read-only survey green against the real machine (config/container/data-dir/launchagent/tunnel/tailscale-serve all detected; content-based plist matching even found the **pre-rename personal-label LaunchAgent** still live on this machine — proving the filename-agnostic rule in §15.1; the label itself is not in the repo); L1 removes both entry forms JSON-safely, preserves sibling keys + foreign entries, reports stale candidates as `skipped-ambiguous` with the `NTFY_REMOVE_PATHS` consent path, and never writes a file it cannot parse (exit 3, JSON still emitted). Scope rule guarded by a byte-identical real-global-config test (tests 66 → 79). One live fix: this cloudflared build has no `tunnel list --json` — inventory parses the plain table (column 2 = NAME) instead. (At U1 time levels 2/3 were exit-2 stubs — delivered by U2 below.)
2. ✅ **U2 — L2/L3** — implemented 2026-09-21, **no live destruction (D17d honored)**: L2 = `docker compose -f <data>/docker-compose.yml down` (data kept; `docker rm -f` only as no-compose fallback) → content-matched LaunchAgent `launchctl bootout` + plist delete → `cloudflared tunnel delete -f ntfy` (real flag verified live via `--help`: active connections block a plain delete) → `tailscale serve reset` (flag verified live too). L3 = data dir + the default clone, only after `--confirm-data=<DATA_DIR>` matches **byte-for-byte**, checked **before any mutation** (exit 2, no partial state); path sanity refuses `/`, `$HOME`, and the repo itself even with a match; custom plugin dirs/checkout and DNS route are reported `manual`, never deleted (D17c). Consent model: invoking `2` *is* the consent (data kept, re-provisionable); consent gaps / unreachable infra (docker daemon down, cloudflared missing) → `manual` with the exact recovery command and **exit 0** — `failed` (exit 3) is reserved for attempted-and-broke. Evidence: 7 PATH-shim tests (fake `docker`/`launchctl`/`cloudflared`/`tailscale` recording argv + marker-driven replies) assert exact commands, idempotent rerun, refusal-before-mutation, and that the repo/`$HOME` survive an L3; post-suite live inventory showed the real container/tunnel/serve/plist/config all still present. Live non-destructive smokes: both L3 refusals + `--confirm-data=/` guard, exit 2 read-only. Tests 79 → 85.
3. ✅ **U3 — `UNINSTALL.md` + clean-subagent dogfood** — written 2026-09-21 and dogfooded by a clean subagent (fresh context, runbook alone; live inventory + scratch L1 for real, L2/L3 against PATH shims + fake `HOME` per D17d) in **four adversarial passes**. Pass 1 executed all three levels end-to-end (exits `0/0/0/2/0` exactly as documented; consent gate refused with zero mutation) and surfaced **14 defects** — worst: the stale-entry signal documented as `status: ambiguous` never fires when a confirmed entry also exists (real signal = `stale:` inside `detail`), env overrides documented only under Step 2 although Steps 1/3 honor them (demonstrated live: a bare verify reported the *real* config after a scoped run), "one JSON object to stdout" false on exit 2, `launchctl` claimed as an inventory check (it is content-based file presence), the §15.3 report table had **no row for L3's headline data wipe or the DNS manual step**, and `node` prerequisite + exit 5 undocumented. All 14 fixed: runbook rewritten (env set-once section, `stale:` rule + ambiguous-recovery branch, no-JSON/ANSI/exit-5 contract, honest verify wording + sibling-key observation, id→row map + level→row matrix + exhaustive status→cell vocabulary, `plugin-dir` manual bullet, data-dir-not-hardcoded), **§15.3 extended with `data dir` + `dns route` rows** (now byte-pinned to the runbook by a new test). Pass 2 re-verified: 12/14 RESOLVED and caught **7 regression defects** (N1–N7) the rewrite itself introduced — stale "Exit `0` always", no-JSON carve-out missing exit 5, phantom recovery *commands* promised for `failed`/`unavailable` details (they carry error output / point at `manual` instructions), `kept` misfiled under the absent cells + L2's data-dir row sourced from inventory (the run emits none at L2), ANSI-colored `ERROR:` not byte-matchable, `bootout || unload` fallback omitted — all fixed; pass 3 confirmed 6/7 and caught N8–N9 (a two-line self-contradiction in the new Step-4 sourcing text) — fixed; final pass ruled **all RESOLVED, "runbook is done"**, no new contradictions, and every runbook-quoted look-for string grep-verified against actual script output. Safety held throughout: live inventory byte-identical to baseline after every pass, real config/`~/ntfy`/tunnel/plist untouched, fixtures cleaned. Drift guards: contract-strings test (incl. inventory-before-execute ordering + no-comment-after-backslash) + §15.3 byte-identity test; tests 85 → 87.
4. ⬜ **U4 — pointers** — website + README "Uninstall" section (folds into §14.6 Phase 4 or just after).

### 15.5 Publish-prep overlap (identifier sweep — joins the cleanup round)

Real hits found by grep while planning: `192.168.0.24` in `SPEC.md` §13 evidence **and in `INSTALL.md`'s Step-1 example**, `ntfy.tommyek.com` in `SPEC.md` evidence → replace with placeholders (`192.168.1.x`, `ntfy.example.com`); additionally sweep the repo for `tk_` (tokens) and real `<machine>.<tailnet>.ts.net` values. `LICENSE`'s `tomfc23` copyright line is intentional attribution, not a leak. The LaunchAgent label is already neutral (`com.opencode-ntfy.cloudflared`, `setup-server.sh:413`) — no rename needed.

---

## Appendix A — Judgment calls made in this revision

Confirm or override each; all have concrete defaults baked into the sections above.

1. **§6.1 heuristic shape** — trailing-`?` OR 15-phrase pattern list, final message only, whole-message scan for phrases, `?` only at end, patterns replace (not extend) defaults. *(Core fix — most consequential call.)*
2. **§6.1 bias** — toward `question`, on the reasoning that both branches notify so the cost asymmetry is urgency, not delivery.
3. **§6.2 asymmetry** — `finished` suppressible by recent `question`; reverse never suppressed.
4. **§6.3 error cooldown in v1** — 60s default, `(+N suppressed)` annotation; chose v1 because retry loops defeat the 10s dedupe and phone spam is the stated failure mode. *(Could have been deferred; arguing it's ~15 lines and high-impact.)*
5. **§7.1 log rule** — wall-clock 10min per `(topic, statusClass)`, plus recovery log; "per run" abandoned as ambiguous.
6. **§5.1 token fallback chain** — plugin self-resolves unresolved `{env:NAME}`; missing token → publishes **disabled** (not unauthenticated) unless `allowAnonymous: true`. *(Superseded rev 3: implemented as unauthenticated-by-default — see §13-D2.)*
7. **`patterns` replaces defaults** (vs. extends) — chosen so users can fully correct a bad built-in list without fighting it; default-off extensions possible later.

## Appendix B — Open questions for the author

1. **Idle heuristic buy-off (A1/A2):** does the phrase list + bias direction match how your agents actually end turns? If your agents habitually end everything with offers ("let me know…"), the bias will classify most finishes as questions — `idleMode`/`patterns` mitigates, but confirm the default is right for your workflow.
2. **Question priority:** implemented as `urgent` (5) for **all** question sub-kinds (one `events.question` priority — the original `high`-for-text / `urgent`-for-form split was collapsed); permission is `urgent` as its own kind (D11). Confirm the iOS sound/urgency mapping is what you want.
3. **`patterns` replace-vs-extend (A7):** replace is speced; say if you'd rather extend built-ins.
4. **Error cooldown value:** 60s assumed. If your sessions run long flaky test suites, you may want 120s+.
5. **Missing-token behavior (A6):** ~~speced as "disable publishes"~~ **resolved rev 3: unauthenticated-by-default with an actionable 401/403 log hint** (§13-D2) — chosen for zero-config ease.
6. **Env resolution (§5.1):** **resolved** — verified working end to end either way (§5.1).
