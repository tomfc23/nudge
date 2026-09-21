# Spec: `opencode-ntfy` — ntfy notifications plugin for OpenCode

**Status:** Implemented (rev 3 — post-implementation notes, verified against OpenCode v2.0.12)
**Target:** OpenCode V2 plugin API (`@opencode/plugin`)

## 1. Overview

An OpenCode plugin that publishes notifications to a **self-hosted ntfy server**, delivered to the **ntfy iOS app**. Covers built-in events (agent asking a question, task finished, errors) plus custom notifications triggered by the agent via a tool. All events are individually configurable.

Key references:

- OpenCode plugins guide: https://opencode.ai/v2/docs/build/plugins
- OpenCode config guide: https://opencode.ai/v2/docs/config/
- OpenCode plugins config: https://opencode.ai/v2/docs/plugins/
- ntfy install (self-hosting): https://docs.ntfy.sh/install/
- ntfy publishing: https://docs.ntfy.sh/publish/

## 2. Decisions (confirmed)

| Topic | Decision |
| --- | --- |
| Routing | **Per-event topics** (e.g. `opencode-question-<suffix>`) |
| Default events | Question (permission ask + forms + plain text questions), task finished, errors |
| Configurability | Per-event `enabled` / `priority` / `tags` map |
| Custom notifications | **Agent tool** (`ntfy_notify`) only; no slash command, no RPC in v1 |
| Auth | **ntfy access token**, resolved from env (see §5 for resolution rules) |
| Click action | **None** — no `click` header; tapping opens the ntfy app (iOS default) |
| Delivery path | ntfy iOS app subscribes to server topics; smoke-test background delivery first |

## 3. Architecture

```
OpenCode server
  └─ opencode-ntfy plugin
       ├─ event watcher (ctx.event.subscribe)      → finished / errors / idle classification
       ├─ permission.asked event watcher           → question notifications  (deviation: was a permission hook, §13-D1)
       ├─ form.created event watcher               → question notifications
       └─ ntfy_notify tool (ctx.tool.transform)    → custom notifications
            └─ publish.ts (fetch, JSON POST, bearer auth)
                 └─ self-hosted ntfy server (HTTP)
                      └─ ntfy iOS app (subscribed to per-event topics)
```

The plugin only **publishes**. All rendering, sound, and delivery to the phone is handled by the ntfy server + iOS app.

## 4. Repository layout

```
opencode-ntfy/
  index.ts                # root re-export (REQUIRED: opencode's loader probes the package root,
                          #   it does not follow package.json "main"/"exports" — §13-D5)
  package.json            # name: opencode-ntfy, type: module, main/exports: ./index.ts
  src/
    index.ts              # Plugin.define({ id: "ntfy", setup }) + cleanup
    config.ts             # options parsing, defaults, derived topics, token resolution
    publish.ts            # ntfy HTTP client (fetch, JSON publish, bearer auth, timeout)
    events.ts             # event-stream watcher: permission/form/question, finished/error, dedupe/cooldown
    classify.ts           # idle classification: question vs finished (heuristic, §6.1)
    tool.ts               # ntfy_notify tool registration
  README.md
  SPEC.md                 # this document
  scripts/test.ts         # 26-test suite (npm test via tsx)
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
    "baseTopic": "opencode-a8f3k2",       // unguessable suffix; topic = password
    "topics": {                            // optional per-event overrides
      "question": "...", "finished": "...", "error": "...", "custom": "..."
    },
    "events": {
      "question": {
        "enabled": true,
        "priority": "urgent",
        "tags": ["question"],
        "idleMode": "heuristic",           // "heuristic" | "always" | "off"  (§6.1)
        "patterns": null                   // optional replacement pattern list (§6.1)
      },
      "finished": { "enabled": true, "priority": "default", "tags": ["heavy_check_mark"] },
      "error":    { "enabled": true, "priority": "high", "tags": ["rotating_light"], "cooldownSec": 60 }
      },
      "dedupeWindowMs": 10000,
      "publishTimeoutMs": 5000,
      "failureLogIntervalMs": 600000         // §7
    }
  }]
}
```

Rules:

- Topics default to `${baseTopic}-question`, `${baseTopic}-finished`, `${baseTopic}-error`, `${baseTopic}-custom` when not overridden.
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

| Event | Topic suffix | Default priority | Detection |
| --- | --- | --- | --- |
| Question — permission ask | `-question` | `urgent` | `ctx.permission.hook("evaluate")`, publish when resulting `effect === "ask"`; payload includes action + resources |
| Question — form pending | `-question` | `urgent` | Pending-form events on the event stream |
| Question — plain text (agent waiting on user) | `-question` | `high` | Turn ends in idle **and** §6.1 classifies the final assistant message as a question |
| Task finished | `-finished` | `default` | Turn ends in idle **and** §6.1 classifies it as not-a-question |
| Error | `-error` | `high` | Assistant/tool error states and structured session errors on the event stream |

All events honor `events.<name>.enabled: false` to suppress.

### 6.1 Idle classification: question vs finished (primary gap resolution)

