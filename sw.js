/* VOËL Gestión · service worker. Cambiar VERSION en cada publicación para que los celulares se actualicen. */
const VERSION = "2026.11.10-2";
const CACHE = "voel-gestion-" + VERSION;
const SHELL = ["./", "index.html", "platform.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("voel-gestion-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.hostname.endsWith("supabase.co")) return;              // datos: siempre en vivo, nunca de caché
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("platform.js")) {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { if (res.ok && (url.origin === location.origin || url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com") || url.hostname === "cdnjs.cloudflare.com")) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; })));
});
