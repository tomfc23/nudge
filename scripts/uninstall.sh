#!/usr/bin/env bash
#
# opencode-ntfy uninstall — inventory-first removal (SPEC §15, D17).
#
#   bash scripts/uninstall.sh [--json] inventory [--confirm-data=...]
#   bash scripts/uninstall.sh [--json] 1|2|3 --confirm-data=<exact data dir>
#
# Levels (D17a, cumulative):
#   1  remove the opencode-ntfy entry from opencode.json (every scope found).
#      The server keeps running; prints restart + phone notes.
#   2  + server & infra: compose down (data kept), LaunchAgent unloaded+deleted,
#      cloudflared tunnel deleted (-f; DNS route left — dashboard manual),
#      tailscale serve reset. Invoking level 2 IS the consent (data survives
#      and setup-server.sh re-provisions idempotently).
#   3  + full wipe: data dir + the default clone. REQUIRES
#      --confirm-data=<path> matching byte-for-byte; suspicious paths (/ or
#      $HOME or the repo itself) are refused even with a match (D17c).
#
# Non-interactive contract (SPEC §15.2, same conventions as setup-server.sh):
#   --json        human text -> stderr, exactly one JSON object -> stdout
#                 inventory: {ok:true,kind:"inventory",items:[{id,status,detail}]}
#                 uninstall: {ok,kind:"uninstall",level:N,items:[...]}
#                 statuses: present|absent|unavailable (inventory);
#                   removed|skipped-already-gone|skipped-ambiguous|failed|manual (L1-3)
#                 manual = could not be done/verified here, action printed — does
#                 NOT fail the run; failed = attempted-and-broke -> exit 3
#   exit codes:   0 ok (already-gone counts as done) · 2 usage/no consent/bad input
#                 · 3 partial (some requested item failed); inventory always 0
#
# Env: NTFY_CONFIG_FILE   exact config file — replaces the scope search entirely
#      NTFY_PLUGIN_DIR    default-clone override (custom dirs are NEVER deleted)
#      NTFY_REMOVE_PATHS  colon-separated extra entry paths to also remove — the
#                         confirmation mechanism for stale/moved checkouts (D17c:
#                         ambiguous candidates are reported, never guessed)
#      NTFY_SETUP_DIR, XDG_CONFIG_HOME   same semantics as setup-server.sh
#
# Never (D17c): pkill cloudflared · remove colima/docker/brew · touch other
# config keys · delete a user's own checkout · touch the tailnet.
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

TAB="$(printf '\t')"
OUT_FD=1
say()  { printf '\n\033[1m== %s\033[0m\n' "$*" >&$OUT_FD; }
info() { printf '   %s\n' "$*" >&$OUT_FD; }
ok()   { printf '   \342\234\223 %s\n' "$*" >&$OUT_FD; }
warn() { printf '   \342\230\240 %s\n' "$*" >&2; }
die() {
  code=2
  case "${1:-}" in ''|*[!0-9]*) ;; *) code="$1"; shift ;; esac
  printf '\033[31mERROR:\033[0m %s\n' "$*" >&2
  exit "$code"
}
usage() { cat <<'USAGE'
opencode-ntfy uninstall (SPEC §15)

  bash scripts/uninstall.sh [--json] inventory    read-only survey (always exit 0)
  bash scripts/uninstall.sh [--json] 1            L1: remove the plugin config entry
  bash scripts/uninstall.sh [--json] 2            L2: + server/infra (data kept)
  bash scripts/uninstall.sh [--json] 3 --confirm-data=<data dir>
                                                  L3: + wipe data dir + default clone
  bash scripts/uninstall.sh --help

Levels are cumulative: 3 = 1 + 2 + 3. Level 2 stops the server (notifications
pause until you re-provision with setup-server.sh).
Exit codes: 0 ok (already-gone counts) · 2 usage/no consent · 3 partial failure
            · inventory always 0. "manual" items do not fail the run.
Env: NTFY_CONFIG_FILE (exact file — replaces scope search) · NTFY_PLUGIN_DIR ·
     NTFY_REMOVE_PATHS (colon list — confirm stale/moved checkout entries) ·
     NTFY_SETUP_DIR · XDG_CONFIG_HOME
Never (D17c): pkill cloudflared · remove colima/docker/brew · touch other keys.
USAGE
}

