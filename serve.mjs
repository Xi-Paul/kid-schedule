/* scripts/serve.mjs — 로컬 미리보기 서버.
 *
 *   npm start   →  http://localhost:8080
 *
 * file:// 로 index.html 을 직접 열면 config.json / schedule.json 을 fetch 하지 못합니다.
 * 브라우저가 로컬 파일에 대한 fetch 를 막기 때문입니다. 그래서 작은 서버를 띄웁니다.
 * Node 내장 모듈만 쓰므로 따로 설치할 것이 없습니다.
 *
 * 저장소 루트를 그대로 서비스하므로 파일을 고치고 새로고침하면 바로 반영됩니다.
 * 캐시를 끄고 서비스 워커도 비워서, 고친 내용이 안 보이는 일이 없게 했습니다.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ics":  "text/calendar; charset=utf-8",
  ".md":   "text/plain; charset=utf-8"
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";

  // 서비스 워커는 로컬에서 캐시를 잡아 수정이 안 보이게 만듭니다. 빈 파일로 응답합니다.
  if (rel === "/sw.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    return res.end("/* 로컬 미리보기에서는 서비스 워커를 쓰지 않습니다 */\n");
  }

  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("403"); }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(`404 — ${rel}\n\n저장소 루트에서 실행했는지 확인하세요.`);
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate"
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log("\n  미리보기 서버가 떴습니다.\n");
  console.log(`    PC    http://localhost:${PORT}`);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) console.log(`    폰    http://${i.address}:${PORT}   (${name}, 같은 와이파이)`);
    }
  }
  console.log("\n  파일을 고치고 브라우저 새로고침 → 바로 반영. 끄려면 Ctrl+C\n");
});
