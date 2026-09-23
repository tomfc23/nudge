#!/usr/bin/env bash
#
# Nudge installer for OpenCode and Codex.
#
#   human (from the project website):
#     curl -fsSL https://nudge.tommyek.com/install.sh -o install.sh && sh install.sh
#   from a checkout:
#     sh install.sh
#   scripted / agent-driven (every question has an env override; unset = prompt):
#     NTFY_MODE=cloudflare CF_HOSTNAME=ntfy.example.com NTFY_SCOPE=global \
#     NTFY_EVENTS=all NTFY_PHONE=ios NTFY_INSTALL_DEPS=1 NTFY_SKIP_CONFIRM=1 \
#     sh install.sh
#
# What it does: asks which harnesses, then provisions the server and writes
# the selected harness configs while preserving unrelated settings; walks through the
# one manual step (phone subscription) -> sends a test push -> summary.
#
# Question env overrides:
#   NTFY_HARNESSES    both | opencode | codex           which agents to configure
#   NTFY_MODE         local | tailscale | cloudflare    how the phone reaches the server
#   NTFY_SCOPE        global | project                  which agent config scope to write
#   NTFY_EVENTS       all | csv of ENABLED kinds        question,permission,finished,error,custom
#   NTFY_PHONE        ios | android | none              tailors the final instructions
#   NTFY_INSTALL_DEPS 1 (auto-yes) | 0 (auto-no)        answers the Homebrew/log-in consents
#   NTFY_SKIP_CONFIRM 1                                 skip the subscribe-wait + "did it arrive?"
# Other env: CF_HOSTNAME, NTFY_PORT, LAN_IP, NTFY_SETUP_DIR, NTFY_CONFIG_FILE
#            (exact config path — wins over NTFY_SCOPE), NTFY_PLUGIN_DIR,
#            NTFY_SITE_URL (default: https://nudge.tommyek.com), NTFY_REPO_URL.
#
# Exit codes: 0 ok · 2 usage/bad input/EOF · 3 required dependency missing ·
#             otherwise the exit code of scripts/setup-server.sh (its 2/3/4/5).
#
# Runs under sh (bash/dash/ash) and bash; needs node.

set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

# ------------------------------------------------------------------ output
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \342\234\223 %s\n' "$*"; }
warn() { printf '   \342\230\240 %s\n' "$*" >&2; }
die() {
  code=2
  case "${1:-}" in ''|*[!0-9]*) ;; *) code="$1"; shift ;; esac
  printf '\033[31mERROR:\033[0m %s\n' "$*" >&2
  exit "$code"
}
usage() {
  cat <<USAGE
Nudge installer

  sh install.sh                     interactive wizard
  NTFY_MODE=... sh install.sh       scripted / agent-driven (see header env list)

Questions: harnesses (both|opencode|codex) -> access mode (local|tailscale|cloudflare) -> config scope (global|project)
-> which notifications (all or per-kind) -> phone OS -> (preflight fixes deps).
Env overrides: NTFY_HARNESSES NTFY_MODE NTFY_SCOPE NTFY_EVENTS NTFY_PHONE NTFY_INSTALL_DEPS
NTFY_SKIP_CONFIRM CF_HOSTNAME NTFY_PORT LAN_IP NTFY_CONFIG_FILE NTFY_SETUP_DIR
NTFY_PLUGIN_DIR NTFY_SITE_URL NTFY_REPO_URL

Exit codes: 0 ok · 2 usage/input · 3 missing dependency · else setup-server.sh's
USAGE
}

REPLY_V=""
TAB="$(printf '\t')"

