/* The settings drawer, sheet gestures, web push, theme and accent. */

import { CACHE_KEY, PREFS, SCHEMES, state } from "./state.js";
import { $, copyText, escapeHtml, hideToast, isDesktop, plural, reducedMotion, store, toast } from "./util.js";
import { api, send } from "./api.js";
import { poll, refresh } from "./data.js";
import { brandName, moveSegHighlight, renderBrand, renderDomain, renderFeed, renderRail, renderStorage, renderTitle, visibleMessages } from "./render.js";
import { bumpUnread, closeMessage, openMessage, sendInSlices } from "./viewer.js";

/* --------------------------------------------------------------- settings */

/**
 * Retires a toast that is offering an action, because a modal dialog is about
 * to make it inert. It stays on screen looking pressable and silently is not:
 * delete a message, open Settings, and the only route back from that delete
 * is gone while still visible.
 */
export function retireActionToast() {
  if ($("toast").querySelector(".toast-act")) hideToast();
}

export function openSettings() {
  const cfg = state.config || {};
  const domainFromEnv = cfg.domainSource === "env";
  // The add field starts empty: the list below it is where the domains live,
  // so pre-filling it with the default only invites saving a duplicate.
  $("set-domain").value = "";
  $("set-domain").placeholder = cfg.domainSource === "observed" ? cfg.mailDomain : "example.com";
  $("set-domain").disabled = domainFromEnv;
  $("domain-form").querySelector("button").disabled = domainFromEnv;
  $("domain-note").hidden = !domainFromEnv;
  $("domain-note").textContent = "Set by the MAIL_DOMAIN variable — change it in wrangler.jsonc or the Cloudflare dashboard.";
  renderDomains();

  const passwordFromEnv = cfg.passwordSource === "env";
  $("password-form").hidden = passwordFromEnv;
  $("pw-note").textContent = passwordFromEnv
    ? "The password is the AUTH_PASSWORD secret; change it in the Cloudflare dashboard."
    : "Changing it signs out every other device.";

  renderLimits();
  $("set-screener").checked = !!cfg.screener;
  renderJunkState();
  $("set-autorefresh").checked = state.autoRefresh;
  $("set-images").checked = state.alwaysImages;
  $("set-sound").checked = state.sound;
  $("set-notify").checked = state.notify && "Notification" in window && Notification.permission === "granted";
  syncPushSwitch().catch(() => {});
  renderStorage();

  retireActionToast();
  $("settings").showModal();
  requestAnimationFrame(renderThemeSeg);   // measured once the drawer is on screen
}

export function closeSettings() {
  $("settings").close();
}

/** Fills the limits form from the config the server just sent. */
function renderLimits() {
  const cfg = state.config;
  if (!cfg?.limits) return;
  const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const fields = {
    "lim-retention": cfg.retentionDays,
    "lim-per-address": cfg.limits.perAddress,
    "lim-total": cfg.limits.total,
    "lim-raw": mb(cfg.limits.rawBytes),
    "lim-attachment": mb(cfg.limits.attachmentBytes),
  };
  for (const [id, value] of Object.entries(fields)) $(id).value = String(value);

  // Bound the inputs with the ranges the server publishes, so the form cannot
  // offer a value the API would reject.
  const ranges = cfg.ranges ?? {};
  const bind = (id, range) => {
    if (!range) return;
    $(id).min = String(range.min);
    $(id).max = String(range.max);
  };
  bind("lim-retention", ranges.retentionDays);
  bind("lim-per-address", ranges.perAddress);
  bind("lim-total", ranges.total);
  bind("lim-raw", ranges.rawMb);
  bind("lim-attachment", ranges.attachmentMb);
}

export async function saveLimits(event) {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    state.config = await send("PUT", "/api/settings", {
      retentionDays: Number($("lim-retention").value),
      perAddress: Number($("lim-per-address").value),
      total: Number($("lim-total").value),
      rawMb: Number($("lim-raw").value),
      attachmentMb: Number($("lim-attachment").value),
    });
    renderLimits();
    renderStorage();
    toast("Limits saved", "i-database");
  } catch (err) {
    toast(err.message, "i-warn");
  } finally {
    button.disabled = false;
  }
}

export function setAutoRefresh(on) {
  state.autoRefresh = on;
  store.set(PREFS.autoRefresh, on ? "on" : "off");
  $("set-autorefresh").checked = on;
  $("domain-pill").classList.toggle("paused", !on);
  clearTimeout(state.pollTimer);
  if (on) poll();
}

export function setAlwaysImages(on) {
  state.alwaysImages = on;
  store.set(PREFS.images, on ? "on" : "off");
  $("set-images").checked = on;
}