# ------------------------------------------------------------------ args
JSON=0
CMD=""
CONFIRM_DATA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; OUT_FD=2 ;;
    --confirm-data=*) CONFIRM_DATA="${1#--confirm-data=}" ;;
    --confirm-data) die 2 "--confirm-data requires =<path> (e.g. --confirm-data=\$HOME/ntfy)" ;;
    -h|--help) usage; exit 0 ;;
    -*) die 2 "unknown option: $1" ;;
    *)
      [ -z "$CMD" ] || die 2 "single command expected (inventory|1|2|3), got '$CMD' and '$1'"
      CMD="$1" ;;
  esac
  shift
done
[ -n "$CMD" ] || die 2 "command required: inventory | 1 | 2 | 3 (see --help)"

# ------------------------------------------------------------------ paths
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
if [ -f "$SCRIPT_DIR/setup-server.sh" ] && [ -f "$REPO_ROOT/src/index.ts" ]; then
  PLUGIN_PATH="$REPO_ROOT"
else
  PLUGIN_PATH="${NTFY_PLUGIN_DIR:-$HOME/.local/share/opencode-ntfy}"
fi
DATA_DIR="${NTFY_SETUP_DIR:-$HOME/ntfy}"
CLONE_DEFAULT="$HOME/.local/share/opencode-ntfy"
TARGETS="$PLUGIN_PATH"
if [ -n "${NTFY_REMOVE_PATHS:-}" ]; then
  TARGETS="$TARGETS$(printf ':%s' "$NTFY_REMOVE_PATHS" | tr ':' '|')"
fi

ITEMS="$(mktemp)"
trap 'rm -f "$ITEMS"' EXIT
add_item() { printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$ITEMS"; }

list_config_files() {
  if [ -n "${NTFY_CONFIG_FILE:-}" ]; then
    printf '%s\n' "$NTFY_CONFIG_FILE"
    return
  fi
  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
  if [ -f "$PWD/opencode.json" ]; then printf '%s\n' "$PWD/opencode.json"; fi
}

# ------------------------------------------------------------------ config tool (node — JSON-safe, D14)
# prints: "<status>\t<detail>"  ·  modes: scan (read-only) | remove
CFG_JS='
var fs = require("fs"), path = require("path");
var file = process.argv[1], mode = process.argv[2];
var targets = (process.argv[3] || "").split("|").filter(Boolean);
function out(status, detail) {
  console.log(status + "\t" + String(detail === undefined ? "" : detail).replace(/[\t\n]/g, " "));
}
function fail(msg) { out("failed", msg); }
function ours(p) {
  return typeof p === "string" && (targets.indexOf(p) >= 0 || path.basename(p) === "opencode-ntfy");
}
function looksLikeOurs(o) {
  return !!o && typeof o === "object" && typeof o.serverUrl === "string" && ("baseTopic" in o || "token" in o);
}
var cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) {
  if (e && e.code === "ENOENT") { out("absent", "file not present"); process.exit(0); }
  fail("cannot read/parse: " + (e.message || e));
  process.exit(0);
}
if (cfg.plugin !== undefined && !Array.isArray(cfg.plugin)) { fail("\"plugin\" is not an array"); process.exit(0); }
if (cfg.plugins !== undefined && !Array.isArray(cfg.plugins)) { fail("\"plugins\" is not an array"); process.exit(0); }
var matched = [], stale = [];
var plugin = Array.isArray(cfg.plugin) ? cfg.plugin : null;
var plugins = Array.isArray(cfg.plugins) ? cfg.plugins : null;
if (plugin) {
  plugin.forEach(function (e) {
    var p = Array.isArray(e) ? e[0] : undefined;
    var o = Array.isArray(e) ? e[1] : undefined;
    if (ours(p)) matched.push(String(p));
    else if (looksLikeOurs(o)) stale.push(String(p));
  });
}
if (plugins) {
  plugins.forEach(function (e) {
    var p = e && e.package;
    var o = e && e.options;
    if (ours(p)) matched.push(String(p));
    else if (looksLikeOurs(o)) stale.push(String(p === undefined ? "?" : p));
  });
}
if (mode === "scan") {
  if (matched.length) out("present", matched.length + " entry/entries: " + matched.join(", ") + (stale.length ? "; stale: " + stale.join(", ") : ""));
  else if (stale.length) out("ambiguous", "stale (not at a known path): " + stale.join(", "));
  else out("absent", "0 entries");
  process.exit(0);
}
var removed = [];
if (plugin) {
  var kept = [];
  plugin.forEach(function (e) {
    if (Array.isArray(e) && ours(e[0])) removed.push(String(e[0]));
    else kept.push(e);
  });
  cfg.plugin = kept;
}
if (plugins) {
  var kept2 = [];
  plugins.forEach(function (e) {
    if (e && ours(e.package)) removed.push(String(e.package));
    else kept2.push(e);
  });
  cfg.plugins = kept2;
}
if (!removed.length) {
  if (stale.length) out("ambiguous", "stale (not removed; confirm with NTFY_REMOVE_PATHS): " + stale.join(", "));
  else out("absent", "0 entries");
  process.exit(0);
}
try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); }
catch (e) { fail("write failed: " + (e.message || e)); process.exit(0); }
var left = [];
try {
  var back = JSON.parse(fs.readFileSync(file, "utf8"));
  (Array.isArray(back.plugin) ? back.plugin : []).forEach(function (e) { if (Array.isArray(e) && ours(e[0])) left.push(String(e[0])); });
  (Array.isArray(back.plugins) ? back.plugins : []).forEach(function (e) { if (e && ours(e.package)) left.push(String(e.package)); });
} catch (e) { fail("verify read failed: " + (e.message || e)); process.exit(0); }
if (left.length) { fail("verify: still present: " + left.join(", ")); process.exit(0); }
out("removed", removed.length + " entry/entries removed: " + removed.join(", ") + (stale.length ? "; stale left — confirm with NTFY_REMOVE_PATHS if yours: " + stale.join(", ") : ""));
'

