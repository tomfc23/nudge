/**
 * Access-mode awareness (SPEC §10 companion): the three supported ways a phone
 * can reach a self-hosted ntfy server.
 *
 *   local       — same Wi-Fi / localhost (http://192.168.x.x or http://127.0.0.1)
 *   tailscale   — private tailnet (https://<machine>.<tailnet>.ts.net or 100.x.y.z)
 *   cloudflare  — public internet via Cloudflare Tunnel / reverse proxy
 *                 (https://ntfy.example.com)
 *
 * The mode only affects *guidance* printed at startup (what the phone needs,
 * what to double-check) — publishing works identically in all three. Detection
 * is a heuristic on the serverUrl; an explicit `accessMode` option overrides it.
 */

import { networkInterfaces } from "node:os"

export type AccessMode = "local" | "tailscale" | "cloudflare"

export interface AccessInfo {
  mode: AccessMode
  /** One-line human summary, printed after "access mode: …". */
  summary: string
  /** Phone-side requirements / setup reminders. */
  hints: string[]
  /** Things that will (or may) bite the user. */
  warnings: string[]
}

const MODES: AccessMode[] = ["local", "tailscale", "cloudflare"]

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && (MODES as string[]).includes(value)
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host)
  )
}

/** RFC1918 private IPv4 (the phone can reach it only on the same network). */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** CGNAT 100.64.0.0/10 — Tailscale's default IP range. */
function isTailscaleIP(host: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(host)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

/** Best-effort LAN IPv4 suggestion for local mode (never throws). */
function lanIPv4(): string | undefined {
  try {
    for (const infos of Object.values(networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === "IPv4" && !info.internal && isPrivateV4(info.address)) {
          return info.address
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** Static per-mode guidance so hints stay consistent between auto and override. */
function modeGuide(mode: AccessMode): { summary: string; hints: string[] } {
  if (mode === "local") {
    return {
      summary: "local — phone reaches the server over your own Wi-Fi/LAN",
      hints: [
        "phone and this machine must be on the same Wi-Fi network",
        "plain http is fine on a trusted LAN (the ntfy app shows a dismissible warning)",
        "for iOS instant push, the server's base-url must match the URL the phone subscribes with",
      ],
    }
  }
  if (mode === "tailscale") {
    return {
      summary: "tailscale — phone reaches the server over your private tailnet (works anywhere)",
      hints: [
        "phone needs the Tailscale app installed and logged into the same tailnet",
        "enable iOS Settings → Tailscale → Connect on Demand so it works without manual toggling",
        "https://<machine>.ts.net names come with valid TLS certificates automatically",
        "for iOS instant push, the server's base-url must match the URL the phone subscribes with",
      ],
    }
  }
  return {
    summary: "cloudflare — phone reaches the server over the public internet via a tunnel/proxy",
    hints: [
      "works anywhere (cellular, work, travel) — no VPN or same-Wi-Fi needed",
      "keep server-side auth enabled (auth-default-access: read-only) when publicly exposed",
      "for iOS instant push, the server's base-url must match the URL the phone subscribes with",
    ],
  }
}

/**
 * Resolve the effective access info for a serverUrl.
 * `override` (the `accessMode` option) wins when valid; otherwise detect.
 */
export function resolveAccess(serverUrl: string, override?: unknown): AccessInfo {
  if (isAccessMode(override)) {
    const guide = modeGuide(override)
    const warnings: string[] = []
    let parsed: URL | undefined
    try {
      parsed = new URL(serverUrl)
    } catch {
      /* handled below */
    }
    if (override === "local" && parsed && !isLoopback(parsed.hostname) && !isPrivateV4(parsed.hostname) && !parsed.hostname.includes(":")) {
      warnings.push('accessMode is "local" but serverUrl is a public address — double-check the URL')
    }
    if (override !== "local" && parsed && isLoopback(parsed.hostname)) {
      warnings.push(
        `serverUrl is a loopback address — only OpenCode on this machine can use it; ` +
          `the phone must subscribe via a reachable address instead`,
      )
    }
    if (override === "cloudflare" && parsed?.protocol === "http:" && !isPrivateV4(parsed.hostname)) {
      warnings.push("public URL without TLS — prefer a Cloudflare Tunnel (https://) setup")
    }
    return { mode: override, summary: guide.summary, hints: guide.hints, warnings }
  }
  return detectAccess(serverUrl)
}

/** Auto-detect the access mode from the serverUrl. */
export function detectAccess(serverUrl: string): AccessInfo {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    return {
      mode: "cloudflare",
      summary: "unknown — serverUrl could not be parsed (expected http(s)://host)",
      hints: [],
      warnings: [`serverUrl "${serverUrl}" is not a valid URL — publishing will likely fail; see the README quick start`],
    }
  }

  const host = parsed.hostname
  const warnings: string[] = []

  if (isLoopback(host)) {
    const hints = modeGuide("local").hints
    const lan = lanIPv4()
    if (lan) {
      hints.unshift(`your phone should subscribe via http://${lan} (this machine's LAN address), not ${serverUrl}`)
    } else {
      hints.unshift("your phone cannot use this loopback URL — subscribe via this machine's LAN IP instead")
    }
    return {
      mode: "local",
      summary: "local — loopback address; OpenCode publishes on this machine only",
      hints,
      warnings: [
        "serverUrl is a loopback address: fine for publishing from this machine, but the phone must subscribe via a reachable URL (LAN IP, Tailscale, or tunnel)",
      ],
    }
  }

  if (host.endsWith(".ts.net") || isTailscaleIP(host)) {
    return {
      mode: "tailscale",
      summary: modeGuide("tailscale").summary,
      hints: modeGuide("tailscale").hints,
      warnings:
        parsed.protocol === "http:" && !isTailscaleIP(host)
          ? ["ts.net URLs are usually served over https — check the scheme"]
          : [],
    }
  }

  if (isPrivateV4(host) || host.startsWith("fd") || host.startsWith("fc")) {
    return { mode: "local", summary: modeGuide("local").summary, hints: modeGuide("local").hints, warnings }
  }

  // Anything else is a public address: Cloudflare Tunnel or another reverse proxy.
  if (host.endsWith(".trycloudflare.com")) {
    warnings.push(
      "Cloudflare quick tunnel: the random URL changes on every restart (subscriptions break) — use a named tunnel for daily use",
    )
  }
  if (parsed.protocol === "http:") {
    warnings.push(
      "public URL without TLS — iOS may refuse plain http off-Wi-Fi and traffic is exposed; use a Cloudflare Tunnel or Tailscale instead",
    )
  }
  return { mode: "cloudflare", summary: modeGuide("cloudflare").summary, hints: modeGuide("cloudflare").hints, warnings }
}
