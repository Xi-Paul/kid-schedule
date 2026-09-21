/* 앱 껍데기만 캐시합니다. 일정과 진행 기록은 GitHub API로 직접 받으므로 캐시하지 않습니다. */
const CACHE = "kidsched-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./github.js", "./app.js",
               "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // GitHub API / raw 는 절대 가로채지 않습니다. 오래된 상태를 보여주면 안 됩니다.
  if (url.hostname !== self.location.hostname) return;

  // 앱 코드와 데이터는 네트워크 우선 — 푸시하면 바로 반영됩니다.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && SHELL.some(p => url.pathname.endsWith(p.replace("./", "")))) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(h => h || caches.match("./index.html")))
  );
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow("./");
  }));
});
