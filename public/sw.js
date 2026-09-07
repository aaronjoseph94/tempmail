/*
 * Service worker: receives pushes and shows them, nothing more. It keeps no
 * cache and never intercepts requests, so it can neither serve stale pages
 * nor hide the sign-in screen.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Turns a push payload into a notification. Exposed so the app can test it without a push service. */
function showFromPayload(data) {
  const from = data.from || "New mail";
  const title = data.code ? `Code ${data.code} · ${from}` : from;
  const body = data.subject || (data.code ? "Tap to open the message" : "");
  return self.registration.showNotification(title, {
    body,
    tag: data.id || "tempmail",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data,
    actions: data.code ? [{ action: "copy", title: "Copy code" }] : [],
  });
}
self.showFromPayload = showFromPayload;

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { subject: event.data && event.data.text() }; }
  event.waitUntil(showFromPayload(data));
});

/** Brings the app to the front (or opens it) with the message, and the code to copy if asked. */
async function openFromNotification(data, action) {
  const copy = action === "copy" && data.code ? data.code : null;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((c) => "focus" in c);
  if (client) {
    client.postMessage({ open: data.id, copy });
    // Focus is only allowed straight from a notification tap; elsewhere it throws, and the message above is enough.
    try { await client.focus(); } catch { /* still open in the background */ }
    return;
  }
  const url = `/?open=${encodeURIComponent(data.id || "")}${copy ? `&copy=${encodeURIComponent(copy)}` : ""}`;
  await self.clients.openWindow(url);
}
self.openFromNotification = openFromNotification;

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFromNotification(event.notification.data || {}, event.action));
});