/**
 * The domains this inbox offers, in order. The first is the default -- the one
 * new addresses are made at -- and clicking any other promotes it.
 *
 * Read-only when MAIL_DOMAIN is set, because that variable also decides which
 * mail is accepted: offering an address the Worker would bounce is worse than
 * not offering it.
 */
function renderDomains() {
  const locked = state.config?.domainSource === "env";
  $("domain-list").innerHTML = (state.mailDomains || []).map((domain, i) => {
    const isDefault = i === 0;
    return `<div class="domain-row">
      <button type="button" class="domain-pick" data-domain="${escapeHtml(domain)}" aria-pressed="${isDefault}"
              ${locked || isDefault ? "disabled" : ""} title="${isDefault ? "New addresses are made here" : `Make ${escapeHtml(domain)} the default`}">
        <svg class="icon sm" aria-hidden="true"><use href="#i-globe"/></svg>
        <span class="name">${escapeHtml(domain)}</span>
        ${isDefault ? '<span class="life">default</span>' : ""}
      </button>
      <button type="button" class="domain-drop" data-drop="${escapeHtml(domain)}" ${locked ? "disabled" : ""}
              aria-label="Remove ${escapeHtml(domain)}" title="Remove ${escapeHtml(domain)}">
        <svg class="icon sm" aria-hidden="true"><use href="#i-trash"/></svg>
      </button>
    </div>`;
  }).join("");
}

/** Writes a new domain list, repaints everything that shows a domain. */
async function putDomains(body, message) {
  try {
    state.config = await send("PUT", "/api/settings", body);
    renderDomain();
    renderDomains();
    state.railSig = "";
    renderRail();
    toast(message(), "i-globe");
  } catch (err) {
    toast(err.message, "i-warn");
  }
}

/** The form adds a domain rather than replacing the one that is there. */
export async function saveDomain(event) {
  event.preventDefault();
  const typed = $("set-domain").value.trim();
  if (!typed) {
    // An empty submit is the old "clear the domain", and still is.
    await putDomains({ mailDomain: "" }, () => "Domains cleared");
    renderDomains();
    return;
  }
  const next = [...(state.mailDomains || []), typed];
  await putDomains({ mailDomains: next }, () => `${state.mailDomain} is the domain`);
  $("set-domain").value = "";
}

export async function makeDomainDefault(domain) {
  await putDomains({ mailDomain: domain }, () => `New addresses are made at ${domain}`);
}

export async function dropDomain(domain) {
  const next = (state.mailDomains || []).filter((d) => d !== domain);
  await putDomains(next.length ? { mailDomains: next } : { mailDomain: "" }, () => `${domain} removed`);
}

export async function saveBrand(event) {
  event.preventDefault();
  try {
    state.config = await send("PUT", "/api/settings", { brandName: $("set-brand").value.trim() });
    renderBrand();
    toast(`Now called ${brandName()}`, "i-tag");
  } catch (err) {
    toast(err.message, "i-warn");
  }
}

export async function changePassword(event) {
  event.preventDefault();
  const form = $("password-form");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await send("POST", "/api/password", { currentPassword: $("pw-current").value, newPassword: $("pw-new").value });
    form.reset();
    toast("Password changed", "i-shield");
  } catch (err) {
    toast(err.message, "i-warn");
  } finally {
    button.disabled = false;
  }
}

export async function toggleNotifications(on) {
  if (on && "Notification" in window && Notification.permission !== "granted") {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      $("set-notify").checked = false;
      toast("Notifications are blocked for this site", "i-warn");
      return;
    }
  }
  state.notify = on && "Notification" in window;
  store.set("notify", state.notify ? "on" : "off");
}

/**
 * Switching the Screener on vouches for everyone already in the inbox, which
 * the server does in the same call -- so the only thing to report here is
 * whether it is now on.
 */
export async function setScreener(on) {
  try {
    state.config = await send("PUT", "/api/settings", { screener: on });
  } catch (err) {
    $("set-screener").checked = !on;
    toast(err.message, "i-warn");
    return;
  }
  state.railSig = "";
  renderRail();
  toast(on ? "New senders will wait in the Screener" : "Everything lands in the inbox again", "i-shield");
  await refresh().catch(() => {});
}

/**
 * What the junk filter has been taught, said plainly.
 *
 * A count of messages, not a percentage or a confidence: those are numbers
 * nobody can act on, and the only thing the owner can actually do about this
 * filter is teach it more or make it forget.
 */
function renderJunkState() {
  const junk = state.config?.junk;
  const line = $("junk-state");
  if (!junk) { line.textContent = ""; $("junk-forget").hidden = true; return; }
  line.textContent = junk.ready
    ? `Junk filter: trained on ${plural(junk.junk, "junk message")} and ${plural(junk.ham, "good one")}.`
    : `Junk filter: off until you mark ${junk.needed} junk and ${junk.needed} good messages. ${junk.junk} and ${junk.ham} so far.`;
  $("junk-forget").hidden = junk.junk === 0 && junk.ham === 0;
}

