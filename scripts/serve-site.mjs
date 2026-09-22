#!/usr/bin/env node
/*
 * Static server for the project site.
 *
 *   node scripts/serve-site.mjs [--port 8080] [--host 127.0.0.1]
 *
 * Serves site/ as the web root, and maps the files that ship from the repo
 * root (install.sh, INSTALL.md, ...) onto the paths the pages link to, so the
 * published curl one-liner and the local preview resolve to the same file.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = join(repo, "site");

const SHARED = {
  "/install.sh": join(repo, "install.sh"),
  "/INSTALL.md": join(repo, "INSTALL.md"),
  "/UNINSTALL.md": join(repo, "UNINSTALL.md"),
  "/uninstall.sh": join(repo, "scripts", "uninstall.sh"),
  "/LICENSE": join(repo, "LICENSE"),
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8080,
    host: process.env.HOST || "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") out.port = Number(argv[++i]);
    else if (argv[i] === "--host") out.host = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node scripts/serve-site.mjs [--port 8080] [--host 127.0.0.1]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    console.error(`invalid port: ${out.port}`);
    process.exit(2);
  }
  return out;
}

function resolveFile(pathname) {
  let path = decodeURIComponent(pathname.split("?")[0].split("#")[0]);
  if (path.endsWith("/")) path += "index.html";

  if (SHARED[path] && existsSync(SHARED[path])) return SHARED[path];

  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!existsSync(target)) return null;

  const stats = statSync(target);
  if (stats.isDirectory()) return resolveFile(path + "/");
  return stats.isFile() ? target : null;
}

function notFound() {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>404 — Nudge</title>
<meta name="color-scheme" content="dark">
<style>
  body { margin:0; min-height:100svh; display:grid; place-items:center;
         background:oklch(0.145 0.008 165); color:oklch(0.81 0.008 165);
         font:400 16px/1.6 ui-monospace, Menlo, monospace; text-align:center; }
  b { display:block; font-size:3rem; font-weight:300; color:oklch(0.97 0.004 165); letter-spacing:-.03em; }
  a { color:oklch(0.82 0.155 158); }
</style>
<b>404</b><p>That page is not on this server.</p><p><a href="/">Back to the landing page</a></p>
</html>`;
}

const { port, host } = parseArgs(process.argv.slice(2));

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed\n");
    return;
  }

  const file = resolveFile(req.url || "/");
  if (!file) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(notFound());
    console.log(`404 ${req.url}`);
    return;
  }

  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  const stats = statSync(file);
  res.writeHead(200, {
    "content-type": type,
    "content-length": stats.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`site  →  http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`);
  console.log(`root  →  ${root}`);
  console.log(`maps  →  ${Object.keys(SHARED).join(", ")}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`port ${port} is already in use — try: node scripts/serve-site.mjs --port 8081`);
    process.exit(4);
  }
  throw error;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
