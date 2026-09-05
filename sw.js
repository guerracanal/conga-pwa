// Service worker: red primero, caché solo como respaldo sin conexión. Con
// internet disponible (que aquí siempre hace falta, es la premisa de la app)
// siempre coge la versión más reciente en vez de quedarse pegado a una vieja.
const CACHE = "conga-pwa-v7";
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
    fetch(event.request)
      .then((fresh) => {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return fresh;
      })
      .catch(() => caches.match(event.request))
  );
});
