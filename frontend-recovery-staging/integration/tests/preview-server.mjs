import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const publicRoot = path.resolve(process.argv[2] || new URL("../public", import.meta.url).pathname);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

http.createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/.netlify/functions/")) {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "Preview only: Netlify functions are not running" }));
    return;
  }
  let requested = path.resolve(publicRoot, `.${decodeURIComponent(pathname)}`);
  const relativePath = path.relative(publicRoot, requested);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    response.writeHead(404).end();
    return;
  }
  try {
    if ((await stat(requested)).isDirectory()) requested = path.join(requested, "index.html");
    const data = await readFile(requested);
    response.writeHead(200, { "content-type": contentTypes[path.extname(requested)] || "application/octet-stream" });
    response.end(data);
  } catch {
    if (path.extname(pathname)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(await readFile(path.join(publicRoot, "index.html")));
  }
}).listen(4173, "127.0.0.1", () => process.stdout.write("Staging static preview listening at http://127.0.0.1:4173\n"));
