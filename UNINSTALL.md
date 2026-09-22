# UNINSTALL.md — have your agent uninstall `opencode-ntfy`

Give this file (or its contents) to a coding agent with shell access — OpenCode,
Claude Code, or similar. It is a complete runbook: the agent asks which of three
fixed levels to remove, surveys what is installed (**read-only first**), takes
your consent, executes, re-verifies against the live machine, and reports a
table.

**If you are the agent reading this:** follow the steps in order. Do not
re-implement anything the script does — `scripts/uninstall.sh` is the single,
tested implementation. Never hand-edit `opencode.json` to remove the
plugin, never improvise infra teardown, always run the read-only inventory
before anything else, and never claim success without Step 3's re-check and
Step 4's report. When the script exits `2` on consent, re-ask the user — never
work around the gate.

---

## Contract

- **Prerequisites:** `bash` + `node` on PATH (the script shells out to `node`
  for every JSON read/write).
- **One core:** `scripts/uninstall.sh [--json] [--confirm-data=<data dir>]
  inventory|1|2|3` — the survey and all three levels. It uses the installer's
  matcher: both entry forms (`plugin` tuple and `plugins` object), sibling keys
  and foreign entries untouched (the file **is** rewritten as canonical 2-space
  JSON — indentation/newline normalized, content and key order preserved).
- **Levels (cumulative):** **L1** = config entry only — notifications stop, the
  server keeps running · **L2** = + server & tunnel infra — `compose down`
  (**data kept**, re-installable), LaunchAgent booted out + plist deleted,
  cloudflared tunnel deleted, `tailscale serve reset` · **L3** = + full wipe —
  data dir and the default clone, **irreversible**.
- **Exit codes:** `0` ok (already-gone counts as done) · `2` usage / consent
  missing or mismatched / bad input · `3` partial (some requested item
  `failed`) · `5` internal failure (`node` missing or broke — fix the
  environment, rerun once). **Exits `2` and `5` emit no JSON on stdout** — one
  `ERROR: …` line goes to stderr instead (ANSI-colored; match on the exit code,
  not a byte-exact string): branch on the exit code, never on JSON.
  `inventory` is read-only and exits `0` (bar the `5` environment case).
  `manual` items (self-service leftovers the script prints) never fail the run.
- **Consent for L3:** the user must type `DELETE` in chat, and you pass
  `--confirm-data=<data dir>` — byte-for-byte the `detail` of inventory's
  `data-dir` item. Even with an exact match the script refuses `/`, `$HOME`,
  and the repo itself.
- **Never:** `pkill` cloudflared (LaunchAgent APIs only) · remove
  colima/docker/brew/tailscale · guess ambiguous config entries (inventory lists
  stale candidates; you add **only** user-confirmed paths via
  `NTFY_REMOVE_PATHS`) · delete a checkout that is not the default clone.
- **Idempotent:** re-running is always safe — gone components come back as
  `skipped-already-gone`, exit `0`.

## Ask the user this (one chat round is enough)

| # | Question | Maps to |
|---|---|---|
| 1 | **Which level?** L1 stop notifications only · L2 + stop the server & tunnel, data kept · L3 + wipe all data (irreversible) | level `1`/`2`/`3` |
| 2 | L3 only — after Step 1, ask again with the real path: **type `DELETE`** to confirm wiping exactly `<data-dir>` | `--confirm-data=` |

Run every command below **from the repo root** (the directory containing
`scripts/uninstall.sh`). Always pass `--json`: human text goes to stderr, one
JSON object to stdout (exits `2`/`5` have none — see Contract).

## Environment overrides — set them once, before Step 1

Overrides are **rare** (most users need none), but if you use any, set them
once and prefix **every** command in Steps 1, 2 and 3 with the identical env —
inventory honors them too. A mismatch (bare Step 1, overridden Step 2) points
the run at different files and produces false results or an `--confirm-data`
loop:

`NTFY_CONFIG_FILE=<file>` exact config file, replaces the scope search ·
`NTFY_SETUP_DIR=<dir>` data dir — **its value is what `--confirm-data` must
match** · `NTFY_PLUGIN_DIR=<dir>` plugin dir (custom dirs are never deleted) ·
`NTFY_REMOVE_PATHS` colon list of Step-1-confirmed stale entries only ·
`XDG_CONFIG_HOME` standard config-root override.

---

## Step 1 — inventory (read-only; you run it)

```bash
bash scripts/uninstall.sh --json inventory
```

Exit `0` — nothing is ever changed by this command (the only non-zero
outcome is exit `5` if `node` is broken — see Contract). Show the user what it
found and carry
forward **all seven items' ids and statuses** (`config:<path>`, `clone-default`,
`container`, `data-dir`, `launchagent`, `tunnel`, `tailscale-serve`):

- the `data-dir` item's `detail` — always exactly the path; it is L3's
  `--confirm-data` value;
- **stale config entries:** any config item whose `detail` contains `stale:`,
  **or** whose `"status"` is `ambiguous` — both mean a candidate path at a
  moved location. Ask the user whether each listed path is theirs; if yes, add
  it to `NTFY_REMOVE_PATHS` (colon-separated for several) on **every**
  subsequent command. **Never add a path the user did not confirm.** An
  unconfirmed stale entry survives L1 and turns Step 3's config check into
  `ambiguous` — that is not success; come back here.
- component statuses (`container`, `launchagent`, `tunnel`, `tailscale-serve`:
  `present` vs `absent` / `unavailable`) — these decide which Step-4 rows apply.

## Step 2 — execute the level

```bash
bash scripts/uninstall.sh --json 1                                                        # L1
bash scripts/uninstall.sh --json 2                                                        # L2
bash scripts/uninstall.sh --json 3 --confirm-data=<data-dir detail from Step 1>           # L3
```

