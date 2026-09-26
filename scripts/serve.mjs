// Minimal zero-dependency static file server for local development.
//
// Exists so that the VS Code F5 debug config (and a human at a
// terminal) can serve the site without installing anything. Node's
// built-in http + fs are enough for a static site with no build step.
// There is no package.json and no "npm run dev" — this project has
// no dependencies at all.
//
//   node scripts/serve.mjs [port]
//
// Security note: every resolved path is checked to stay inside ROOT.
// Without that check, a request for "/../secrets.txt" would escape the
// project directory.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
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
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "Bad request");
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  // normalize() collapses "..", and the prefix check rejects anything
  // that still points outside ROOT.
  const target = join(ROOT, normalize(pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(res, 403, "Forbidden");
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return send(res, 404, `Not found: ${pathname}`);
  }

  if (info.isDirectory()) {
    return send(res, 302, "", { location: pathname.replace(/\/?$/, "/") });
  }

  const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";

  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    // Never cache during development, or a fix appears not to apply.
    "cache-control": "no-store",
  });

  if (req.method === "HEAD") return res.end();

  createReadStream(target)
    .on("error", () => {
      res.destroy();
    })
    .pipe(res);
});

server.listen(PORT, () => {
  console.log(`LinkUp dev server → http://localhost:${PORT}`);
  console.log(`serving          ${ROOT}`);
  console.log("press ctrl+c to stop");
});
