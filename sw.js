// Service worker mínimo: cachea el "app shell" (HTML/CSS/JS) para que abra al
// instante, incluso con mala cobertura. Nunca cachea llamadas a la nube de
// Cecotec (WebSocket, no pasa por aquí de todas formas).
const CACHE = "conga-pwa-v5";
const SHELL = ["./", "./index.html", "./app.js", "./conga-client.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
