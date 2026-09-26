const CACHE_NAME = "studyvault-v25-shell";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./ai-worker.js",
  "./manifest.json",
  "./icon.svg",
  "./version.json",
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js",
  "./vendor/tesseract/tesseract.min.js"
];
const REMOTE_CACHE = "studyvault-v25-runtime";
const ALLOWED_REMOTE = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cas-bridge.xethub.hf.co"
];
function isAllowedRemote(url){return ALLOWED_REMOTE.some(host=>url.hostname===host||url.hostname.endsWith("."+host));}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL).catch(err => {
        // Vendor files may fail on first install if path missing; still activate shell
        console.warn("Shell cache partial", err);
        return c.addAll(SHELL.filter(p => !p.includes("/vendor/")));
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== REMOTE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Cache-first for same-origin app + vendor so the shell stays offline-ready for years. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Soft revalidate in background when online
    fetch(request).then(res => {
      if (res && res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res.clone())).catch(() => {});
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res.clone())).catch(() => {});
    return res;
  } catch {
    return caches.match("./index.html");
  }
}

async function remoteRuntime(request) {
  const cache = await caches.open(REMOTE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    return cached || new Response("", { status: 503, statusText: "Offline and resource is not cached" });
  }
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  if (isAllowedRemote(url)) event.respondWith(remoteRuntime(event.request));
});