ask() { # <prompt> — required line
  printf '%s' "$1"
  read -r REPLY_V || die 2 "no input (set the NTFY_* env overrides — see the header of install.sh)"
}
ask_default() { # <prompt> <default>
  printf '%s' "$1"
  read -r REPLY_V || die 2 "no input (set the NTFY_* env overrides — see the header of install.sh)"
  [ -z "$REPLY_V" ] && REPLY_V="$2"
}
ask_yn() { # <prompt> <default y|n> — 0 yes / 1 no
  case "${2:-n}" in y) yn="Y/n" ;; *) yn="y/N" ;; esac
  printf '%s [%s] ' "$1" "$yn"
  read -r REPLY_V || die 2 "no input (set NTFY_INSTALL_DEPS=1|0 to script the consents)"
  case "$REPLY_V" in
    y|Y|yes|YES) return 0 ;;
    n|N|no|NO)   return 1 ;;
    *)           [ "${2:-n}" = y ] && return 0 || return 1 ;;
  esac
}
menu() { # <prompt> <valid...> — first valid is the default; sets REPLY_V (max 3 tries)
  mp="$1"; shift
  mdef="$1"
  mtries=0
  while [ "$mtries" -lt 3 ]; do
    printf '%s [%s]: ' "$mp" "$mdef"
    read -r REPLY_V || die 2 "no input (set the NTFY_* env overrides — see the header of install.sh)"
    [ -z "$REPLY_V" ] && REPLY_V="$mdef"
    for mv in "$@"; do
      if [ "$REPLY_V" = "$mv" ]; then return 0; fi
    done
    mtries=$((mtries + 1))
    printf '   invalid choice — one of: %s (try %s/3)\n' "$*" "$mtries"
  done
  die 2 "too many invalid answers"
}
consent() { # <prompt> — used for optional dependency installs
  if [ "${NTFY_INSTALL_DEPS:-}" = "1" ]; then info "$1 — yes (NTFY_INSTALL_DEPS=1)"; return 0; fi
  if [ "${NTFY_INSTALL_DEPS:-}" = "0" ]; then info "$1 — no (NTFY_INSTALL_DEPS=0)"; return 1; fi
  ask_yn "$1" n
}
need_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  die 3 "Homebrew not found — install it first (https://brew.sh), then re-run this installer"
}

# ------------------------------------------------------------------ arguments + env validation (fail fast)
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) die 2 "unknown argument: $arg" ;;
  esac
done
if [ -n "${NTFY_MODE:-}" ]; then
  case "$NTFY_MODE" in
    local|tailscale|cloudflare) ;;
    *) die 2 "NTFY_MODE must be local|tailscale|cloudflare (got: $NTFY_MODE)" ;;
  esac
fi
if [ -n "${NTFY_HARNESSES:-}" ]; then
  case "$NTFY_HARNESSES" in
    both|opencode|codex) ;;
    *) die 2 "NTFY_HARNESSES must be both|opencode|codex (got: $NTFY_HARNESSES)" ;;
  esac
fi
if [ -n "${NTFY_SCOPE:-}" ]; then
  case "$NTFY_SCOPE" in
    global|project) ;;
    *) die 2 "NTFY_SCOPE must be global|project (got: $NTFY_SCOPE)" ;;
  esac
fi
if [ -n "${NTFY_EVENTS:-}" ] && [ "$NTFY_EVENTS" != "all" ]; then
  OLDIFS="$IFS"; IFS=","
  for e in $NTFY_EVENTS; do
    case "$e" in
      question|permission|finished|error|custom) ;;
      *) IFS="$OLDIFS"; die 2 "NTFY_EVENTS: unknown kind '$e' (csv of question,permission,finished,error,custom — or 'all')" ;;
    esac
  done
  IFS="$OLDIFS"
fi
if [ -n "${NTFY_PHONE:-}" ]; then
  case "$NTFY_PHONE" in
    ios|android|none) ;;
    *) die 2 "NTFY_PHONE must be ios|android|none (got: $NTFY_PHONE)" ;;
  esac
fi
case "${NTFY_INSTALL_DEPS:-}" in ""|0|1) ;; *) die 2 "NTFY_INSTALL_DEPS must be 0 or 1" ;; esac
case "${NTFY_SKIP_CONFIRM:-}" in ""|0|1) ;; *) die 2 "NTFY_SKIP_CONFIRM must be 0 or 1" ;; esac

command -v node >/dev/null 2>&1 || die 3 "node not found — Nudge requires Node.js (https://nodejs.org), then re-run"

# ------------------------------------------------------------------ banner
say "Nudge installer"
info "provisions a self-hosted ntfy server, wires your agents, sends a test push."
info "nothing changes until you answer the questions (Ctrl-C is safe)."

if [ -n "${NTFY_HARNESSES:-}" ]; then
  HARNESSES="$NTFY_HARNESSES"
