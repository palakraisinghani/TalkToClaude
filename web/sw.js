// The installed app's service worker.
//
// ClaudeCall is a live call to a server on the lead's own computer, so there is nothing useful to
// do offline and nothing is served from a cache while the server is up: every request goes to the
// network, so a new version is picked up on the next load. What this adds is the one thing an app
// on a phone needs — when the computer is asleep or off the network, a page that says so, instead
// of the browser's own error. (Browsers also want a service worker before they offer "Install".)

const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("claudecall").then((c) => c.addAll([OFFLINE, "/icon.svg"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  // only page loads get the fallback; everything else simply fails as it would without this
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