**Structured-signal check (done):** the OpenCode V2 plugins guide and API schema expose `Session.Message.Idle` (turn ended), forms (`Form.Info`, pending state), and permission `ask` effects — but **no structured "the agent is asking the user something" flag** on an idle turn-end. Permission asks and forms are already handled as first-class structured signals (table above). For plain conversational questions, no structured signal exists, so a **text heuristic on the final assistant message** is the fallback.

**Trigger:** exactly one notification per idle turn-end. The classifier maps the idle to `question` XOR `finished`; there is no idle that produces both or neither (unless one of the two events is disabled in config, in which case it produces the other).

**Inputs:** the last assistant message before the idle marker. Preprocess by concatenating its text parts, then stripping: fenced code blocks, inline code spans, URLs, and markdown emphasis/heading markers.

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

- `idleMode: "off"` — every idle → `finished` (pure turn-complete workflow).
- `idleMode: "always"` — every idle → `question` (user considers any turn-end worth an urgent ping).
- `patterns: [...]` — replace the default list for workflow-specific phrasing.

**Heuristic details [judgment call — confirm]:**

- Classification uses **only the final assistant message**, not the whole turn — avoids mid-conversation questions that were already answered.
- The whole message is scanned for pattern matches (rule 4), but only the **end** of the message is checked for `?` (rule 3) — a `?` mid-message in a status report ("2 tests failed. Investigating?") shouldn't dominate, but "let me know if…" trailing offers usually sit mid/final sentence.

### 6.2 Dedupe & precedence (symmetry resolved)

- **Per-idle exclusivity:** §6.1 guarantees exactly one of `question`/`finished` per idle — no same-moment double fire is possible by construction.
- **Dedupe key:** `(sessionID, event)` within `dedupeWindowMs` (default 10s), in-memory, cleared on cleanup. Retained for permission-ask storms and duplicate event-stream deliveries.
- **Question → finished suppression:** a `finished` notification for session S is suppressed if a `question` for S was published within `dedupeWindowMs`. Covers "user answers a permission ask immediately, turn ends <10s later" — the question is still fresh, the completion ping is noise.
- **Finished → question: never suppressed.** A question has strictly higher value; a `finished` published moments earlier does not make a new question stale. This is the deliberate asymmetry [judgment call — confirm]: the reverse rule would risk the exact missed-urgent-ping failure the classifier is biased to avoid. Note that this ordering is also rare in practice: permission/form asks fire *mid-turn*, before the idle that follows them.
- **Beyond the window:** a `finished` more than `dedupeWindowMs` after the last question fires normally — if the user took 30s to answer and the turn then genuinely completed, the completion ping is correct and wanted.

### 6.3 Error rate limiting (v1, not deferred)

**Included in v1** rather than future work: a flapping tool inside a single agent turn can emit error events back-to-back for many seconds, and the 10s `(sessionID, event)` dedupe only collapses near-simultaneous duplicates — a retry loop spaced at 15s intervals would pass straight through and page the phone dozens of times.

- **Rule:** per-session **error cooldown**, default `events.error.cooldownSec: 60`. First error fires immediately; subsequent error notifications for that session are suppressed until 60s after the last *published* error. Steady-state ceiling: **≤1 error ping per session per 60s**.
- Suppressed errors are counted; when the next error publishes after cooldown, its message appends `(+N similar errors suppressed)` so recurrence isn't hidden.
- Questions and finished need no equivalent cooldown — their rate is naturally bounded by turn cadence (one idle per turn) and the dedupe window.

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

- **Log key:** `(topicSuffix, statusClass)` where `statusClass` is `auth` (401/403), `client` (other 4xx), or `transport` (5xx / timeout / network).
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
    "topic":    { "type": "string" }   // optional override; defaults to -custom topic
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
    void watchEvents(ctx, config, controller.signal)  // events.ts: permission.asked/form.created
                                                      //   + idle classification (classify.ts)
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

### iOS delivery caveat (verify in step 0)

iOS background delivery relies on ntfy's push path (Firebase/APNS) or the app's connection/refresh behavior. **Before building the plugin**, verify a message sent while the iOS app is backgrounded is delivered promptly on the self-hosted instance. If it isn't, evaluate [UnifiedPush](https://docs.ntfy.sh/publish/#unifiedpush) or accept foreground/refresh-delivery timing. Do not build on top of an unverified delivery path.

## 11. Build order