else
  say "which agents should Nudge notify for?"
  printf '  1) OpenCode and Codex\n  2) OpenCode only\n  3) Codex only\n'
  menu "Choice" 1 2 3
  case "$REPLY_V" in 1) HARNESSES=both ;; 2) HARNESSES=opencode ;; 3) HARNESSES=codex ;; esac
fi
info "agents: $HARNESSES"

# ------------------------------------------------- step 1: access mode (+ branch inputs)
say "1/5 — how should your phone reach the ntfy server?"
if [ -n "${NTFY_MODE:-}" ]; then
  MODE="$NTFY_MODE"
  info "mode: $MODE (NTFY_MODE)"
else
  printf '  1) local      — same Wi-Fi only (simplest)\n'
  printf '  2) tailscale  — private VPN, works anywhere\n'
  printf '  3) cloudflare — public URL via Cloudflare Tunnel\n'
  menu "Choice" 1 2 3
  case "$REPLY_V" in
    1) MODE=local ;;
    2) MODE=tailscale ;;
    3) MODE=cloudflare ;;
  esac
  info "mode: $MODE"
fi

case "$MODE" in
  cloudflare)
    if [ -z "${CF_HOSTNAME:-}" ]; then
      ask "Public hostname for the tunnel (e.g. ntfy.example.com): "
      [ -z "$REPLY_V" ] && die 2 "hostname required"
      CF_HOSTNAME="$REPLY_V"
    fi
    export CF_HOSTNAME
    info "hostname: $CF_HOSTNAME"
    ;;
  local)
    DETECTED="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -z "$DETECTED" ] && DETECTED="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if [ -n "${LAN_IP:-}" ]; then
      info "LAN IP: $LAN_IP (LAN_IP)"
    elif [ -n "$DETECTED" ]; then
      printf 'Detected LAN IP: %s — Enter to use it, or type another: ' "$DETECTED"
      read -r REPLY_V || die 2 "no input (set LAN_IP=<ip> to script this)"
      LAN_IP="${REPLY_V:-$DETECTED}"
      export LAN_IP
      info "LAN IP: $LAN_IP"
    else
      warn "could not auto-detect a LAN IP — the server step will try again"
    fi
    ;;
  tailscale)
    info "Tailscale login will be verified in preflight (step 2/5)"
    ;;
esac

# ------------------------------------------------------------------ resolve the plugin source
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$SCRIPT_DIR/scripts/setup-server.sh" ] && [ -f "$SCRIPT_DIR/src/index.ts" ]; then
  REPO_DIR="$SCRIPT_DIR"
  info "running from a checkout — the plugin will be wired to: $REPO_DIR"