run_cfg() { # <file> <scan|remove> -> CFG_ST, CFG_DET
  R="$(node -e "$CFG_JS" "$1" "$2" "$TARGETS")" || die 5 "internal: node config tool failed for $1"
  [ -n "$R" ] || die 5 "internal: empty result for $1"
  CFG_ST="${R%%$TAB*}"
  CFG_DET="${R#*$TAB}"
}

# ------------------------------------------------------------------ state helpers (shared: inventory + L2)
# container_state -> "present\t<detail>" | "absent" | "ncli" | "unavail"
container_state() {
  if ! command -v docker >/dev/null 2>&1; then printf 'ncli\n'; return 0; fi
  LINE="$(docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null | awk '$1=="ntfy-ntfy"||$1=="ntfy-ntfy-1"{$1="";sub(/^ /,"");print;exit}' || true)"
  if [ -n "$LINE" ]; then printf 'present\t%s\n' "$LINE"; return 0; fi
  if docker info >/dev/null 2>&1; then printf 'absent\n'; else printf 'unavail\n'; fi
}
state_split() { # <raw> -> ST_V, ST_D (must return 0 — callers run under set -e)
  ST_V="${1%%$TAB*}"
  ST_D="${1#*$TAB}"
  if [ "$ST_D" = "$ST_V" ]; then ST_D=""; fi
  return 0
}
# find_plist -> path of the ntfy LaunchAgent (by CONTENT, not filename) or ""
find_plist() {
  LA_DIR="$HOME/Library/LaunchAgents"
  [ -d "$LA_DIR" ] || return 0
  for f in "$LA_DIR"/*.plist; do
    [ -f "$f" ] || continue
    if grep -q '<string>ntfy</string>' "$f" 2>/dev/null; then printf '%s' "$f"; return 0; fi
  done
  return 0
}
# tunnel_state -> present | absent | unavailable | unavailable-nocli
tunnel_state() {
  if ! command -v cloudflared >/dev/null 2>&1; then printf 'unavailable-nocli\n'; return 0; fi
  # no tunnel list --json on this cloudflared line — table's 2nd column is NAME
  TL="$(cloudflared tunnel list 2>/dev/null || true)"
  if printf '%s\n' "$TL" | awk '$2 == "ntfy" { f = 1 } END { exit f ? 0 : 1 }'; then
    printf 'present\n'
  elif [ -z "$(printf '%s' "$TL" | tr -d '[:space:]')" ]; then
    printf 'unavailable\n'
  else
    printf 'absent\n'
  fi
}
# serve_state -> present | absent | unavailable | unavailable-nocli
serve_state() {
  if ! command -v tailscale >/dev/null 2>&1; then printf 'unavailable-nocli\n'; return 0; fi
  if ! tailscale status >/dev/null 2>&1; then printf 'unavailable\n'; return 0; fi
  TS_OUT="$(tailscale serve status 2>/dev/null | head -3 || true)"
  if printf '%s' "$TS_OUT" | grep -qiE 'proxy|http'; then printf 'present\n'; else printf 'absent\n'; fi
}

# ------------------------------------------------------------------ inventory (read-only)
collect_inventory() {
  CONFIGS="$(mktemp)"
  list_config_files > "$CONFIGS"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    run_cfg "$f" scan
    add_item "config:$f" "$CFG_ST" "$CFG_DET"
  done < "$CONFIGS"
  rm -f "$CONFIGS"

  if [ -d "$CLONE_DEFAULT" ]; then add_item "clone-default" present "$CLONE_DEFAULT"; else add_item "clone-default" absent ""; fi

  CST="$(container_state)"; state_split "$CST"
  case "$ST_V" in
    present) add_item "container" present "$ST_D" ;;
    absent) add_item "container" absent "" ;;
    ncli) add_item "container" unavailable "docker CLI not installed" ;;
    *) add_item "container" unavailable "docker daemon not running" ;;
  esac

  # data-dir detail is ALWAYS exactly the path — it is L3's --confirm-data value
  if [ -d "$DATA_DIR" ]; then add_item "data-dir" present "$DATA_DIR"; else add_item "data-dir" absent "$DATA_DIR"; fi

  P="$(find_plist)"
  if [ -n "$P" ]; then add_item "launchagent" present "$P"; else add_item "launchagent" absent ""; fi

  TUN="$(tunnel_state)"
  case "$TUN" in
    present) add_item "tunnel" present "ntfy" ;;
    absent) add_item "tunnel" absent "" ;;
    unavailable-nocli) add_item "tunnel" unavailable "cloudflared not installed" ;;
    *) add_item "tunnel" unavailable "cloudflared tunnel list failed (logged out?)" ;;
  esac

  SERV="$(serve_state)"
  case "$SERV" in
    present) add_item "tailscale-serve" present "$(tailscale serve status 2>/dev/null | head -1 || true)" ;;
    absent) add_item "tailscale-serve" absent "" ;;
    unavailable-nocli) add_item "tailscale-serve" unavailable "tailscale not installed" ;;
    *) add_item "tailscale-serve" unavailable "not logged in / tailscaled down" ;;
  esac
}

# ------------------------------------------------------------------ output
print_items() {
  while IFS='|' read -r id st det; do
    [ -n "$id" ] || continue
    case "$st" in
      present|removed)                       ok "$id: $st${det:+ — $det}" ;;
      absent|manual|skipped-already-gone)    info "$id: $st${det:+ — $det}" ;;
      *)                                     warn "$id: $st${det:+ — $det}" ;;
    esac
  done < "$ITEMS"
}

emit_json() { # <kind> <ok 1|0> <extra-json>
  node -e '
var fs = require("fs");
var kind = process.argv[1], okv = process.argv[2] === "1", file = process.argv[3];
var extra = {};
try { extra = JSON.parse(process.argv[4] || "{}"); } catch (e) {}
var items = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(function (l) {
  var i = l.indexOf("|"), id = i < 0 ? l : l.slice(0, i);
  var rest = i < 0 ? "" : l.slice(i + 1);
  var j = rest.indexOf("|");
  var st = j < 0 ? rest : rest.slice(0, j);
  var det = j < 0 ? "" : rest.slice(j + 1);
  return { id: id, status: st, detail: det };
});
var o = { ok: okv, kind: kind };
Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
o.items = items;
console.log(JSON.stringify(o));
' "$1" "$2" "$ITEMS" "$3"
}

finish() { # <level>
  print_items
  OKV=1
  if awk -F'|' '$2 == "failed" { f = 1 } END { exit f ? 0 : 1 }' "$ITEMS"; then OKV=0; fi
  if [ "$JSON" = 1 ]; then emit_json uninstall "$OKV" "{\"level\":$1}"; fi
  if [ "$OKV" = 1 ]; then
    exit 0
  else
    exit 3
  fi
}

# ------------------------------------------------------------------ levels (cumulative)
run_l1() {
  REMOVED=0
  FAILED=0
  AMBIG=0
  CONFIGS="$(mktemp)"
  list_config_files > "$CONFIGS"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    run_cfg "$f" remove
    case "$CFG_ST" in
      removed)   REMOVED=1; add_item "config:$f" removed "$CFG_DET" ;;
      absent)    add_item "config:$f" skipped-already-gone "no opencode-ntfy entry" ;;
      ambiguous) AMBIG=1; add_item "config:$f" skipped-ambiguous "$CFG_DET" ;;
      *)         FAILED=1; add_item "config:$f" failed "$CFG_DET" ;;
    esac
  done < "$CONFIGS"
  rm -f "$CONFIGS"
  if [ "$REMOVED" = 1 ]; then
    add_item "restart" manual "start (or restart) OpenCode once to unload the plugin"
    add_item "phone-subscription" manual "left in the app so a reinstall resubscribes to the same topic — delete it there if you are done for good"
  elif [ "$AMBIG" = 1 ]; then
    info "no entry at a known path — stale candidates listed above (re-run with NTFY_REMOVE_PATHS=<path> if it is yours)"
  else
    info "no opencode-ntfy entry found anywhere — nothing to remove"
  fi
}

run_l2() {
  # --- container (data kept: plain down, no -v)
  CST="$(container_state)"; state_split "$CST"
  case "$ST_V" in
    ncli)
      add_item "container" skipped-already-gone "docker not installed"
      ;;
    unavail)
      add_item "container" manual "docker daemon not running — start it (colima start / Docker Desktop), then: docker compose -f $DATA_DIR/docker-compose.yml down"
      ;;
    absent)
      add_item "container" skipped-already-gone ""
      ;;
    present)
      COMPOSE="$DATA_DIR/docker-compose.yml"
      set +e
      if [ -f "$COMPOSE" ]; then
        COUT="$(docker compose -f "$COMPOSE" down 2>&1)"; CRC=$?
      else
        COUT="$(docker rm -f ntfy-ntfy 2>&1)"; CRC=$?
      fi
      set -e
      CERR="$(printf '%s' "$COUT" | tail -1)"
      POST="$(container_state)"; state_split "$POST"
      if [ "$ST_V" = "absent" ]; then
        if [ "$CRC" = 0 ]; then add_item "container" removed "compose down — data kept"
        else add_item "container" removed "container gone despite rc=$CRC"; fi
      elif [ "$ST_V" = "unavail" ]; then
        add_item "container" failed "docker unavailable after attempt: ${CERR:-no output}"
      else
        add_item "container" failed "stop failed (rc=$CRC): ${CERR:-no output}"
      fi
      ;;
  esac

  # --- LaunchAgent (content-detected; proper APIs, never pkill)
  P="$(find_plist)"
  if [ -z "$P" ]; then
    add_item "launchagent" skipped-already-gone ""
  elif ! command -v launchctl >/dev/null 2>&1; then
    add_item "launchagent" manual "launchctl missing — unload and rm $P yourself"
  else
    launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || launchctl unload "$P" 2>/dev/null || true
    if rm -f "$P" 2>/dev/null && [ ! -f "$P" ]; then
      add_item "launchagent" removed "$P"
    else
      add_item "launchagent" failed "could not delete $P"
    fi
  fi

  # --- cloudflared tunnel (-f: active connections block a plain delete)
  TUN="$(tunnel_state)"
  case "$TUN" in
    absent)
      add_item "tunnel" skipped-already-gone ""
      ;;
    unavailable|unavailable-nocli)
      add_item "tunnel" manual "cloudflared unusable — delete tunnel 'ntfy' in the Cloudflare dashboard if present (DNS route is a dashboard manual either way)"
      ;;
    present)
      set +e
      TOUT="$(cloudflared tunnel delete -f ntfy 2>&1)"; TRC=$?
      set -e
      TERR="$(printf '%s' "$TOUT" | tail -1)"
      if [ "$TRC" != 0 ]; then
        add_item "tunnel" failed "delete failed (rc=$TRC): ${TERR:-no output}"
      elif [ "$(tunnel_state)" = "present" ]; then
        add_item "tunnel" failed "still listed after delete"
      else
        add_item "tunnel" removed "tunnel deleted — DNS route left (delete in the dashboard if desired)"
      fi
      ;;
  esac

  # --- tailscale serve (config only — never the tailnet)
  SERV="$(serve_state)"
  case "$SERV" in
    absent)
      add_item "tailscale-serve" skipped-already-gone ""
      ;;
    unavailable-nocli)
      add_item "tailscale-serve" skipped-already-gone "tailscale not installed"
      ;;
    unavailable)
      add_item "tailscale-serve" manual "tailscale unavailable (not logged in?) — run 'tailscale serve reset' yourself if you used Serve"
      ;;
    present)
      set +e
      SOUT="$(tailscale serve reset 2>&1)"; SRC=$?
      set -e
      SERR="$(printf '%s' "$SOUT" | tail -1)"
      if [ "$SRC" != 0 ]; then
        add_item "tailscale-serve" failed "reset failed (rc=$SRC): ${SERR:-no output}"
      elif [ "$(serve_state)" = "present" ]; then
        add_item "tailscale-serve" failed "still configured after reset"
      else
        add_item "tailscale-serve" removed "serve config reset (rc=0)"
      fi
      ;;
  esac
}

run_l3() {
  # consent (--confirm-data == DATA_DIR) + path sanity were checked in dispatch
  if [ -d "$DATA_DIR" ]; then
    set +e
    rm -rf "$DATA_DIR" 2>/dev/null
    RRC=$?
    set -e
    if [ "$RRC" = 0 ] && [ ! -d "$DATA_DIR" ]; then
      add_item "data-dir" removed "$DATA_DIR (server data, cache, auth — gone)"
    else
      add_item "data-dir" failed "could not remove $DATA_DIR (rc=$RRC)"
    fi
  else
    add_item "data-dir" skipped-already-gone ""
  fi

  if [ -d "$CLONE_DEFAULT" ]; then
    set +e
    rm -rf "$CLONE_DEFAULT" 2>/dev/null
    CRC2=$?
    set -e
    if [ "$CRC2" = 0 ] && [ ! -d "$CLONE_DEFAULT" ]; then
      add_item "clone-default" removed "$CLONE_DEFAULT"
    else
      add_item "clone-default" failed "could not remove $CLONE_DEFAULT (rc=$CRC2)"
    fi
  else
    add_item "clone-default" skipped-already-gone ""
  fi

  # custom plugin dirs / checkouts are NEVER deleted (D17c)
  if [ "$PLUGIN_PATH" != "$CLONE_DEFAULT" ] && [ -d "$PLUGIN_PATH" ]; then
    add_item "plugin-dir" manual "left in place (not the default clone) — rm -rf $PLUGIN_PATH yourself if desired"
  fi
  add_item "dns-route" manual "delete the Cloudflare DNS record for your hostname in the dashboard if desired"
}

# ------------------------------------------------------------------ dispatch
case "$CMD" in
  inventory)
    say "inventory (read-only — nothing is changed)"
    collect_inventory
    print_items
    if [ "$JSON" = 1 ]; then emit_json inventory 1 "{}"; fi
    exit 0
    ;;

  1|l1)
    say "level 1 — removing the plugin config entry (the server keeps running)"
    run_l1
    finish 1
    ;;

  2|l2)
    say "level 2 — plugin + server + tunnel infra (data kept)"
    run_l1
    run_l2
    finish 2
    ;;

  3|l3)
    # (1) path sanity first — never print a "retry with..." hint for / or $HOME
    case "$DATA_DIR" in
      ""|/|"$HOME"|"$REPO_ROOT")
        die 2 "refusing to wipe suspicious data dir: '$DATA_DIR'"
        ;;
    esac
    # (2) typed consent, byte-for-byte (D17a-3)
    if [ "$CONFIRM_DATA" != "$DATA_DIR" ]; then
      die 2 "L3 wipes data — pass --confirm-data=$DATA_DIR (must match byte-for-byte)"
    fi
    say "level 3 — full wipe (plugin + server + infra + data + clone)"
    run_l1
    run_l2
    run_l3
    finish 3
    ;;

  *) die 2 "unknown command: $CMD (expected: inventory | 1 | 2 | 3)" ;;
esac
