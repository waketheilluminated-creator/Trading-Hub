/* Trading Hub mobile alerts. No fetch interception — market data stays on the network. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function payloadFrom(event) {
  const fallback = { title: "Trading Hub", body: "" };
  if (!event.data) return fallback;
  try {
    const parsed = event.data.json();
    return {
      title: String(parsed.title || fallback.title).slice(0, 80),
      body: String(parsed.body || parsed.message || "").slice(0, 180),
    };
  } catch {
    return { title: fallback.title, body: String(event.data.text() || "").slice(0, 180) };
  }
}

self.addEventListener("push", (event) => {
  const payload = payloadFrom(event);
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/apple-touch-icon.png",
    badge: "/favicon.svg",
    vibrate: [200, 100, 200],
    silent: false,
    data: { url: "/mobile" },
  }));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "SHOW_NOTIFICATION") return;
  const title = String(data.title || "Trading Hub").slice(0, 80);
  const body = String(data.body || "").slice(0, 180);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/apple-touch-icon.png",
    vibrate: [200, 100, 200],
    silent: false,
    data: { url: "/mobile" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = "/mobile";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(target) && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