else
  REPO_DIR="${NTFY_PLUGIN_DIR:-$HOME/.local/share/opencode-ntfy}"
  if [ ! -f "$REPO_DIR/scripts/setup-server.sh" ] || { [ "$HARNESSES" != "opencode" ] && [ ! -f "$REPO_DIR/scripts/codex-hook.mjs" ]; }; then
    UPGRADE=0
    if [ -e "$REPO_DIR" ]; then
      [ -f "$REPO_DIR/scripts/setup-server.sh" ] || die 3 "$REPO_DIR exists but is not a complete plugin install — move it aside and re-run"
      UPGRADE=1
    fi
    say "installing Nudge to $REPO_DIR"
    mkdir -p "$(dirname "$REPO_DIR")"
    TMP_DIR="$(mktemp -d "$REPO_DIR.tmp.XXXXXX")" || die 3 "could not create install directory"
    trap 'if [ -n "${TMP_DIR:-}" ]; then rm -rf "$TMP_DIR"; fi' EXIT
    if [ -n "${NTFY_REPO_URL:-}" ]; then
      command -v git >/dev/null 2>&1 || die 3 "git is required for NTFY_REPO_URL"
      git clone --depth 1 "$NTFY_REPO_URL" "$TMP_DIR" || die 3 "git clone failed: $NTFY_REPO_URL"
    else
      SITE_URL="${NTFY_SITE_URL:-https://nudge.tommyek.com}"
      curl -fsSL "${SITE_URL%/}/plugin.tar.gz" -o "$TMP_DIR/plugin.tar.gz" || die 3 "could not download plugin from $SITE_URL"
      tar -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR" || die 3 "could not unpack plugin archive"
      rm "$TMP_DIR/plugin.tar.gz"
    fi
    [ -f "$TMP_DIR/src/index.ts" ] && [ -f "$TMP_DIR/scripts/setup-server.sh" ] && [ -f "$TMP_DIR/scripts/codex-hook.mjs" ] && [ -f "$TMP_DIR/scripts/configure-opencode.mjs" ] || die 3 "downloaded plugin is incomplete"
    if [ "$HARNESSES" != "codex" ] || [ "$UPGRADE" = 1 ]; then
      command -v npm >/dev/null 2>&1 || die 3 "npm is required to install the OpenCode plugin dependency"
      npm ci --omit=dev --ignore-scripts --prefix "$TMP_DIR" || die 3 "could not install the OpenCode plugin dependency"
    fi
    if [ "$UPGRADE" = 1 ]; then
      OLD_DIR="$REPO_DIR.old.$$"
      [ ! -e "$OLD_DIR" ] || die 3 "backup path already exists: $OLD_DIR"
      mv "$REPO_DIR" "$OLD_DIR" || die 3 "could not move old plugin install"
      mv "$TMP_DIR" "$REPO_DIR" || { mv "$OLD_DIR" "$REPO_DIR"; die 3 "could not replace plugin install"; }
      rm -rf "$OLD_DIR"
    else
      mv "$TMP_DIR" "$REPO_DIR" || die 3 "could not move plugin to $REPO_DIR"
    fi
    TMP_DIR=""
    ok "plugin installed"
  else
    info "existing plugin install found: $REPO_DIR"
  fi
fi
SETUP="$REPO_DIR/scripts/setup-server.sh"
[ -f "$SETUP" ] || die 3 "setup script missing at $SETUP"

