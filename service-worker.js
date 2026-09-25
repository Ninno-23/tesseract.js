const CACHE_NAME = "studyvault-v12-shell";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./ai-worker.js",
  "./manifest.json",
  "./icon.svg"
];
const REMOTE_CACHE = "studyvault-v12-runtime";
const ALLOWED_REMOTE = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cas-bridge.xethub.hf.co"
];
function isAllowedRemote(url){return ALLOWED_REMOTE.some(host=>url.hostname===host||url.hostname.endsWith("."+host));}
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME&&k!==REMOTE_CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
async function networkFirst(request){
  try{const res=await fetch(request);const copy=res.clone();caches.open(CACHE_NAME).then(c=>c.put(request,copy)).catch(()=>{});return res;}
  catch{const cached=await caches.match(request);return cached||caches.match("./index.html");}
}
async function remoteRuntime(request){
  const cache=await caches.open(REMOTE_CACHE);
  const cached=await cache.match(request);
  try{const res=await fetch(request);if(res&&res.ok){cache.put(request,res.clone()).catch(()=>{});return res;}if(cached)return cached;return res;}
  catch{return cached||new Response("",{status:503,statusText:"Offline and resource is not cached"});}
}
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin===self.location.origin){event.respondWith(networkFirst(event.request));return;}
  if(isAllowedRemote(url)){event.respondWith(remoteRuntime(event.request));}
});