(prefix the same environment overrides as Step 1, if any — plus
`NTFY_REMOVE_PATHS` from Step 1's stale confirmation.)

- **L3 only, and only after the user typed `DELETE`** (Q2, with the real path
  from Step 1). Exit `2` (stdout empty) with an stderr line like
  `ERROR: L3 wipes data — pass --confirm-data=<path>` — the `ERROR:` prefix is
  ANSI-colored in raw output, so match on the exit code or the
  `L3 wipes data` text → consent or path doesn't match byte-for-byte: show the
  user the exact expected path, re-ask, retry. Do not tamper with flags or
  split the run.
- Exit `3` → an item `failed`: continue to Step 3, report it honestly and
  quote that item's `detail` — for `failed` items it carries the error output,
  not an instruction (recovery **instructions** live in `manual` details).
- Exit `5` → `node` problem: check the Prerequisites, rerun once.

## Step 3 — verify against the live machine (never trust the report alone)

Re-run the inventory — it is the whole survey, read-only: re-read config of
every scope the script saw, `docker ps`, plist presence under
`~/Library/LaunchAgents` (matched
by content — file presence, not load state; optionally run `launchctl list` to
confirm the agent is actually unloaded), tunnel list, serve status, plus the
data and clone dirs:

```bash
bash scripts/uninstall.sh --json inventory
```

Expected end-state per level:

| level | after (item statuses) |
|---|---|
| L1 | config `absent`; container / launchagent / tunnel / serve **unchanged** |
| L2 | L1 + `container` `absent` + `launchagent` `absent` + `tunnel` `absent` + `tailscale-serve` `absent`; **`data-dir` still `present`** |
| L3 | L2 + `data-dir` `absent` + `clone-default` `absent` |

Config `ambiguous` here → a stale entry survived (Step 1): ask the user about
it and re-run L1 with `NTFY_REMOVE_PATHS`. Also **re-read the config file
yourself and confirm foreign keys/entries are unchanged** — only then may you
print the config row's `(re-read verified; sibling keys intact)` claim.
Anything else that doesn't match → do not claim success: flag it as a note
under the Step-4 table (and as `FAILED: <detail>` for run items). An infra item
that stayed `unavailable` in inventory
only names the condition (`docker daemon not running`, `cloudflared not
installed`, …) — the actionable recovery instruction (shell command or
dashboard step) is in the Step-2 run's `manual` item for that component.

## Step 4 — report + manual steps

Report exactly these rows — every row the level covers that you actually
observed — with each cell per the vocabulary below. Rows map to script item ids:
`config:<path>`→config entry · `data-dir`→data dir · `clone-default` and
`plugin-dir`→clone dir · `container`/`launchagent`/`tunnel`→their rows ·
`tailscale-serve`→tailscale serve · `dns-route`→dns route ·
`phone-subscription`→phone · `restart`→OpenCode. Row coverage per level: L1 =
config entry (+ phone/OpenCode when an entry was removed) · L2 adds data dir,
container, LaunchAgent, cloudflared tunnel, tailscale serve · L3 sets data dir
to removed and adds clone dir + dns route. Cells come from **the run's items**
for what changed and **Step 3's inventory** for what persists — the run emits a
`data-dir` item only at L3, so L2's data dir row is inventory `present` →
`kept`. Vocabulary, mapped exhaustively:

- run `removed` → that row's action cell (`removed`, `removed from…`,
  `removed <path>…`, `compose down…`, `deleted…`, `reset`, `booted out…`) ·
- run `skipped-already-gone` or inventory `absent` → `absent` /
  `not configured` ·
- inventory `present` on a row you didn't touch → `kept` (means *still
  there* — never file it under the absent cells) ·
- config only: run `skipped-ambiguous` or inventory `ambiguous` →
  `ambiguous (stale left — ask user)` ·
- run `failed` → print that row's cell as `FAILED: <detail verbatim>` — details
  carry the error output, not an instruction (run exits 3) ·
- run `manual` / inventory `unavailable` → append the detail to that row as a
  self-service parenthetical (recovery **instructions** appear only in `manual`
  details; the three infra rows have no `MANUAL:` cell of their own) ·
- `plugin-dir` manual → clone dir's `left in place (user checkout)` cell.

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

(`booted out + plist deleted` = the script ran `launchctl bootout` (falling
back to `unload`) and verified the plist **file** gone; assert load state only
if you ran `launchctl list`.)

Then the manual block, as applicable:

- **phone subscription** — delete it in the ntfy app (a leftover sub is inert;
  a reinstall re-subscribes automatically otherwise).
- **DNS route** — delete in the Cloudflare dashboard if desired; harmless if left.
- **plugin dir** (`plugin-dir` manual item, L3) — the script never deletes a
  checkout that isn't the default clone; its `rm -rf <path> yourself` detail is
  informational. Only remove that directory if the user explicitly asks.
- **OpenCode** — start (or restart) once to unload the plugin (only when a
  config entry was removed; option changes otherwise hot-reload).
- **cloudflared started by hand?** the script only stops the LaunchAgent — if
  the user launched cloudflared manually, they stop it themselves (never
  `pkill` from here).
- **L2 — data kept:** the `data-dir` path from Step 1 survives; re-provision any
  time with `bash scripts/setup-server.sh` (idempotent), or copy the dir to
  another machine first.

---

## Which level when?

| The user wants | Level |
|---|---|
| Stop the notifications, keep everything else | L1 |
| Move to another machine / take a break — server down, data kept | L2 (copy the data dir first if the history should survive) |
| Gone for good, reclaim the disk | L3 — irreversible: `cache.db`, auth, topics |