# ------------------------------------------------------------------ step 2: preflight loop
say "2/5 — preflight (mode: $MODE) — verifies tools, logins, and a free port"
PF_CODE=1
attempt=1
while [ "$attempt" -le 3 ]; do
  set +e
  PF_JSON="$(bash "$SETUP" preflight "$MODE" --json 2>/dev/null)"
  PF_CODE=$?
  set -e
  if [ "$PF_CODE" = "0" ]; then
    ok "all checks passed"
    break
  fi
  FAILED="$(node -e 'var r=JSON.parse(process.argv[1]);r.checks.forEach(function(c){if(!c.ok)console.log(c.id+"\t"+(c.hint||"")+"\t"+(c.value||""))})' "$PF_JSON" 2>/dev/null || true)"
  [ -n "$FAILED" ] || die "$PF_CODE" "preflight failed (exit $PF_CODE) without details"
  FAILED_FILE="$(mktemp)"
  printf '%s\n' "$FAILED" > "$FAILED_FILE"
  while IFS="$TAB" read -r cid chint cval; do
    [ -z "$cid" ] && continue
    info "fixing: $cid — $chint"
    case "$cid" in
      docker-cli|docker-compose)
        if consent "Install Docker via Homebrew (brew install colima docker)?"; then
          need_brew
          brew install colima docker || die 3 "brew install colima docker failed"
          ok "Docker installed (colima VM is started automatically by the server step)"
        else
          die 3 "Docker is required for a self-hosted server: $chint"
        fi
        ;;
      docker-daemon)
        if command -v colima >/dev/null 2>&1; then
          if consent "Start the Colima Docker VM now (colima start)?"; then
            colima start || die 3 "colima start failed"
            ok "colima running"
          else
            info "OK — the server step will start colima itself"
          fi
        elif [ "$(uname 2>/dev/null)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
          if consent "Start Docker Desktop now?"; then
            open -a Docker
            info "waiting for Docker Desktop..."
            dtry=0
            while [ "$dtry" -lt 30 ]; do
              if docker info >/dev/null 2>&1; then break; fi
              dtry=$((dtry + 1)); sleep 2
            done
            docker info >/dev/null 2>&1 || die 3 "Docker Desktop did not come up in 60s — start it and re-run"
            ok "Docker Desktop running"
          else
            die 3 "a Docker runtime is required: start Docker Desktop (or install colima) and re-run"
          fi
        else
          die 3 "no Docker runtime available: $chint"
        fi
        ;;
      tailscale-cli)
        if consent "Install Tailscale via Homebrew (brew install tailscale)?"; then
          need_brew
          brew install tailscale || die 3 "brew install tailscale failed"
          ok "Tailscale installed"
        else
          die 3 "Tailscale is required for tailscale mode: $chint"
        fi
        ;;
      cloudflared-cli)
        if consent "Install cloudflared via Homebrew (brew install cloudflared)?"; then
          need_brew
          brew install cloudflared || die 3 "brew install cloudflared failed"
          ok "cloudflared installed"
        else
          die 3 "cloudflared is required for cloudflare mode: $chint"
        fi
        ;;
      tailscale-login)
        if consent "Log in to Tailscale now (opens the browser)?"; then
          tailscale up || die 3 "Tailscale login failed"
          ok "Tailscale logged in"
        else
          die 3 "Tailscale login is required — run 'tailscale up', then re-run this installer"
        fi
        ;;
      cloudflared-login)
        if consent "Log in to Cloudflare now (opens the browser)?"; then
          cloudflared login || die 3 "cloudflared login failed"
          ok "Cloudflare logged in"
        else
          die 3 "Cloudflare login is required — run 'cloudflared login', then re-run this installer"
        fi
        ;;
      cloudflare-hostname)
        ask_default "Public hostname (e.g. ntfy.example.com): " "${CF_HOSTNAME:-}"
        [ -z "$REPLY_V" ] && die 2 "hostname required"
        CF_HOSTNAME="$REPLY_V"
        export CF_HOSTNAME
        ;;
      port-*)
        if [ "$attempt" -ge 3 ]; then
          die 4 "port conflict persists: $chint${cval:+ ($cval)}"
        fi
        if ask_yn "Port is busy (${cval:-in use}) — switch to port 8080?" y; then
          NTFY_PORT=8080
        else
          ask "Type a free port to use: "
          case "$REPLY_V" in
            ''|*[!0-9]*) die 2 "not a valid port: $REPLY_V" ;;
          esac
          NTFY_PORT="$REPLY_V"
        fi
        export NTFY_PORT
        info "using NTFY_PORT=$NTFY_PORT"
        ;;
      lan-ip)
        warn "no LAN IP detected — you will be able to set it in $HOME/ntfy/etc/server.yml"
        ;;
      *)
        die 3 "cannot proceed: $cid — $chint"
        ;;
    esac
  done < "$FAILED_FILE"
  rm -f "$FAILED_FILE"
  attempt=$((attempt + 1))
done
if [ "$PF_CODE" != "0" ]; then
  die "$PF_CODE" "preflight still failing after $((attempt - 1)) attempt(s) — re-run this installer"
fi

# ------------------------------------------------- step 3: config scope
say "3/5 — where should the plugin be configured?"
if [ -n "${NTFY_SCOPE:-}" ]; then
  SCOPE="$NTFY_SCOPE"
  info "scope: $SCOPE (NTFY_SCOPE)"
else
  printf '  1) global       — all projects\n'
  printf '  2) this project — %s\n' "$PWD"
  menu "Choice" 1 2
  case "$REPLY_V" in
    1) SCOPE=global ;;
    2) SCOPE=project ;;
  esac
  info "scope: $SCOPE"
fi
if [ -n "${NTFY_CONFIG_FILE:-}" ]; then
  CONFIG_FILE="$NTFY_CONFIG_FILE"
elif [ "$SCOPE" = "global" ]; then
  CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
else
  CONFIG_FILE="$PWD/opencode.json"
fi

# ------------------------------------------------- step 4: which notifications
say "4/5 — which notifications should reach your phone?"
EV_ALL=1
EV_LIST="question permission finished error custom"
if [ -n "${NTFY_EVENTS:-}" ]; then
  if [ "$NTFY_EVENTS" != "all" ]; then
    EV_ALL=0
    EV_LIST="$(printf '%s' "$NTFY_EVENTS" | tr ',' ' ')"
  fi
  info "events: $EV_LIST (NTFY_EVENTS)"