export async function forgetJunk() {
  try {
    const result = await send("DELETE", "/api/junk", {});
    state.config = { ...state.config, junk: result.junk };
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  renderJunkState();
  state.railSig = "";
  renderRail();
  toast("The junk filter has forgotten everything", "i-refresh");
}

export function setSound(on) {
  state.sound = on;
  store.set("sound", on ? "on" : "off");
  $("btn-sound").querySelector("use").setAttribute("href", on ? "#i-sound" : "#i-sound-off");
  $("btn-sound").setAttribute("aria-pressed", String(on));
  $("set-sound").checked = on;
}

export async function deleteAll() {
  if (!confirm("Delete every message in this inbox? This cannot be undone.")) return;
  try {
    await send("DELETE", "/api/messages?all=1");
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  closeSettings();
  closeMessage();
  toast("All mail deleted", "i-trash");
  refresh().catch(() => {});
}

export async function markAllRead() {
  // With a search or a view filter up, "all" has to mean the messages actually
  // on screen — it used to clear the whole inbox and leave the reader with no
  // idea that mail they had not seen was now marked read.
  const narrowed = !!state.query || state.view === "starred" || state.view === "unread";
  const shown = visibleMessages().filter((m) => !m.read);
  if (narrowed && !shown.length) { toast("Nothing unread here", "i-check-all"); return; }

  try {
    if (narrowed) {
      await sendInSlices("PATCH", "/api/messages", shown.map((m) => m.id), { read: true });
    } else {
      const query = state.filter ? `?address=${encodeURIComponent(state.filter)}` : "";
      await send("POST", `/api/read-all${query}`);
    }
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }

  if (narrowed) {
    const cleared = new Set(shown.map((m) => m.id));
    for (const m of state.messages) if (cleared.has(m.id)) m.read = true;
    for (const m of shown) bumpUnread(m.address, -1);
  } else {
    for (const m of state.messages) m.read = true;
    for (const a of state.addresses) if (!state.filter || a.address === state.filter) a.unread = 0;
  }
  renderFeed();
  renderRail();
  renderTitle();
  toast("Marked as read", "i-check-all");
}

export async function logout() {
  // This device should stop receiving pushes once nobody is signed in on it.
  try {
    const sub = await swRegistration?.pushManager.getSubscription();
    if (sub) { await send("DELETE", "/api/push/subscriptions", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch { /* best effort */ }
  store.remove(PREFS.push);
  try { await fetch("/api/logout", { method: "POST" }); } catch { /* the cookie clears on reload anyway */ }
  store.remove(CACHE_KEY);
  location.replace("/");
}

/* ------------------------------------------ drawer: drag-to-dismiss sheet */

/* On a phone the settings panel is a bottom sheet. Dragging the grip moves
   it with the finger; past a third of its height, or on a fast flick, it
   closes — otherwise it springs back. */
/** Swipe a bottom sheet down to dismiss it. Any panel with a grip can use it. */
export function wireDrawerDrag(panelId = "drawer-panel", gripId = "drawer-grip", dismiss = closeSettings) {
  const panel = $(panelId);
  const grip = $(gripId);
  let startY = 0;
  let startedAt = 0;
  let offset = 0;
  let dragging = false;

  grip.addEventListener("pointerdown", (e) => {
    if (isDesktop()) return;
    dragging = true;
    startY = e.clientY;
    startedAt = performance.now();
    offset = 0;
    panel.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);
  });

  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    offset = Math.max(0, e.clientY - startY);
    panel.style.translate = `0 ${offset}px`;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    panel.style.translate = "";
    const velocity = offset / Math.max(1, performance.now() - startedAt); // px per ms
    if (offset > panel.offsetHeight / 3 || velocity > 0.6) dismiss();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

/* ------------------------------------------------------------------- push */

let swRegistration = null;

/** Registers the service worker that shows pushes; harmless where unsupported. */
let swListening = false;

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  // Registering twice — two callers racing, or a retry after a failure — used
  // to add a second listener, and every notification tap then fired twice.
  if (!swListening) {
    swListening = true;
    navigator.serviceWorker.addEventListener("message", (e) => handleWorkerMessage(e.data));
  }
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch (err) {
    console.warn("service worker unavailable", err);
    return null;
  }
}

/** A notification was tapped: open the message, and copy the code if the tap said so. */
export async function handleWorkerMessage(data) {
  if (!data || typeof data !== "object") return;
  if (data.open) openMessage(data.open).catch(() => {});
  // Anything can arrive here from a ?copy= parameter, and copying happens with
  // no user gesture, so only a code-shaped value is allowed near the clipboard.
  if (data.copy && /^[A-Za-z0-9][A-Za-z0-9 -]{3,11}$/.test(data.copy)) {
    const done = await copyText(data.copy);
    toast(done ? `Code ${data.copy} copied` : `Code ${data.copy} (tap the chip to copy)`, done ? "i-tick" : "i-key");
  }
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function iosNotInstalled() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.standalone !== true;
}

function urlBase64ToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Reflects the real subscription state in the switch. */
async function syncPushSwitch() {
  const box = $("set-push");
  const hint = $("push-hint");
  if (!pushSupported()) {
    box.checked = false; box.disabled = true;
    hint.textContent = "Not supported by this browser";
    return;
  }
  if (iosNotInstalled()) {
    box.checked = false; box.disabled = true;
    hint.textContent = "On iPhone, add this site to your Home Screen first, then turn this on from there";
    return;
  }
  box.disabled = false;
  hint.textContent = "Codes on the lock screen, even with the app closed";
  const reg = swRegistration ?? (await registerServiceWorker());
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  state.push = !!sub && store.get(PREFS.push) === "on";
  box.checked = state.push;
}

export async function togglePush(on) {
  const box = $("set-push");
  const reg = swRegistration ?? (await registerServiceWorker());
  if (!reg) { box.checked = false; toast("Push needs a service worker, which this browser refused", "i-warn"); return; }
  try {
    if (on) {
      if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
        box.checked = false;
        toast("Notifications are blocked for this site", "i-warn");
        return;
      }
      const { key } = await api("/api/push/key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
      await send("POST", "/api/push/subscriptions", sub.toJSON());
      state.push = true;
      store.set(PREFS.push, "on");
      toast("Pushes on: codes will reach this device", "i-tick");
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await send("DELETE", "/api/push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      state.push = false;
      store.set(PREFS.push, "off");
      toast("Pushes off for this device", "i-tick");
    }
  } catch (err) {
    box.checked = state.push;
    toast(`Could not ${on ? "enable" : "disable"} pushes: ${err.message}`, "i-warn");
  }
}

/* ------------------------------------------------------------------ theme */

/** The theme actually on screen. */
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** What the user asked for: an explicit theme, or "system" to follow the device. */
export function themePref() {
  const saved = store.get(PREFS.theme);
  return saved === "light" || saved === "dark" ? saved : "system";
}

const lightScheme = matchMedia("(prefers-color-scheme: light)");

export function applyTheme(pref) {
  if (pref === "system") store.remove(PREFS.theme);
  else store.set(PREFS.theme, pref);
  paintTheme(pref === "system" ? (lightScheme.matches ? "light" : "dark") : pref);
}

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("btn-theme").querySelector("use").setAttribute("href", theme === "light" ? "#i-moon" : "#i-sun");
  $("btn-theme").setAttribute("aria-label", theme === "light" ? "Switch to the dark theme" : "Switch to the light theme");
  renderThemeSeg();
}

function renderThemeSeg() {
  renderSchemeSwatches();
  const seg = $("theme-seg");
  const pref = themePref();
  for (const button of seg.querySelectorAll(".seg-btn")) {
    button.setAttribute("aria-pressed", String(button.dataset.theme === pref));
  }
  if ($("settings").open) moveSegHighlight(seg);
}

export function schemePref() {
  const saved = store.get(PREFS.scheme);
  return SCHEMES.includes(saved) ? saved : "mono";
}

export function applyScheme(name) {
  if (!SCHEMES.includes(name)) return;
  if (name === "mono") {
    store.remove(PREFS.scheme);
    delete document.documentElement.dataset.scheme;
  } else {
    store.set(PREFS.scheme, name);
    document.documentElement.dataset.scheme = name;
  }
  renderSchemeSwatches();
}

function renderSchemeSwatches() {
  const current = schemePref();
  for (const button of $("scheme-swatches").querySelectorAll("[data-scheme]")) {
    button.setAttribute("aria-checked", String(button.dataset.scheme === current));
  }
}

// Following the device means repainting when the device changes its mind.
lightScheme.addEventListener("change", () => { if (themePref() === "system") applyTheme("system"); });

/**
 * Flips the theme with a circular wipe growing out of the toggle button,
 * the technique Animate UI's theme toggler uses: take a View Transition
 * snapshot, then animate the new snapshot's clip-path from a dot at the
 * button to a circle covering the furthest corner. Browsers without View
 * Transitions just switch instantly.
 */
export function toggleTheme(origin) {
  const next = currentTheme() === "light" ? "dark" : "light";

  if (!document.startViewTransition || reducedMotion.matches) {
    applyTheme(next);
    return;
  }

  const button = origin ?? $("btn-theme");
  const box = button.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  document.startViewTransition(() => applyTheme(next)).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  }).catch(() => { /* the theme still changed */ });
}
