/*
 * A static file server for the harness: serves an app tree from `root` and
 * overlays the harness pages under /__harness/, so the harness can drive an
 * app it does not modify (the original tree, or a build output).
 *
 * Range requests are honoured, because DuckDB-Wasm reads files that way.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY = join(HERE, "pages");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".parquet": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function safeJoin(base, path) {
  const root = resolve(base);
  const full = normalize(join(root, decodeURIComponent(path)));
  return full === root || full.startsWith(root + "/") ? full : null;
}

/**
 * @param {{ root: string, port?: number, files?: Map<string, Uint8Array>, onRequest?: Function }} options
 *   `files` are extra in-memory files served under /__files/<name>.
 */
export function serve({ root, port = 0, files = new Map(), onRequest = null }) {
  const server = createServer((req, res) => {
    onRequest?.(req);
    const url = new URL(req.url, "http://localhost");
    let path = url.pathname;
    if (path.startsWith("/__files/")) {
      const body = files.get(path.slice("/__files/".length));
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      return void res.end(body);
    }
    let file;
    if (path.startsWith("/__harness/")) file = safeJoin(OVERLAY, path.slice("/__harness/".length));
    else {
      if (path.endsWith("/")) path += "index.html";
      file = safeJoin(root, path);
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    const size = statSync(file).size;
    const headers = {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": end - start + 1,
      });
      if (req.method === "HEAD") return void res.end();
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      ready({
        url: `http://127.0.0.1:${typeof address === "object" ? address.port : port}`,
        close: () => server.close(),
      });
    });
  });
}