else
  printf '  1) All five (recommended): question, permission, finished, error, custom\n'
  printf '  2) Customize\n'
  menu "Choice" 1 2
  if [ "$REPLY_V" = "2" ]; then
    EV_ALL=0
    EV_LIST=""
    for k in question permission finished error custom; do
      if ask_yn "  + $k?" y; then
        EV_LIST="${EV_LIST:+$EV_LIST }$k"
      fi
    done
    if [ -z "$EV_LIST" ]; then
      warn "every kind disabled — the plugin would stay silent; re-enabling all"
      EV_ALL=1
      EV_LIST="question permission finished error custom"
    else
      info "enabled: $EV_LIST"
    fi
  else
    info "enabled: all five"
  fi
fi

# ------------------------------------------------- step 5: phone
say "5/5 — which phone will subscribe?"
if [ -n "${NTFY_PHONE:-}" ]; then
  PHONE="$NTFY_PHONE"
  info "phone: $PHONE (NTFY_PHONE)"
else
  printf '  1) iPhone (iOS)\n  2) Android\n  3) none yet\n'
  menu "Choice" 1 2 3
  case "$REPLY_V" in
    1) PHONE=ios ;;
    2) PHONE=android ;;
    3) PHONE=none ;;
  esac
  info "phone: $PHONE"
fi

# ------------------------------------------------------------------ provision
say "provisioning the ntfy server (mode: $MODE, port: ${NTFY_PORT:-80})"
set +e
SETUP_JSON="$(bash "$SETUP" --json "$MODE")"
SETUP_CODE=$?
set -e
if [ "$SETUP_CODE" != "0" ]; then
  SETUP_ERR="$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).error||"")}catch(e){}' "$SETUP_JSON" 2>/dev/null || true)"
  die "$SETUP_CODE" "server setup failed${SETUP_ERR:+: $SETUP_ERR}"
fi
SERVER_URL="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).serverUrl)' "$SETUP_JSON")"
TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$SETUP_JSON")"
ok "server ready: $SERVER_URL"

# ------------------------------------------------------------------ write agent configs
say "writing agent config"
if [ "$SCOPE" = "global" ]; then CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"; else CODEX_DIR="$PWD/.codex"; fi
CODEX_CONFIG="$CODEX_DIR/nudge.json"
CODEX_HOOKS="$CODEX_DIR/hooks.json"
TOPIC_PROPOSED="$(node -e '
var fs=require("fs"), path=require("path"), topic="";
try { var c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); topic=c.topic || ""; } catch (_) {}
if (!topic) try {
  var c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  var entries=[...(c.plugin || []).map(function(e){return {path:e[0],options:e[1]};}), ...(c.plugins || []).map(function(e){return {path:e.package,options:e.options};})];
  var found=entries.find(function(e){return typeof e.path==="string" && (e.path===process.argv[3] || path.basename(e.path)==="opencode-ntfy");});
  topic=found && found.options && found.options.baseTopic || "";
} catch (_) {}
if (/^[A-Za-z0-9_-]{1,64}$/.test(topic)) process.stdout.write(topic);
' "$CODEX_CONFIG" "$CONFIG_FILE" "$REPO_DIR")"
[ -n "$TOPIC_PROPOSED" ] || TOPIC_PROPOSED="$(node -e 'process.stdout.write("nudge-"+require("crypto").randomBytes(5).toString("hex"))')"
export NTFY_W="$SERVER_URL|$TOKEN|$TOPIC_PROPOSED|$EV_ALL|$EV_LIST"
TOPIC="$TOPIC_PROPOSED"
if [ "$HARNESSES" != "codex" ]; then
  TOPIC="$(node "$REPO_DIR/scripts/configure-opencode.mjs" "$CONFIG_FILE" "$REPO_DIR")" || die $? "writing $CONFIG_FILE failed"
  ok "config written: $CONFIG_FILE"
fi
if [ "$HARNESSES" != "opencode" ]; then
  [ -f "$REPO_DIR/scripts/configure-codex.mjs" ] && [ -f "$REPO_DIR/scripts/codex-hook.mjs" ] || die 3 "Codex support missing from $REPO_DIR"
  node "$REPO_DIR/scripts/configure-codex.mjs" "$CODEX_HOOKS" "$CODEX_CONFIG" "$REPO_DIR/scripts/codex-hook.mjs" "$TOPIC" || die 3 "writing Codex hooks failed"
  ok "Codex hooks written: $CODEX_HOOKS"
  info "in Codex, open /hooks and trust the Nudge Stop and PermissionRequest hooks"