0. **Server + iOS smoke test**: docker compose up → token → iOS app subscribes to `opencode-test-xyz` → `curl -H "Authorization: Bearer $NTFY_TOKEN" -d "hello" http://server/opencode-test-xyz` → confirm delivery while app is backgrounded. Decide delivery strategy here if flaky.
1. **Scaffold + publish client**: package, `Plugin.define`, config parsing, `publish.ts`. **Verify empirically whether `{env:NTFY_TOKEN}` arrives resolved or literal in `ctx.options`** (log a redacted marker in a throwaway run); confirm §5.1's dual-path resolution handles the observed behavior; update §5.1 with the finding. Standalone script proves publish works.
2. **Finished + error notifications**: event watcher, dedupe, error cooldown (§6.3), config gating, failure logging (§7.1).
3. **Question notifications**: permission `evaluate` hook, form watcher, idle classifier (§6.1), question-over-finished precedence (§6.2).
4. **`ntfy_notify` tool.**
5. **README**: server setup, token creation, iOS subscribe steps, config reference (incl. `idleMode`/`patterns`), security notes, future work.
6. **Test matrix** (manual):

   - [ ] Permission ask → `-question` (urgent), single notification
   - [ ] Idle ending in "…should I squash these commits?" → `-question`
   - [ ] Idle ending in "All tests pass." → `-finished`
   - [ ] Idle with `?` mid-message only, no trailing `?` → `-finished` (trailing rule)
   - [ ] `idleMode: "always"` / `"off"` / custom `patterns` behave as specified
   - [ ] Answer permission ask, turn ends within 10s → question only, no `finished`
   - [ ] `finished` >10s after last question → fires normally (reverse case un-suppressed)
   - [ ] Form prompt → `-question`
   - [ ] Flapping tool errors ≤1 ping/60s/session, `(+N suppressed)` on re-fire
   - [ ] `ntfy_notify` with defaults, with priority/tags, with topic override
   - [ ] `events.<name>.enabled: false` suppresses
   - [ ] Missing/invalid token → soft failure per §5.1, plugin still loads; failure logs at §7.1 cadence (first immediately, then ≤1/10min), recovery line on fix
   - [ ] Delivery while iOS app backgrounded
   - [ ] Plugin unload → no dangling subscriptions/timers

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

- **Plugin loads in a real server:** `opencode serve` in a test project with our package in config → `/api/plugin` reports `id: "ntfy"`, `source.type: "local"`, `state.status: "active"`, and the `[ntfy]` startup lines (server / auth / subscribe topics) print.
- **Config forms (both load a local package dir with options):**
  - `"plugins": [{ "package": "/abs/path", "options": {…} }]` — docs form
  - `"plugin": [["/abs/path" or "./rel/path", {…}]]` — tuple form from the published config schema
  - All earlier silent load failures traced to D5, not to the config key or path form.
- **`{env:NAME}` token:** `token: "{env:SMOKE_TOK}"` + `SMOKE_TOK=abc123` → published `Authorization: Bearer abc123` (loader pre-resolution and the plugin's regex path are indistinguishable; §5.1 handles both).
- **Publish path:** `scripts/smoke-publish.ts` against a local capture server received `POST /` with the expected topic, body, and auth header.
- **Regression:** `npm test` (26 tests: classifier, config/token chain, event→publish flow, dedupe/cooldown, log rate-limit, tool) and `tsc --noEmit` both green after all changes.

### Not verified (environment limits)

- **Real ntfy server + iOS delivery** (build-order step 0) — Docker is not installed on this machine. Needs: docker compose up → token → iOS subscribe → `curl` publish → confirm backgrounded delivery.
- **Live event → phone flow inside a running session** — would require model calls; event→publish logic is covered by tests with a fake fetch instead.

### Deviations from rev 2

- **D1 — events, not a permission hook.** Question triggers are `permission.asked` (fires exactly when the request is published) and `form.created`, plus the idle classifier; `questions.ts` was folded into `events.ts`.
- **D2 — missing token publishes unauthenticated** (supersedes A6/B5): zero-config bias; a `401/403` response logs an actionable hint (set `NTFY_TOKEN` or allow anonymous publishing) instead of silently disabling.
- **D3 — idle fallback clarified:** a question-classified idle with `events.question` disabled falls back to a finished ping; a finished-classified idle with finished disabled sends nothing.
- **D4 — zero-config topics:** `baseTopic` is auto-generated (`opencode-<10hex>`) and persisted in `ctx.storage` on first run when unset; the startup log prints all four subscribe topics.
- **D5 — root `index.ts` required:** the local-plugin loader probes the package root and ignores `package.json` `main`/`exports` pointing into `src/`; without a root `index.ts` the entry is skipped *silently* (no error, no log). Ship `index.ts` re-exporting `src/index.ts`.
- **D6 — npm name collision:** `opencode-ntfy` already exists on npm (stephanvs, v0.1.3 — a different plugin). Local-path installs are unaffected; README warns against `opencode plugin add opencode-ntfy`. Decide on a rename/scope before ever publishing.

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
2. **Question priority for plain-text questions:** spec uses `high` for text questions vs `urgent` for permission/form. Intentional (text questions are softer) — confirm iOS sound/urgency mapping is what you want.
3. **`patterns` replace-vs-extend (A7):** replace is speced; say if you'd rather extend built-ins.
4. **Error cooldown value:** 60s assumed. If your sessions run long flaky test suites, you may want 120s+.
5. **Missing-token behavior (A6):** ~~speced as "disable publishes"~~ **resolved rev 3: unauthenticated-by-default with an actionable 401/403 log hint** (§13-D2) — chosen for zero-config ease.
6. **Env resolution (§5.1):** **resolved** — verified working end to end either way (§5.1).