fi
ok "topic (kept if this was installed before): $TOPIC"

# ------------------------------------------------------------------ phone instructions
cat <<EOF

Phone setup — the one manual step (iOS has no one-tap subscribe):
  1. Install the ntfy app — iOS: https://apps.apple.com/app/ntfy/id1625396347 / Android: Play Store
  2. Set the app's default server to:  $SERVER_URL
  3. Subscribe to this one topic:      $TOPIC
EOF
if [ "$MODE" = "local" ]; then
  info "(the phone must be on this Wi-Fi)"
elif [ "$MODE" = "tailscale" ]; then
  cat <<EOF
  4. Install Tailscale on the phone and enable
     Settings -> Tailscale -> Connect on Demand.
     If Serve was just activated: approve the printed link, then re-run this installer.
EOF
fi
if [ "$PHONE" = "ios" ]; then
  info "iOS instant push is pre-configured (upstream-base-url -> ntfy.sh -> APNS)."
elif [ "$PHONE" = "android" ]; then
  info "Android instant push is pre-configured the same way (FCM via ntfy.sh)."
fi

# ------------------------------------------------------------------ test push
if [ "${NTFY_SKIP_CONFIRM:-}" != "1" ]; then
  printf '\nPress Enter when the phone is subscribed... '
  read -r REPLY_V || die 2 "no input (set NTFY_SKIP_CONFIRM=1 to script this)"
fi
TEST_BODY="{\"topic\":\"$TOPIC\",\"title\":\"🎉 Nudge setup\",\"message\":\"Notifications are live — this is the install test push.\",\"tags\":[\"tada\"]}"
TEST_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$TEST_BODY" "$SERVER_URL/" || printf '000')"
if [ "$TEST_CODE" = "200" ]; then
  ok "test push sent (HTTP 200) to topic $TOPIC"
else
  warn "test push returned HTTP $TEST_CODE — check: docker logs / server URL reachability"
fi
if [ "${NTFY_SKIP_CONFIRM:-}" != "1" ]; then
  if ask_yn "Did the test notification arrive on your phone?" y; then
    :
  else
    warn "if it never arrives, check:"
    info "• app default server exactly: $SERVER_URL"
    info "• subscribed to exactly:      $TOPIC"
    if [ "$MODE" = "local" ]; then info "• phone on the same Wi-Fi as this machine"
    elif [ "$MODE" = "tailscale" ]; then info "• phone connected to Tailscale (Connected in the app)"
    else info "• DNS for $CF_HOSTNAME active (waited ~1 min? try: curl -fsS $SERVER_URL/v1/health)"; fi
    info "• iOS: Settings -> Notifications -> ntfy allowed"
  fi
fi

# ------------------------------------------------------------------ summary
say "done — Nudge is installed"
info "server: $SERVER_URL   (mode: $MODE, port: ${NTFY_PORT:-80})"
info "topic:  $TOPIC   (one topic for all kinds — D9)"
if [ "$HARNESSES" != "codex" ]; then info "OpenCode config: $CONFIG_FILE"; fi
if [ "$HARNESSES" != "opencode" ]; then info "Codex config: $CODEX_CONFIG"; fi
info "plugin: $REPO_DIR"
if [ "$HARNESSES" != "codex" ]; then
cat <<EOF

OpenCode event settings are in $CONFIG_FILE:
  "events": {
    "question":  { "priority": "urgent", "tags": ["question"] },
    "finished":  { "enabled": false },
    "error":     { "priority": "high" }
  }
EOF
fi
if [ "$HARNESSES" != "opencode" ]; then
  info "Codex: open /hooks, review and trust Nudge's two hooks before alerts can fire."
fi
cat <<EOF

Switch access modes later:  re-run this installer (or scripts/setup-server.sh <mode>),
then RE-SUBSCRIBE the phone — subscriptions are keyed by server URL (wake hash).
Uninstall: remove Nudge's agent entries; the server can be removed with:
  docker compose -f \$HOME/ntfy/docker-compose.yml down
EOF
