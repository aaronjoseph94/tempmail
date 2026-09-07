/* AJ's Temp Email — inbox front-end.
   Plain browser JavaScript, no build step. Talks to the JSON API in src/api.ts.

   Motion notes: entrances run ~0.22s, exits ~0.12s, and anything that moves
   between two places (the rail highlight, the segmented control) is measured
   first and then animated, so it travels rather than jumping. Everything
   defers to prefers-reduced-motion. */

"use strict";

const $ = (id) => document.getElementById(id);

const PAGE_SIZE = 50;
const MAX_WINDOW = 500;       // the API's own page-size ceiling
const POLL_VISIBLE_MS = 8000;
const POLL_HIDDEN_MS = 30000;
const POLL_LIVE_MS = 60000;        // with a live socket the poll is only a backstop
const CACHE_KEY = "cache_v3";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------------------ state */

const state = {
  config: null,          // GET /api/config
  mailDomain: "",        // shown after the @
  address: "",           // generated local part, e.g. "quiet-otter-42"
  messages: [],
  addresses: [],
  filter: "",            // address being viewed; "" is all mail
  candidate: "",         // the local part the new-inbox sheet is offering
  query: "",             // search text
  hasMore: false,
  nextCursor: null,
  windowSize: PAGE_SIZE, // how many messages the list holds and each poll refreshes
  open: null,            // full message object in the viewer
  showHtml: true,
  imagesAllowed: false,
  newestSeen: 0,         // receivedAt of the newest mail seen; newer than this is "new"
  polledOnce: false,
  pollTimer: null,
  feedSig: "",
  railSig: "",
  lastFeedRender: 0,
  sound: true,
  notify: false,
  autoRefresh: true,
  view: "all",             // all | unread | starred | leaks
  waiting: null,           // { address, since } while the code overlay is up
  push: false,             // this browser is subscribed to pushes
  selecting: false,
  picked: new Set(),
  alwaysImages: false,
};

/** Preference keys kept per device rather than on the server. */
const PREFS = {
  sound: "sound", notify: "notify", autoRefresh: "auto_refresh",
  images: "always_images", address: "address", theme: "theme", push: "push",
};

/** Lifecycles a generated address can be given, keyed by the picker's value. */
const ROLL_MODES = {
  permanent: { mode: "permanent" },
  "24h": { mode: "expires", ttlHours: 24 },
  "7d": { mode: "expires", ttlHours: 24 * 7 },
};

/* ---------------------------------------------------------------- helpers */

// localStorage throws in private mode and when site data is blocked.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* fine without it */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* fine without it */ } },
};

let toastTimer = null;
let toastHideTimer = null;
/** A short notice. With an action it stays longer and carries one button (Undo, say). */
function toast(text, icon = "i-tick", { action = null, onAction = null, duration = null } = {}) {
  const el = $("toast");
  clearTimeout(toastHideTimer);   // a toast mid-exit must not hide this one
  el.classList.remove("out");
  el.innerHTML = `<svg class="icon sm" aria-hidden="true"><use href="#${icon}"/></svg><span></span>`;
  el.querySelector("span").textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-act";
    button.textContent = action;
    button.addEventListener("click", () => { hideToast(); onAction?.(); });
    el.appendChild(button);
  }
  el.hidden = false;
  // The settings drawer is a <dialog> opened with showModal(), which lives in
  // the browser's top layer and paints above every z-index there is. A toast
  // raised while it is open was landing behind it, so "Domain saved" was
  // invisible exactly when it mattered. A popover joins that same top layer.
  showOnTop(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration ?? (action ? 10000 : 2400));
}

/**
 * Puts an element in the top layer where supported; harmless where not.
 *
 * Always re-promotes. Rank in the top layer is the order things were promoted,
 * so a toast still open from before a dialog opened would sit underneath it —
 * which is the whole failure this exists to prevent.
 */
function showOnTop(el) {
  if (typeof el.showPopover !== "function") return;
  try { if (el.matches(":popover-open")) el.hidePopover(); } catch { /* not open */ }
  try { el.showPopover(); } catch { /* refused; the z-index fallback stands */ }
}

function hideOnTop(el) {
  if (typeof el.hidePopover !== "function") return;
  try { if (el.matches(":popover-open")) el.hidePopover(); } catch { /* already hidden */ }
}

function hideToast() {
  const el = $("toast");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  el.classList.add("out");
  toastHideTimer = setTimeout(() => { el.hidden = true; hideOnTop(el); }, 140);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function timeAgo(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 45) return "now";
  // Round rather than floor, so the 45-59s window reads "1m" and never "0m".
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayLabel(ts) {
  const date = new Date(ts);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** Times are always shown on a 12-hour clock, whatever the locale prefers. */
function formatWhen(ts, opts = { dateStyle: "medium", timeStyle: "short" }) {
  return new Date(ts).toLocaleString(undefined, { ...opts, hour12: true });
}

/**
 * Renders a number as sliding digit columns, the way SmoothUI's number-flow
 * does: each digit is a two-high strip that slides when the value changes.
 * Falls back to plain text when the digit count changes.
 */
function renderRoll(el, value) {
  const next = String(value);
  if (el.dataset.value === next) return;
  const previous = el.dataset.value ?? "";
  el.dataset.value = next;

  if (previous === "" || previous.length !== next.length || reducedMotion.matches) {
    el.textContent = next;
    return;
  }
  el.textContent = "";
  const roll = document.createElement("span");
  roll.className = "roll";
  for (let i = 0; i < next.length; i++) {
    const col = document.createElement("span");
    col.className = "col";
    col.innerHTML = `<span>${escapeHtml(previous[i])}</span><span>${escapeHtml(next[i])}</span>`;
    roll.appendChild(col);
  }
  el.appendChild(roll);
  requestAnimationFrame(() => {
    for (const col of roll.querySelectorAll(".col")) col.classList.add("up");
  });
  // Once the slide finishes, collapse back to plain text.
  setTimeout(() => { if (el.dataset.value === next) el.textContent = next; }, 400);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and insecure contexts: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
    area.remove();
    return ok;
  }
}

/** Escapes plain text and turns bare URLs into links that open in a new tab. */
function linkify(text) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, ""); // trailing punctuation isn't part of the link
    out += escapeHtml(text.slice(last, match.index));
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    last = match.index + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

function initialsFor(name) {
  const parts = name.trim().split(/[\s.<@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function senderLabel(m) {
  return m.fromName || m.fromAddress || "unknown";
}

/* One query object rather than a fresh matchMedia per call, so the breakpoint
   can also be subscribed to. */
const wideQuery = matchMedia("(min-width: 900px)");
function isDesktop() {
  return wideQuery.matches;
}

/* -------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    signedOut();
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function send(method, path, body) {
  return api(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function signedOut() {
  dropLive();
  store.remove(CACHE_KEY);
  location.replace("/");
}

/* ------------------------------------------------------------------- data */

async function loadConfig() {
  state.config = await api("/api/config");
  renderDomain();
  renderStorage();
}

function listUrl({ cursor = null, limit = state.windowSize } = {}) {
  const params = new URLSearchParams();
  if (state.filter) params.set("address", state.filter);
  if (state.query) params.set("q", state.query);
  if (state.view === "unread") params.set("unread", "1");
  if (state.view === "starred") params.set("starred", "1");
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return `/api/messages?${params}`;
}

let refreshSeq = 0;

/** Reloads the list and the address rail. With announce, reports new arrivals. */
async function refresh({ announce = false } = {}) {
  const seq = ++refreshSeq;
  const [list, rail] = await Promise.all([api(listUrl()), api("/api/addresses")]);
  if (seq !== refreshSeq) return; // a newer refresh already landed

  const previousNewest = state.newestSeen;
  applyList(list);
  applyRail(rail.addresses);
  if (announce && state.polledOnce && state.newestSeen > previousNewest) announceNewMail(previousNewest);
  state.polledOnce = true;
  saveCache();
}

function applyList(data) {
  const arrived = new Set();
  if (state.polledOnce) {
    for (const m of data.messages) if (m.receivedAt > state.newestSeen) arrived.add(m.id);
  }
  state.messages = data.messages;
  if (state.waiting) checkWaiting(data.messages);
  state.hasMore = data.hasMore;
  state.nextCursor = data.nextCursor;
  $("feed").setAttribute("aria-busy", "false");
  renderFeed(arrived);
}

/**
 * Looks for the message the code overlay is waiting for.
 *
 * The list it is handed is whatever the current view asked for, so a filter on
 * another address — or any search — hid the arrival and the overlay waited for
 * ever. When the view cannot answer, the address is queried directly.
 */
async function checkWaiting(messages) {
  const waiting = state.waiting;
  if (!waiting) return;
  const matches = (m) => m.address === waiting.address && m.receivedAt > waiting.since;
  const hit = messages.find(matches);
  if (hit) { codeArrived(hit); return; }
  if (!state.filter && !state.query && state.view === "all") return;  // the list above was authoritative
  try {
    const scoped = await api(`/api/messages?address=${encodeURIComponent(waiting.address)}&limit=10`);
    const late = scoped.messages.find(matches);
    if (late && state.waiting === waiting) codeArrived(late);
  } catch { /* the next poll tries again */ }
}

function applyRail(addresses) {
  state.addresses = addresses;
  state.newestSeen = Math.max(state.newestSeen, ...addresses.map((a) => a.lastReceivedAt || 0));
  renderRail();
  renderTitle();
  renderStorage();
  // The first message to arrive tells us the domain when nothing else did.
  if (!state.mailDomain && addresses.length) loadConfig().catch(() => {});
}

function announceNewMail(since) {
  const arrived = state.messages.filter((m) => m.receivedAt > since);
  let text;
  if (arrived.length === 1) {
    text = `${senderLabel(arrived[0])}: ${arrived[0].subject || "(no subject)"}`;
  } else if (arrived.length > 1) {
    text = `${arrived.length} new messages`;
  } else {
    // Mail for an address outside the current filter; the rail is newest-first.
    const target = state.addresses.find((a) => a.lastReceivedAt > since);
    text = target ? `New mail for ${target.address}` : "New mail";
  }
  toast(text, "i-mail");
  if (state.sound) chime();
  // With pushes on, the service worker's notification covers the hidden case.
  if (state.notify && !state.push && document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const note = new Notification("AJ\u2019s Temp Email", { body: text, tag: "tempmail-new" });
      note.onclick = () => {
        window.focus();
        if (arrived.length === 1) openMessage(arrived[0].id);
        note.close();
      };
    } catch { /* the toast covers it */ }
  }
}

/**
 * The arrival chime: two low notes, quiet enough to sit behind whatever else
 * is playing. Sound is either on or off; there is nothing to choose.
 */
const CHIME = { type: "sine", notes: [392, 523.25], gain: 0.09, length: 0.42 };

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    CHIME.notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = CHIME.type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const at = now + index * 0.09;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(CHIME.gain, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + CHIME.length);
      osc.start(at);
      osc.stop(at + CHIME.length + 0.02);
    });
    setTimeout(() => ctx.close(), (CHIME.notes.length * 0.09 + CHIME.length + 0.3) * 1000);
  } catch { /* audio unavailable */ }

  // Ripple the speaker waves in time with the sound.
  const button = $("btn-sound");
  button.classList.remove("ringing");
  void button.offsetWidth;
  button.classList.add("ringing");
  setTimeout(() => button.classList.remove("ringing"), 800);
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.autoRefresh) return;   // the user asked to check only on demand
  let wait = document.hidden ? POLL_HIDDEN_MS : state.live ? POLL_LIVE_MS : POLL_VISIBLE_MS;
  if (state.waiting && !state.live && !document.hidden) wait = 3000;   // someone is staring at the overlay
  state.pollTimer = setTimeout(poll, wait);
}

/* ------------------------------------------------------------------ live */

let liveSocket = null;
let liveRetry = 0;          // consecutive reconnect attempts, for the backoff
let liveFailures = 0;       // sockets that died within a second of opening
let livePing = null;
let liveTimer = null;
let arrivalTimer = null;

/** Opens the WebSocket that announces new mail; polling remains as a backstop. */
function connectLive() {
  if (liveSocket || !("WebSocket" in window) || liveFailures >= 3) return;
  let ws;
  try {
    ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`);
  } catch {
    return;
  }
  liveSocket = ws;
  const opened = Date.now();
  ws.onopen = () => {
    liveRetry = 0;
    setLive(true);
    livePing = setInterval(() => { try { ws.send("ping"); } catch { /* closing */ } }, 25000);
  };
  ws.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    if (event?.type === "new") {
      // Several arrivals in a burst become one refresh.
      clearTimeout(arrivalTimer);
      arrivalTimer = setTimeout(() => refresh({ announce: true }).catch(() => {}), 250);
    }
  };
  ws.onclose = () => {
    clearInterval(livePing);
    if (liveSocket === ws) liveSocket = null;
    setLive(false);
    // A socket that dies at once is being refused (signed out, or no
    // upgrade support in front of the Worker); stop hammering after three.
    liveFailures = Date.now() - opened < 1000 ? liveFailures + 1 : 0;
    if (liveFailures >= 3) return;
    const delay = Math.min(30000, 1000 * 2 ** liveRetry++) + Math.random() * 500;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(connectLive, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
}

function setLive(on) {
  if (state.live === on) return;
  state.live = on;
  const pill = $("domain-pill");
  pill.classList.toggle("live", on);
  pill.title = on ? "Connected: new mail appears the moment it arrives" : "Checking for new mail every few seconds";
  schedulePoll();
}

function dropLive() {
  liveFailures = 3;           // no reconnects until the page is reloaded
  clearTimeout(liveTimer);
  try { liveSocket?.close(); } catch { /* fine */ }
}

async function poll() {
  try {
    await refresh({ announce: true });
  } catch (err) {
    if (err.message !== "Signed out") console.warn("poll failed", err);
  } finally {
    schedulePoll();
  }
}

async function loadOlder() {
  if (!state.nextCursor) return;
  const button = $("btn-more");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const data = await api(listUrl({ cursor: state.nextCursor, limit: PAGE_SIZE }));
    const seen = new Set(state.messages.map((m) => m.id));
    state.messages.push(...data.messages.filter((m) => !seen.has(m.id)));
    state.hasMore = data.hasMore;
    state.nextCursor = data.nextCursor;
    state.windowSize = Math.min(MAX_WINDOW, Math.max(state.windowSize, state.messages.length));
    renderFeed();
  } catch (err) {
    toast(err.message, "i-warn");
  } finally {
    button.disabled = false;
    button.textContent = "Load older messages";
  }
}

// The last known state paints instantly on the next visit; the network follows.
function saveCache() {
  store.set(CACHE_KEY, JSON.stringify({
    // The extracted verification code is dropped: it is the one field here
    // worth stealing, it is worthless within minutes, and the network response
    // restores it a moment after the cached list paints.
    messages: state.messages.slice(0, PAGE_SIZE).map(({ code, ...rest }) => rest),
    addresses: state.addresses,
    mailDomain: state.mailDomain,
  }));
}

function loadCache() {
  try {
    const cache = JSON.parse(store.get(CACHE_KEY) || "null");
    if (!cache || !Array.isArray(cache.messages)) return false;
    state.messages = cache.messages;
    // Array-checked, not just truthy: renderRail iterates it, so a cache
    // written by a version that shaped this differently would throw on boot
    // and leave nothing on screen at all.
    state.addresses = Array.isArray(cache.addresses) ? cache.addresses : [];
    state.mailDomain = cache.mailDomain || "";
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- rendering */

function renderTitle() {
  const unread = state.addresses.reduce((n, a) => n + (a.unread || 0), 0);
  document.title = unread ? `(${unread}) AJ\u2019s Temp Email` : "AJ\u2019s Temp Email";
}

function renderDomain() {
  state.mailDomain = state.config?.mailDomain || state.mailDomain || "";
  $("domain-pill").hidden = !state.mailDomain;
  $("domain-label").textContent = state.mailDomain;
  renderAddressCard();
}

function renderAddressCard() {
  $("addr-local").textContent = state.address;
  $("addr-domain").textContent = state.mailDomain ? `@${state.mailDomain}` : "@…";
  $("addr-hint").hidden = !!state.mailDomain;
}

function totals() {
  return {
    count: state.addresses.reduce((n, a) => n + a.count, 0),
    unread: state.addresses.reduce((n, a) => n + a.unread, 0),
  };
}

function renderStorage() {
  const cap = state.config?.limits?.total;
  if (!cap) return;
  const used = totals().count;
  $("storage-fill").style.width = `${Math.min(100, (used / cap) * 100).toFixed(1)}%`;
  renderRoll($("storage-used"), used);
  $("storage-cap").textContent = `of ${cap.toLocaleString()} kept`;
  $("retention-note").textContent =
    `Mail deletes itself after ${state.config.retentionDays} days. ` +
    `Up to ${state.config.limits.perAddress} messages per address, ` +
    `${formatBytes(state.config.limits.rawBytes)} per message.`;
}

function renderRail() {
  const all = totals();
  const sig = JSON.stringify([state.filter, all, state.addresses.map((a) => [a.address, a.count, a.unread, a.label, a.mode, a.expiresAt, a.used, a.leaks?.length])]);
  if (sig !== state.railSig) {
    const hadRows = state.railSig !== "";
    state.railSig = sig;
    const rows = [railRow({ address: "", label: "All mail", count: all.count, unread: all.unread, all: true })];
    for (const a of state.addresses) {
      rows.push(railRow({ address: a.address, label: a.address.split("@")[0], name: a.label, count: a.count, unread: a.unread, entry: a }));
    }
    // A freshly rolled address has no mail yet but can still be selected.
    if (state.filter && !state.addresses.some((a) => a.address === state.filter)) {
      rows.push(railRow({ address: state.filter, label: state.filter.split("@")[0], count: 0, unread: 0 }));
    }
    if (!state.addresses.length) rows.push('<div class="rail-empty">No mail received yet</div>');
    // The rows live in exactly one place: the rail on desktop, the phone's
    // picker below 900px. Rendering into both would leave two elements for
    // every data-address, which makes every selector -- ours and the tests' --
    // ambiguous. The breakpoint listener re-renders when the width crosses.
    const target = isDesktop() ? $("rail-list") : $("picker-list");
    const other = isDesktop() ? $("picker-list") : $("rail-list");
    if (other.firstChild) other.replaceChildren();
    target.innerHTML = rows.join("");
    if (hadRows) for (const badge of target.querySelectorAll(".badge")) badge.classList.add("bump");
    $("addr-count").textContent = state.addresses.length ? String(state.addresses.length) : "";
  }
  moveRailHighlight();
  renderViewChips();
  renderListHead();
}

function railRow({ address, label, name, count, unread, all = false, entry = null }) {
  const active = state.filter === address;
  const tally = unread > 0 ? `<span class="badge">${unread}</span>` : `<span class="count">${count}</span>`;
  const local = escapeHtml(label);
  const life = lifeChip(entry);
  // A named address shows its name with the raw local part underneath.
  const body = name
    ? `<span class="stack-2"><span class="tag-label">${escapeHtml(name)}${life}</span><span class="sub">${local}</span></span>`
    : `<span class="name">${local}${life}</span>`;
  const blocked = entry?.mode === "blocked";
  const tools = all ? "" : `<div class="rail-tools">
    <button class="rename" data-rename="${escapeHtml(address)}" aria-label="Name ${escapeHtml(address)}" title="Give this address a name"><svg class="icon sm"><use href="#i-tag"/></svg></button>
    <button class="burn${blocked ? " on" : ""}" data-burn="${escapeHtml(address)}" aria-pressed="${blocked}" aria-label="${blocked ? "Unblock" : "Block"} ${escapeHtml(address)}" title="${blocked ? "Unblock this address" : "Block this address: mail to it bounces"}"><svg class="icon sm"><use href="#i-ban"/></svg></button>
    <button class="wipe" data-kill="${escapeHtml(address)}" aria-label="Delete the inbox ${escapeHtml(address)}" title="Delete this inbox and all its mail"><svg class="icon sm"><use href="#i-trash"/></svg></button>
  </div>`;
  const icon = all ? '<svg class="icon sm" aria-hidden="true"><use href="#i-inbox"/></svg>' : "";
  const dead = entry?.dead ? " dead" : "";
  return `<div class="rail-row">
    <button class="rail-item${all ? " all" : ""}${active ? " active" : ""}${dead}" data-address="${escapeHtml(address)}"${active ? ' aria-current="true"' : ""} title="${escapeHtml(address || "Every address")}">
      ${icon}${body}${tally}
    </button>${tools}</div>`;
}

/** The small lifecycle tag on a rail row: "<1h", "23h", "6d", "blocked". */
function lifeChip(entry) {
  if (!entry) return "";
  if (entry.mode === "blocked") return '<span class="life dead">blocked</span>';
  if (entry.mode === "expires") {
    const left = entry.expiresAt - Date.now();
    if (left <= 0) return '<span class="life dead">expired</span>';
    return `<span class="life${left < 3600000 * 2 ? " soon" : ""}" title="Bounces mail from ${formatWhen(entry.expiresAt)}">${timeLeft(left)}</span>`;
  }
  return "";
}

function timeLeft(ms) {
  // Rounding up first made every surviving address at least "1h", so an
  // address with four minutes left looked as safe as one with fifty-nine.
  if (ms < 3600000) return "<1h";
  const h = Math.ceil(ms / 3600000);
  if (h < 48) return `${h}h`;
  return `${Math.ceil(h / 24)}d`;
}

/** Client-side twins of the server's leak rules. */
function domainOf(address) {
  const at = (address || "").lastIndexOf("@");
  return at < 0 ? null : address.slice(at + 1).toLowerCase();
}
function relatedDomain(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/**
 * Removes an inbox outright: its mail, then the address row itself, so it stops
 * appearing in the rail. Not undoable, so it asks first.
 */
async function deleteInbox(address) {
  const entry = state.addresses.find((a) => a.address === address);
  const count = entry?.count ?? 0;
  const what = count ? `${address} and ${plural(count, "message")}` : address;
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  try {
    if (count) await send("DELETE", `/api/messages?address=${encodeURIComponent(address)}`);
    await send("DELETE", `/api/addresses/${encodeURIComponent(address)}`);
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  if (state.open?.address === address) closeMessage();
  if (state.filter === address) setFilter("");
  toast(`Deleted ${address.split("@")[0]}`, "i-trash");
  refresh().catch(() => {});
}

/** Blocks an address, or unblocks a blocked one, with an Undo on the toast. */
async function toggleBlock(address) {
  const entry = state.addresses.find((a) => a.address === address);
  const blocking = entry?.mode !== "blocked";
  const previous = entry?.mode ?? "permanent";
  // What Undo should send. An expiry already in the past would be rejected,
  // so there is nothing to restore for an address that has since expired.
  let revert = null;
  if (previous === "blocked") revert = { mode: "blocked" };
  else if (previous === "expires") revert = entry?.expiresAt > Date.now() ? { mode: "expires", expiresAt: entry.expiresAt } : null;
  else revert = { mode: "permanent" };
  try {
    await send("PUT", `/api/addresses/${encodeURIComponent(address)}`, { mode: blocking ? "blocked" : "permanent" });
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  const text = blocking ? `Blocked ${address.split("@")[0]}: mail to it now bounces` : `Unblocked ${address.split("@")[0]}`;
  toast(text, "i-ban", revert ? {
    action: "Undo",
    onAction: () => send("PUT", `/api/addresses/${encodeURIComponent(address)}`, revert).then(() => refresh()).catch((e) => toast(e.message, "i-warn")),
  } : {});
  await refresh().catch(() => {});
  if (state.open?.address === address) renderLeakStrip(state.open);
}

/** Lets the owner say which service an address was made for. */
async function setOwner(address) {
  const entry = state.addresses.find((a) => a.address === address);
  const answer = prompt("Which service was this address given to? (a domain, like netflix.com)", entry?.ownerDomain ?? "");
  if (answer === null) return;
  try {
    await send("PUT", `/api/addresses/${encodeURIComponent(address)}`, { ownerDomain: answer.trim() });
    toast(answer.trim() ? `Owner set to ${answer.trim().toLowerCase()}` : "Owner cleared", "i-tick");
  } catch (err) {
    toast(err.message, "i-warn");
  }
  refresh().catch(() => {});
}

/** The Leaks view: every address hearing from someone other than its owner. */
function leaksHtml() {
  const leaked = state.addresses.filter((a) => a.leaks?.length);
  return leaked.map((a) => {
    const name = a.label ? `${escapeHtml(a.label)} <span class="sub">${escapeHtml(a.address.split("@")[0])}</span>` : escapeHtml(a.address.split("@")[0]);
    const senders = a.leaks.map((l) =>
      `<li><span class="mono">${escapeHtml(l.domain)}</span><span class="dim">${plural(l.count, "message")} · ${timeAgo(l.last)}</span></li>`).join("");
    return `<article class="leak${a.mode === "blocked" ? " blocked" : ""}">
      <header>
        <h3>${name}</h3>
        <p class="dim">Given to <button type="button" class="link mono" data-owner="${escapeHtml(a.address)}" title="Change the owner">${escapeHtml(a.ownerDomain)}</button>, but also hears from:</p>
      </header>
      <ul>${senders}</ul>
      <div class="leak-actions">
        <button type="button" class="btn sm ${a.mode === "blocked" ? "ghost" : ""}" data-burn="${escapeHtml(a.address)}">
          <svg class="icon sm"><use href="#i-ban"/></svg>${a.mode === "blocked" ? "Unblock" : "Block address"}
        </button>
        <button type="button" class="btn sm ghost" data-address="${escapeHtml(a.address)}">Show its mail</button>
      </div>
    </article>`;
  }).join("");
}

/**
 * Slides the single highlight element behind the active rail row, the way
 * Animate UI's highlight primitive does: measure the target, then let CSS
 * spring the pill's offset and size to match. Vertical on desktop, where the
 * rail is a column; horizontal on a phone, where it is a chip strip.
 */
function moveRailHighlight() {
  const list = $("rail-list");
  const active = list.querySelector(".rail-item.active");
  if (!active) {
    list.style.setProperty("--hl-o", "0");
    return;
  }
  const listBox = list.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  list.style.setProperty("--hl-y", `${box.top - listBox.top + list.scrollTop}px`);
  list.style.setProperty("--hl-x", `${box.left - listBox.left + list.scrollLeft}px`);
  list.style.setProperty("--hl-w", `${box.width}px`);
  list.style.setProperty("--hl-h", `${box.height}px`);
  list.style.setProperty("--hl-o", "1");
  // Skip the travel animation on the very first measurement.
  if (list.dataset.ready === "false") {
    requestAnimationFrame(() => { list.dataset.ready = "true"; });
  }
}

/** The same treatment for the Rich / Plain segmented control. */
function moveSegHighlight(seg = $("body-toggle")) {
  const active = seg.querySelector('[aria-pressed="true"]');
  if (!active || seg.hidden) return;
  const box = active.getBoundingClientRect();
  const segBox = seg.getBoundingClientRect();
  seg.style.setProperty("--seg-x", `${box.left - segBox.left}px`);
  seg.style.setProperty("--seg-w", `${box.width}px`);
  if (seg.dataset.ready === "false") requestAnimationFrame(() => { seg.dataset.ready = "true"; });
}

function renderViewChips() {
  const unread = totals().unread;
  $("pip-unread").hidden = unread === 0;
  $("pip-leaks").hidden = !state.addresses.some((a) => a.leaks?.length);
  for (const chip of document.querySelectorAll("[data-view]")) {
    const on = chip.dataset.view === state.view;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

function renderListHead() {
  const entry = state.filter ? state.addresses.find((a) => a.address === state.filter) : null;
  const count = state.filter ? entry?.count ?? 0 : totals().count;
  const unread = state.filter ? entry?.unread ?? 0 : totals().unread;
  $("list-title").textContent = state.filter || "All mail";
  $("list-sub").textContent = count ? `${plural(count, "message")}${unread ? ` · ${unread} unread` : ""}` : "";
  $("btn-wipe").hidden = !state.filter;
  $("btn-rename").hidden = !state.filter;
  const blocked = entry?.mode === "blocked";
  $("btn-burn").hidden = !state.filter;
  $("btn-burn").setAttribute("aria-pressed", String(blocked));
  $("btn-burn").classList.toggle("on", blocked);
  $("btn-burn").title = blocked ? "Unblock this address" : "Block this address: mail to it bounces";
  $("btn-burn").setAttribute("aria-label", $("btn-burn").title);
  $("btn-read-all").hidden = unread === 0;
}

function matchesQuery(m) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [m.subject, m.fromName, m.fromAddress, m.address, m.snippet].some((v) => (v || "").toLowerCase().includes(q));
}

function visibleMessages() {
  return state.messages.filter(matchesQuery);
}

function feedScroller() {
  return isDesktop() ? $("feed") : document.scrollingElement;
}

function skeletonRows(n = 6) {
  return Array.from({ length: n }, () => `
    <div class="skeleton" aria-hidden="true">
      <div class="sk circle"></div>
      <div style="display:flex;flex-direction:column;gap:8px;padding-top:4px">
        <div class="sk line" style="width:38%"></div>
        <div class="sk line" style="width:72%"></div>
        <div class="sk line" style="width:56%"></div>
      </div>
    </div>`).join("");
}

function renderFeed(arrived = new Set()) {
  if (state.view === "leaks") {
    const leaked = state.addresses.filter((a) => a.leaks?.length);
    const sig = JSON.stringify(["leaks", leaked.map((a) => [a.address, a.mode, a.ownerDomain, a.leaks])]);
    if (sig !== state.feedSig) {
      state.feedSig = sig;
      $("feed").innerHTML = leaksHtml();
      $("feed").setAttribute("aria-busy", "false");
    }
    $("btn-more").hidden = true;
    renderEmpty(leaked.length);
    return;
  }
  const visible = visibleMessages();
  const sig = JSON.stringify([state.view, state.filter, state.query, state.open?.id, state.hasMore, visible.map((m) => [m.id, m.read, m.starred])]);
  const timesStale = Date.now() - state.lastFeedRender > 60000; // "5m" labels drift
  if (sig === state.feedSig && !timesStale && arrived.size === 0) return;
  state.feedSig = sig;
  state.lastFeedRender = Date.now();

  // Rebuilding resets the scroll position, so restore it afterwards.
  const scroller = feedScroller();
  const scrollTop = scroller.scrollTop;

  const html = [];
  let group = null;
  let stagger = 0;
  for (const m of visible) {
    const label = dayLabel(m.receivedAt);
    if (label !== group) {
      group = label;
      html.push(`<div class="day">${escapeHtml(label)}</div>`);
    }
    html.push(mailRow(m, arrived.has(m.id) ? stagger++ : -1));
  }
  $("feed").innerHTML = html.join("");
  scroller.scrollTop = scrollTop;

  renderEmpty(visible.length);
  $("btn-more").hidden = !state.hasMore || !!state.query;
  $("search-count").textContent = state.query ? `${visible.length}` : "";
  $("search-clear").hidden = !state.query;
}

function mailRow(m, staggerIndex) {
  const from = senderLabel(m);
  const local = m.address.split("@")[0];
  const classes = [
    "mail",
    m.read ? "" : "unread",
    m.id === state.open?.id ? "open" : "",
    state.picked.has(m.id) ? "picked" : "",
    staggerIndex >= 0 ? "arrived" : "",
  ].filter(Boolean).join(" ");
  const delay = staggerIndex >= 0 ? ` style="--stagger:${Math.min(staggerIndex, 6) * 45}ms"` : "";
  return `<div class="${classes}" data-id="${escapeHtml(m.id)}" role="button" tabindex="0"${delay}>
    <span class="tick-box" aria-hidden="true"><svg class="icon"><use href="#i-tick"/></svg></span>
    <span class="avatar" aria-hidden="true">${escapeHtml(initialsFor(from))}</span>
    <span class="mail-body">
      <span class="mail-top">
        <span class="mail-from">${escapeHtml(from)}</span>
        <span class="mail-aside">
          <span class="mail-time" title="${escapeHtml(formatWhen(m.receivedAt))}">${escapeHtml(timeAgo(m.receivedAt))}</span>
          <button class="star${m.starred ? " on" : ""}" data-star="${escapeHtml(m.id)}" aria-label="${m.starred ? "Unstar" : "Star"} this message" aria-pressed="${!!m.starred}">
            <svg class="icon sm"><use href="#i-star"/></svg>
          </button>
        </span>
      </span>
      <span class="mail-subject">${escapeHtml(m.subject || "(no subject)")}</span>
      ${m.snippet ? `<span class="mail-snippet">${escapeHtml(m.snippet)}</span>` : ""}
      <span class="mail-tags">
        <span class="tag addr" title="${escapeHtml(m.address)}"><span class="at">@</span>${escapeHtml(local)}</span>
        ${m.code ? `<span class="tag code" data-code="${escapeHtml(m.code)}" role="button" tabindex="0" title="Copy code"><svg class="icon"><use href="#i-key"/></svg>${escapeHtml(m.code)}</span>` : ""}
        ${m.hasAttachments ? '<span class="tag" title="Has attachments"><svg class="icon"><use href="#i-clip"/></svg></span>' : ""}
      </span>
    </span>
  </div>`;
}

function renderEmpty(visibleCount) {
  const empty = $("feed-empty");
  empty.hidden = visibleCount > 0;
  if (visibleCount > 0) return;
  const firstRun = state.addresses.length === 0 && !state.query && !state.filter && state.view === "all";
  $("empty-steps").hidden = !firstRun;
  $("empty-hint").hidden = !firstRun;
  if (state.query) {
    $("empty-title").textContent = "No matches";
    $("empty-text").textContent = `Nothing matches “${state.query}”.`;
  } else if (state.view === "unread") {
    $("empty-title").textContent = "All caught up";
    $("empty-text").textContent = "Nothing unread here.";
  } else if (state.view === "starred") {
    $("empty-title").textContent = "No starred mail";
    $("empty-text").textContent = "Star a message to keep it past the nightly cleanup.";
  } else if (state.view === "leaks") {
    $("empty-title").textContent = "No leaks detected";
    $("empty-text").textContent = "Every address here only hears from the service it was given to.";
  } else if (state.filter) {
    $("empty-title").textContent = "Nothing here yet";
    $("empty-text").textContent = `Send something to ${state.filter} and it will appear here.`;
  } else {
    $("empty-title").textContent = "No mail yet";
    $("empty-text").textContent = firstRun ? "Three steps and your first message lands here." : "";
  }
}

/* ----------------------------------------------------- filtering + search */

function setFilter(address) {
  if (state.filter === address) return;
  state.filter = address;
  state.windowSize = PAGE_SIZE;
  if (state.open && !isDesktop()) closeMessage();
  renderRail();
  // Keep the newly selected row in view in the rail's own scroller.
  $("rail-list").querySelector(".rail-item.active")?.scrollIntoView({
    behavior: reducedMotion.matches ? "auto" : "smooth", block: "nearest",
  });
  refresh().catch((err) => toast(err.message, "i-warn"));
}

let searchTimer = null;
function setQuery(text) {
  state.query = text.trim();
  state.windowSize = PAGE_SIZE;
  renderFeed();                                    // filter what is already loaded…
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch(() => {}), 250);  // …then ask the server
}

function focusSearch() {
  document.body.classList.add("searching");
  $("btn-search").setAttribute("aria-expanded", "true");
  $("search").focus();
  $("search").select();
}

function toggleSearch() {
  if (document.body.classList.contains("searching")) {
    document.body.classList.remove("searching");
    $("btn-search").setAttribute("aria-expanded", "false");
    if (state.query) { $("search").value = ""; setQuery(""); }
  } else {
    focusSearch();
  }
}

/* ----------------------------------------------------------------- viewer */

let openSeq = 0;

async function openMessage(id) {
  // Two quick clicks race, and the slower fetch used to win: whichever message
  // answered last was the one shown, regardless of which was asked for last.
  const seq = ++openSeq;
  let msg;
  try {
    msg = await api(`/api/messages/${encodeURIComponent(id)}`);
  } catch (err) {
    if (seq === openSeq) toast(err.message, "i-warn");
    return;
  }
  if (seq !== openSeq) return;
  const wasOpen = !!state.open;
  state.open = msg;
  state.showHtml = !!msg.htmlBody;
  state.imagesAllowed = state.alwaysImages;

  // Reflect the read state locally instead of waiting for the next poll.
  const listed = state.messages.find((m) => m.id === id);
  if (listed && !listed.read) {
    listed.read = true;
    bumpUnread(msg.address, -1);
  }

  renderViewer();
  renderFeed();
  renderRail();
  document.body.classList.add("reading");
  $("viewer").scrollTop = 0;
  // A phone sheet should close with the system back gesture.
  if (!isDesktop() && !wasOpen) history.pushState({ viewer: true }, "");
}

function bumpUnread(address, delta) {
  const entry = state.addresses.find((a) => a.address === address);
  if (entry) entry.unread = Math.max(0, entry.unread + delta);
  renderTitle();
}

function renderViewer() {
  const msg = state.open;
  $("viewer-idle").hidden = !!msg;
  $("message").hidden = !msg;
  if (!msg) return;

  const from = senderLabel(msg);
  $("msg-subject").textContent = msg.subject || "(no subject)";
  const avatar = $("msg-avatar");
  avatar.textContent = initialsFor(from);
  $("msg-from-name").textContent = msg.fromName || msg.fromAddress;
  renderLeakStrip(msg);
  renderAuthBadge(msg);
  renderUnsubChip(msg);
  renderWarnStrip(msg);
  $("msg-from-addr").textContent = msg.fromName ? `<${msg.fromAddress}>` : "";
  $("msg-to").textContent = msg.address;
  $("msg-date").textContent = formatWhen(msg.receivedAt);

  const retentionDays = state.config?.retentionDays ?? 100;
  const daysLeft = Math.max(0, Math.ceil((msg.receivedAt + retentionDays * 86400000 - Date.now()) / 86400000));
  $("msg-expiry").textContent = `deletes in ${plural(daysLeft, "day")}`;

  paintStar();
  $("btn-export").href = `/api/messages/${encodeURIComponent(msg.id)}/export`;

  $("btn-code").hidden = !msg.code;
  $("msg-code").textContent = msg.code || "";
  $("body-toggle").hidden = !(msg.htmlBody && msg.textBody);
  $("btn-images").hidden = !(msg.htmlBody && hasRemoteImages(msg.htmlBody));

  renderAttachments(msg.attachments || []);
  renderBody();
}

function renderAttachments(list) {
  const wrap = $("msg-attachments");
  wrap.hidden = list.length === 0;
  const cap = state.config?.limits?.attachmentBytes || 25 * 1024 * 1024;
  const id = encodeURIComponent(state.open.id);
  wrap.innerHTML = list.map((a, idx) => {
    const label =
      '<svg class="icon sm" aria-hidden="true"><use href="#i-clip"/></svg>' +
      `<span class="name">${escapeHtml(a.filename)}</span>` +
      `<span class="size">${formatBytes(a.size)}</span>`;
    // Content is streamed from the API rather than inlined, so a 25 MB file
    // costs nothing until it is actually asked for.
    if (a.stored) {
      return `<a class="attachment" href="/api/messages/${id}/attachments/${idx}" download="${escapeHtml(a.filename)}">${label}</a>`;
    }
    return `<span class="attachment dud" title="Too large to keep (${formatBytes(cap)} per message)">${label}</span>`;
  }).join("");
}

function hasRemoteImages(html) {
  // "//cdn.example/pixel.gif" inherits the page's scheme and is just as remote
  // as an https: one, so the scheme has to be optional in both patterns.
  return /(?:src|background)\s*=\s*["']?(?:https?:)?\/\//i.test(html) || /url\(\s*["']?(?:https?:)?\/\//i.test(html);
}

/**
 * Makes an email's HTML safe to display: no scripts, no meta refresh, no
 * <base> hijack, inline cid: images resolved from the attachments, links
 * opening in a new tab, and a Content-Security-Policy that blocks remote
 * images (tracking pixels) until the reader asks for them.
 */
function prepareHtml(html, attachments, allowImages, messageId) {
  const inline = new Map();
  attachments.forEach((a, idx) => {
    if (a.contentId && a.stored) {
      inline.set(a.contentId.toLowerCase(), `/api/messages/${encodeURIComponent(messageId)}/attachments/${idx}?inline=1`);
    }
  });

  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");

  if (inline.size) {
    out = out.replace(/(src|background)\s*=\s*(["']?)cid:([^"'\s>]+)\2/gi, (whole, attr, quote, id) => {
      let key = id;
      try { key = decodeURIComponent(id); } catch { /* use it as-is */ }
      const url = inline.get(key.toLowerCase());
      return url ? `${attr}="${url}"` : whole;
    });
  }

  // 'self' covers the inline-image endpoint; remote hosts stay blocked until
  // the reader asks for them, so tracking pixels do not fire on open.
  const csp = `default-src 'none'; img-src 'self' data: blob:${allowImages ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const head =
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<base target="_blank">' +
    "<style>html,body{margin:0}body{padding:18px;font:15px/1.6 -apple-system,system-ui,'Segoe UI',Roboto,sans-serif;color:#0e1220;background:#fff;overflow-wrap:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}a{color:#1a56db}</style>";

  // Always wrap. Looking for the message's own <head> with a regex meant a
  // "<head>" inside a comment or an attribute value could place the policy
  // where it does not apply, leaving the document with no CSP at all.
  return `<!doctype html><html><head>${head}</head><body>${out}</body></html>`;
}

let frameObserver = null;

function renderBody() {
  const msg = state.open;
  const frame = $("msg-frame");
  const text = $("msg-text");
  const useHtml = state.showHtml && !!msg.htmlBody;

  $("btn-html").setAttribute("aria-pressed", String(useHtml));
  $("btn-text").setAttribute("aria-pressed", String(!useHtml));
  moveSegHighlight();
  $("btn-images").querySelector("span").textContent = state.imagesAllowed ? "Hide images" : "Load images";
  $("btn-images").setAttribute("aria-pressed", String(state.imagesAllowed));
  $("msg-body").classList.toggle("plain", !useHtml);
  frame.hidden = !useHtml;
  text.hidden = useHtml;

  if (useHtml) {
    // Hold the height the frame already has while the new document loads, so
    // toggling images does not collapse the reader and bounce the page.
    const held = frame.getBoundingClientRect().height;
    if (held > 0) frame.style.height = `${held}px`;
    frame.onload = () => fitFrame(frame);
    frame.srcdoc = prepareHtml(msg.htmlBody, msg.attachments || [], state.imagesAllowed, msg.id);
  } else {
    frameObserver?.disconnect();
    frame.srcdoc = "";
    text.innerHTML = linkify(msg.textBody || (msg.htmlBody ? "(no plain-text version)" : "(empty message)"));
  }
}

/** The star control in the open message, from state.open. */
function paintStar() {
  const msg = state.open;
  if (!msg) return;
  const star = $("btn-star");
  star.setAttribute("aria-pressed", String(!!msg.starred));
  star.querySelector("span").textContent = msg.starred ? "Starred" : "Star";
  star.classList.toggle("accent", !!msg.starred);
}

/** Opens an image from the message at full size, dismissed by click or Esc. */
function zoomImage(src) {
  // Second line of defence: never pull a remote URL into the top-level document
  // while the reader has remote images switched off.
  if (!state.imagesAllowed && !/^(\/|data:|blob:)/i.test(src) && !src.startsWith(location.origin)) return;
  const layer = document.createElement("div");
  layer.className = "zoom-layer";
  layer.innerHTML = `<img alt="" src="${escapeHtml(src)}">`;
  const close = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  layer.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(layer);
}

// Size the frame to its content so the pane scrolls as one piece, and keep it
// sized as images load. Possible because the frame is same-origin.
function fitFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    // Same-origin, so images inside the mail can be made click-to-zoom.
    // Only images that actually loaded: a blocked remote image is a placeholder,
    // and zooming one would fetch it from the top-level document, which has no
    // per-message policy — the click would fire the tracking pixel the reader
    // asked to block.
    for (const img of doc.images) {
      if (!img.naturalWidth) continue;
      img.style.cursor = "zoom-in";
      img.addEventListener("click", (e) => { e.preventDefault(); zoomImage(img.src); });
    }
    const fit = () => {
      const height = Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0);
      frame.style.height = `${Math.min(Math.max(height + 2, 180), 30000)}px`;
    };
    fit();
    frameObserver?.disconnect();
    frameObserver = new ResizeObserver(fit);
    frameObserver.observe(doc.documentElement);
  } catch { /* the fallback height stands */ }
}

function closeMessage({ fromHistory = false } = {}) {
  if (!state.open) return;
  state.open = null;
  frameObserver?.disconnect();
  $("msg-frame").srcdoc = "";
  document.body.classList.remove("reading");
  renderFeed();
  // Let the sheet finish sliding out before the content disappears.
  setTimeout(() => { if (!state.open) renderViewer(); }, isDesktop() ? 0 : 260);
  if (!fromHistory && history.state?.viewer) history.back();
}

async function deleteOpen() {
  if (state.open) deleteMessage(state.open.id);
}

async function deleteMessage(id) {
  // The message need not be in the loaded window: one opened from a push
  // notification, or from a link, used to hit an early return and do nothing.
  const list = visibleMessages();
  const index = list.findIndex((m) => m.id === id);
  const next = index >= 0 ? list[index + 1] || list[index - 1] : null;
  // Slide the row out before the list is rebuilt without it.
  const row = $("feed").querySelector(`.mail[data-id="${CSS.escape(id)}"]`);
  row?.classList.add("leaving");
  try {
    await send("DELETE", `/api/messages/${encodeURIComponent(id)}`);
  } catch (err) {
    row?.classList.remove("leaving");   // it is still here; stop it looking gone
    toast(err.message, "i-warn");
    return;
  }
  state.messages = state.messages.filter((m) => m.id !== id);
  if (state.open?.id === id) {
    closeMessage();
    if (next && isDesktop()) openMessage(next.id);
  }
  toast("Message deleted", "i-trash", { action: "Undo", onAction: () => restore([id]) });
  refresh().catch(() => {});
}

/** Brings trashed messages back; the toast's Undo button lands here. */
async function restore(ids) {
  try {
    // The server takes 200 ids per call and silently drops the rest, so a big
    // delete has to be undone in the same slices it was made in.
    const restored = await sendInSlices("POST", "/api/messages/restore", ids);
    toast(restored === 1 ? "Message restored" : `Restored ${plural(restored, "message")}`, "i-undo");
  } catch (err) {
    toast(err.message, "i-warn");
  }
  refresh().catch(() => {});
}

/** Manual refresh from the button or the R key; the icon spins while it runs. */
async function manualRefresh() {
  const button = $("btn-refresh");
  button.classList.add("spinning");
  clearTimeout(state.pollTimer);
  try {
    await poll();
  } finally {
    setTimeout(() => button.classList.remove("spinning"), 400);
  }
}

async function markUnread() {
  const msg = state.open;
  if (!msg) return;
  try {
    await send("PATCH", `/api/messages/${encodeURIComponent(msg.id)}`, { read: false });
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  const listed = state.messages.find((m) => m.id === msg.id);
  if (listed) listed.read = false;
  bumpUnread(msg.address, +1);
  closeMessage();
  renderRail();
  toast("Marked unread", "i-unread");
}

async function copyCode() {
  const code = state.open?.code;
  if (!code) return;
  toast((await copyText(code)) ? `Copied ${code}` : "Couldn't copy — select it by hand", "i-key");
}

/* ------------------------------------------------------- views + starring */

function setView(view) {
  if (state.view === view) return;
  // Nothing in the Leaks view is selectable, so selection mode cannot follow us there.
  if (view === "leaks" && state.selecting) setSelecting(false);
  state.view = view;
  state.windowSize = PAGE_SIZE;
  renderViewChips();
  refresh().catch((err) => toast(err.message, "i-warn"));
}

/** Stars or unstars one message, updating the row before the server replies. */
async function toggleStar(id, button) {
  const listed = state.messages.find((m) => m.id === id);
  const next = !(listed?.starred ?? state.open?.starred);

  if (button) {
    button.classList.toggle("on", next);
    button.setAttribute("aria-pressed", String(next));
    if (next) {
      button.classList.remove("just-starred");
      void button.offsetWidth;      // restart the pop even on a repeat star
      button.classList.add("just-starred");
    }
  }

  try {
    await send("PATCH", `/api/messages/${encodeURIComponent(id)}`, { starred: next });
  } catch (err) {
    toast(err.message, "i-warn");
    button?.classList.toggle("on", !next);
    return;
  }
  if (listed) listed.starred = next;
  if (state.open?.id === id) {
    state.open.starred = next;
    paintStar();                   // not renderViewer: reloading the body would jump the page
  }
  // The starred view drops the row as soon as it is unstarred.
  if (state.view === "starred" && !next) refresh().catch(() => {});
  else { state.feedSig = ""; renderFeed(); }
  refreshRailSoon();
}

let railTimer = null;
function refreshRailSoon() {
  clearTimeout(railTimer);
  railTimer = setTimeout(() => loadAddresses().catch(() => {}), 400);
}

async function loadAddresses() {
  const data = await api("/api/addresses");
  applyRail(data.addresses);
}

/* ---------------------------------------------------------- bulk select */

function setSelecting(on) {
  state.selecting = on;
  state.picked.clear();
  document.body.classList.toggle("selecting", on);
  $("select-bar").hidden = !on;
  $("btn-select").setAttribute("aria-pressed", String(on));
  renderSelection();
  state.feedSig = "";
  renderFeed();
}

/**
 * The messages selection acts on. The Leaks view paints address cards rather
 * than message rows, so nothing there is selectable — without this, Select all
 * would pick the last loaded messages and Delete would remove mail the view
 * never showed.
 */
function selectableMessages() {
  return state.view === "leaks" ? [] : visibleMessages();
}

function renderSelection() {
  const n = state.picked.size;
  const visible = selectableMessages().length;
  $("select-count").textContent = n ? `${n} selected` : "Tap messages to select";
  for (const button of $("select-bar").querySelectorAll(".btn")) {
    if (button.id !== "sel-all") button.disabled = n === 0;
  }
  $("sel-all").textContent = visible && n === visible ? "None" : "All";
  $("sel-all").disabled = visible === 0;
}

/** Selects every visible message, or clears the selection when all are picked. */
function pickAll() {
  const ids = selectableMessages().map((m) => m.id);
  const all = ids.length > 0 && ids.every((id) => state.picked.has(id));
  state.picked.clear();
  if (!all) for (const id of ids) state.picked.add(id);
  for (const row of $("feed").querySelectorAll(".mail")) {
    row.classList.toggle("picked", state.picked.has(row.dataset.id));
  }
  renderSelection();
}

function togglePick(id) {
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  document.querySelector(`.mail[data-id="${CSS.escape(id)}"]`)?.classList.toggle("picked", state.picked.has(id));
  renderSelection();
}

/** The server takes at most 200 ids per call. */
async function sendInSlices(method, path, ids, extra = {}) {
  let affected = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const result = await send(method, path, { ids: ids.slice(i, i + 200), ...extra });
    affected += result?.restored ?? result?.updated ?? result?.deleted ?? 0;
  }
  return affected;
}

async function bulk(action) {
  const ids = [...state.picked];
  if (!ids.length || state.view === "leaks") return;
  const count = plural(ids.length, "message");
  try {
    if (action === "delete") {
      await sendInSlices("DELETE", "/api/messages", ids);
      toast(`Deleted ${count}`, "i-trash", { action: "Undo", onAction: () => restore(ids) });
    } else if (action === "read") {
      await sendInSlices("PATCH", "/api/messages", ids, { read: true });
      toast(`Marked ${count} read`, "i-check-all");
    } else if (action === "unread") {
      await sendInSlices("PATCH", "/api/messages", ids, { read: false });
      toast(`Marked ${count} unread`, "i-unread");
    } else if (action === "unstar") {
      await sendInSlices("PATCH", "/api/messages", ids, { starred: false });
      toast(`Unstarred ${count}`, "i-star");
    } else {
      await sendInSlices("PATCH", "/api/messages", ids, { starred: true });
      toast(`Starred ${count}`, "i-star");
    }
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  setSelecting(false);
  refresh().catch(() => {});
}

/* --------------------------------------------------------------- labels */

let renaming = null;

function openLabelDialog(address) {
  renaming = address;
  const entry = state.addresses.find((a) => a.address === address);
  $("label-target").textContent = address;
  $("label-input").value = entry?.label ?? "";
  retireActionToast();
  $("label-dialog").showModal();
  $("label-input").focus();
  $("label-input").select();
}

async function saveLabel() {
  if (!renaming) return;
  const label = $("label-input").value.trim();
  const address = renaming;
  renaming = null;
  try {
    await send("PUT", `/api/addresses/${encodeURIComponent(address)}/label`, { label });
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  state.railSig = "";
  await loadAddresses().catch(() => {});
  toast(label ? `Named “${label}”` : "Name removed", "i-tag");
}

/* -------------------------------------------------------- address builder */

const ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "cosmic", "crisp", "dusty", "eager", "fuzzy", "gentle", "golden", "happy",
  "humble", "jolly", "keen", "lively", "lucky", "mellow", "merry", "misty", "nimble", "noble", "olive", "plain",
  "polite", "proud", "quick", "quiet", "rapid", "rosy", "royal", "rusty", "silent", "silver", "sleepy", "smart",
  "snowy", "solid", "sunny", "swift", "tidy", "vivid", "warm", "wild", "witty", "zesty", "bold", "coral",
];
const NOUNS = [
  "otter", "falcon", "maple", "comet", "harbor", "lantern", "meadow", "pebble", "river", "saddle", "willow", "badger",
  "beacon", "canyon", "cedar", "dune", "ember", "fjord", "glacier", "heron", "island", "jaguar", "kestrel", "lagoon",
  "marble", "nectar", "orchid", "panda", "quartz", "raven", "sparrow", "tundra", "violet", "walnut", "zephyr", "acorn",
  "bison", "cobalt", "delta", "echo", "fern", "garnet", "hazel", "iris", "juniper", "koala", "moss", "summit",
];

function generateAddress() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(10 + Math.random() * 90)}`;
}

function fullAddress() {
  return state.mailDomain ? `${state.address}@${state.mailDomain}` : "";
}

/* ---- making an inbox ---------------------------------------------------- */

let pendingLife = "permanent";

/* One line each: the sheet's action bar is tight on a small phone, and a hint
   that wraps to three lines pushes Create off the screen. */
const LIFE_HINTS = {
  permanent: "Never expires. Delete it yourself.",
  "24h": "Stops accepting mail after a day.",
  "7d": "Stops accepting mail after a week.",
};

/** Opens the sheet with a fresh candidate address. Also the phone's inbox menu. */
function openNewInbox() {
  rerollCandidate();
  setPendingLife(pendingLife);
  retireActionToast();
  $("new-inbox").showModal();
}

function closeNewInbox() { $("new-inbox").close(); }

/* The phone's inbox menu. Separate from creation: picking an inbox has no use
   for a lifetime choice and a Create button, and on a short phone they cost
   the room the list needs. No mail-domain guard either -- switching inbox and
   copying the current address work without one; only creating needs it. */
function openInboxPicker() {
  $("sheet-addr-text").textContent = fullAddress();
  retireActionToast();
  $("btn-inboxes").setAttribute("aria-expanded", "true");
  $("inboxes").showModal();
  $("inboxes-panel").querySelector(".drawer-scroll").scrollTop = 0;
}

function closeInboxPicker() {
  $("inboxes").close();
  $("btn-inboxes").setAttribute("aria-expanded", "false");
}

function rerollCandidate() {
  state.candidate = state.mailDomain ? generateAddress() : "";
  $("new-addr-text").textContent = state.candidate ? `${state.candidate}@${state.mailDomain}` : "Add your mail domain in Settings";
  $("new-inbox-create").disabled = !state.candidate;
  $("new-addr-reroll").disabled = !state.candidate;
}

function setPendingLife(life) {
  if (!(life in ROLL_MODES)) return;
  pendingLife = life;
  for (const button of $("life-seg").querySelectorAll("[data-life]")) {
    button.setAttribute("aria-pressed", String(button.dataset.life === life));
  }
  $("life-hint").textContent = LIFE_HINTS[life];
  moveSegHighlight($("life-seg"));
}

/**
 * Creates the inbox for real.
 *
 * Every lifetime writes a row, permanent included. It used to skip the request
 * entirely for permanent — ROLL_MODES.permanent was null — so a "forever" inbox
 * existed only in this browser's localStorage. The server had never heard of
 * it, GET /api/addresses could not return it, and it never appeared in the
 * list. That is the whole of what "New Inbox does nothing" was.
 */
async function createInbox() {
  if (!state.mailDomain) { closeNewInbox(); toast("Add your mail domain in Settings first", "i-warn"); openSettings(); return; }
  const address = `${state.candidate}@${state.mailDomain}`;
  const button = $("new-inbox-create");
  button.disabled = true;
  try {
    await send("PUT", `/api/addresses/${encodeURIComponent(address)}`, ROLL_MODES[pendingLife]);
  } catch (err) {
    button.disabled = false;
    toast(`Could not create it: ${err.message}`, "i-warn");
    return;
  }
  button.disabled = false;
  state.address = state.candidate;
  store.set(PREFS.address, state.address);
  renderAddressCard();
  closeNewInbox();
  const copied = await copyText(address);
  toast(copied ? `${address} copied` : `${address} is ready`, copied ? "i-copy" : "i-plus");
  await refresh().catch(() => {});
  state.filter = address;              // show it straight away in the list
  renderRail();
  renderListHead();
}

/** Beside the sender: what Cloudflare's SPF, DKIM and DMARC checks said. */
function renderAuthBadge(msg) {
  const badge = $("msg-auth");
  const auth = msg.auth;
  const verdicts = auth ? Object.values(auth) : [];
  let cls, text, title;
  if (!auth) {
    cls = "none"; text = "Unverified"; title = "This message carried no authentication results.";
  } else if (verdicts.includes("fail") || auth.dmarc === "fail") {
    cls = "bad"; text = "Failed authentication";
    title = `The sender could not be verified: ${Object.entries(auth).map(([k, v]) => `${k} ${v}`).join(", ")}. Treat links and requests in it with care.`;
  } else if (auth.dmarc === "pass" || (auth.dkim === "pass" && auth.spf === "pass")) {
    cls = "ok"; text = "Verified sender";
    title = `Authenticated as ${domainOf(msg.fromAddress) || "the sending domain"}: ${Object.entries(auth).map(([k, v]) => `${k} ${v}`).join(", ")}.`;
  } else {
    cls = "none"; text = "Unverified";
    title = `Checks were inconclusive: ${Object.entries(auth).map(([k, v]) => `${k} ${v}`).join(", ")}.`;
  }
  badge.className = `auth ${cls}`;
  badge.querySelector("span").textContent = text;
  badge.title = title;
  badge.hidden = false;
}

function renderUnsubChip(msg) {
  const chip = $("btn-unsub");
  chip.hidden = !msg.unsubscribe;
  chip.disabled = false;
  chip.querySelector("span").textContent = "Unsubscribe";
  chip.title = msg.unsubscribe?.oneClick
    ? "The sender supports one-click unsubscribe; this inbox will send the request for you"
    : "Opens the sender's unsubscribe link";
}

/** Asks the Worker to unsubscribe, or opens what the sender offered. */
async function unsubscribeOpen() {
  const msg = state.open;
  if (!msg?.unsubscribe) return;
  const chip = $("btn-unsub");
  chip.disabled = true;
  let result;
  try {
    result = await send("POST", `/api/messages/${encodeURIComponent(msg.id)}/unsubscribe`);
  } catch (err) {
    chip.disabled = false;
    // The sender's service failed; fall back to opening the link if there is one.
    if (msg.unsubscribe.https) { window.open(msg.unsubscribe.https, "_blank", "noopener"); toast("Their unsubscribe service failed; opened the link instead", "i-warn"); }
    else toast(err.message, "i-warn");
    return;
  }
  if (result.method === "post") {
    chip.querySelector("span").textContent = "Unsubscribed";
    toast(`Unsubscribed from ${senderLabel(msg)}`, "i-tick");
    return;
  }
  chip.disabled = false;
  if (result.method === "open") { window.open(result.url, "_blank", "noopener"); toast("Opened the sender's unsubscribe page", "i-unsub"); }
  else if (result.method === "mailto") { location.href = result.url; toast("Opened an unsubscribe email to send", "i-unsub"); }
}

/**
 * Links whose visible text, characters or domain are trying to look like
 * something else. `references` are the domains a link might impersonate:
 * the service the address was given to, and whoever the message claims
 * to be from.
 */
function analyseLinks(html, references) {
  if (!html) return [];
  const flags = new Set();
  let doc;
  try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return []; }
  const refs = [...new Set(references.filter(Boolean))];
  for (const a of doc.querySelectorAll("a[href]")) {
    let href;
    try { href = new URL(a.getAttribute("href"), "https://x.invalid/"); } catch { continue; }
    if (!/^https?:$/.test(href.protocol) || href.hostname === "x.invalid") continue;
    const host = href.hostname.toLowerCase();
    const text = (a.textContent || "").trim();
    const shown = text.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#:]|$)/i);
    if (shown && !relatedDomain(shown[1].toLowerCase(), host)) flags.add(`A link reads ${shown[1].toLowerCase()} but goes to ${host}`);
    if (host.split(".").some((l) => l.startsWith("xn--")) || /[^\x00-\x7f]/.test(host)) flags.add(`${host} uses look-alike characters`);
    for (const ref of refs) {
      if (relatedDomain(host, ref)) continue;
      if (impersonates(registrableLabel(host), registrableLabel(ref))) flags.add(`${host} looks like ${ref} but is not`);
    }
    if (flags.size >= 3) break;
  }
  return [...flags].slice(0, 3);
}

/** "paypa1-secure" vs "paypal": a token that is the real name, one typo off, or wrapped in extras. */
function impersonates(label, refLabel) {
  if (!label || !refLabel || label === refLabel) return false;
  const tokens = [label, ...label.split(/[-_]/)].filter((t) => t.length >= 4);
  return tokens.some((t) => t !== refLabel && (t.includes(refLabel) || editDistance(t, refLabel) <= (refLabel.length >= 8 ? 2 : 1)));
}

function registrableLabel(host) {
  if (!host) return null;
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  // "co.uk"-style suffixes: take the label before the last two when the second-last is short.
  const label = parts[parts.length - 2].length <= 3 && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  return label.length >= 4 ? label : null;   // very short labels give too many false matches
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** A strip when the message's links look deceptive. */
function renderWarnStrip(msg) {
  const strip = $("msg-warn");
  const entry = state.addresses.find((a) => a.address === msg.address);
  const flags = analyseLinks(msg.htmlBody, [entry?.ownerDomain, domainOf(msg.fromAddress)]);
  strip.hidden = flags.length === 0;
  if (!flags.length) return;
  $("msg-warn-text").textContent = `Links in this message look suspicious. ${flags.join(". ")}.`;
  $("msg-warn-plain").hidden = !msg.textBody;
}

/** Under the sender: a warning when this message is from someone other than the address's owner. */
function renderLeakStrip(msg) {
  const strip = $("msg-leak");
  const entry = state.addresses.find((a) => a.address === msg.address);
  const from = domainOf(msg.fromAddress);
  const leak = entry?.ownerDomain && from && !relatedDomain(from, entry.ownerDomain);
  strip.hidden = !leak;
  if (!leak) return;
  $("msg-leak-text").textContent = `Sent by ${from}, but ${msg.address.split("@")[0]} was given to ${entry.ownerDomain}. It may have been shared or sold.`;
  const button = $("msg-leak-block");
  button.textContent = entry.mode === "blocked" ? "Blocked" : "Block address";
  button.disabled = entry.mode === "blocked";
  button.onclick = () => toggleBlock(msg.address);
}

async function copyAddress() {
  if (!state.mailDomain) {
    toast("Add your mail domain in Settings first", "i-warn");
    openSettings();
    return;
  }
  const ok = await copyText(fullAddress());
  if (!ok) {
    toast("Couldn't copy — select it by hand", "i-warn");
    return;
  }
  // The copy glyph flips to a tick for a moment.
  const card = $("btn-copy");
  card.classList.add("copied");
  clearTimeout(copyAddress._t);
  copyAddress._t = setTimeout(() => card.classList.remove("copied"), 1400);
  toast(`Copied ${fullAddress()}`, "i-tick");
}

/* --------------------------------------------------------------- settings */

/**
 * Retires a toast that is offering an action, because a modal dialog is about
 * to make it inert. It stays on screen looking pressable and silently is not:
 * delete a message, open Settings, and the only route back from that delete
 * is gone while still visible.
 */
function retireActionToast() {
  if ($("toast").querySelector(".toast-act")) hideToast();
}

function openSettings() {
  const cfg = state.config || {};
  const domainFromEnv = cfg.domainSource === "env";
  $("set-domain").value = domainFromEnv || cfg.domainSource === "settings" ? cfg.mailDomain || "" : "";
  $("set-domain").placeholder = cfg.domainSource === "observed" ? cfg.mailDomain : "example.com";
  $("set-domain").disabled = domainFromEnv;
  $("domain-form").querySelector("button").disabled = domainFromEnv;
  $("domain-note").hidden = !domainFromEnv;
  $("domain-note").textContent = "Set by the MAIL_DOMAIN variable — change it in wrangler.jsonc or the Cloudflare dashboard.";

  const passwordFromEnv = cfg.passwordSource === "env";
  $("password-form").hidden = passwordFromEnv;
  $("pw-note").textContent = passwordFromEnv
    ? "The password is the AUTH_PASSWORD secret; change it in the Cloudflare dashboard."
    : "Changing it signs out every other device.";

  renderLimits();
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

function closeSettings() {
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

async function saveLimits(event) {
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

function setAutoRefresh(on) {
  state.autoRefresh = on;
  store.set(PREFS.autoRefresh, on ? "on" : "off");
  $("set-autorefresh").checked = on;
  $("domain-pill").classList.toggle("paused", !on);
  clearTimeout(state.pollTimer);
  if (on) poll();
}

function setAlwaysImages(on) {
  state.alwaysImages = on;
  store.set(PREFS.images, on ? "on" : "off");
  $("set-images").checked = on;
}

async function saveDomain(event) {
  event.preventDefault();
  try {
    state.config = await send("PUT", "/api/settings", { mailDomain: $("set-domain").value.trim() });
    renderDomain();
    toast(state.mailDomain ? `Domain set to ${state.mailDomain}` : "Domain cleared", "i-globe");
  } catch (err) {
    toast(err.message, "i-warn");
  }
}

async function changePassword(event) {
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

async function toggleNotifications(on) {
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

function setSound(on) {
  state.sound = on;
  store.set("sound", on ? "on" : "off");
  $("btn-sound").querySelector("use").setAttribute("href", on ? "#i-sound" : "#i-sound-off");
  $("btn-sound").setAttribute("aria-pressed", String(on));
  $("set-sound").checked = on;
}

async function deleteAll() {
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

async function markAllRead() {
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

async function logout() {
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
function wireDrawerDrag(panelId = "drawer-panel", gripId = "drawer-grip", dismiss = closeSettings) {
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

/* --------------------------------------------------------- wait for code */

function startWaiting() {
  if (!state.mailDomain) { toast("Add your mail domain in Settings first", "i-warn"); openSettings(); return; }
  const address = fullAddress();
  state.waiting = { address, since: Date.now() };
  $("wait-address").textContent = address;
  $("wait-stage").dataset.state = "waiting";
  $("wait-title").textContent = "Send yourself the code now";
  $("wait-code").hidden = true; $("wait-subject").hidden = true;
  $("wait-copy").hidden = true; $("wait-open").hidden = true;
  $("wait-hint").hidden = false;
  $("wait").hidden = false;
  document.body.classList.add("waiting");
  // Any mail already sitting in the list is old news; only what lands from now counts.
  if (!state.live) { clearTimeout(state.pollTimer); schedulePoll(); }
}

function stopWaiting() {
  if (!state.waiting) return;
  state.waiting = null;
  $("wait").hidden = true;
  document.body.classList.remove("waiting");
  schedulePoll();
}

/** The awaited message landed: show the code big, copy it, chime. */
async function codeArrived(m) {
  const waiting = state.waiting;
  if (!waiting) return;
  state.waiting = { ...waiting, since: Infinity };   // one message, then stop watching
  const stage = $("wait-stage");
  stage.dataset.state = "arrived";
  if (m.code) {
    $("wait-title").textContent = `Code from ${senderLabel(m)}`;
    $("wait-code").hidden = false;
    renderRoll($("wait-code"), m.code);
    $("wait-copy").hidden = false;
    $("wait-copy").onclick = () => copyText(m.code).then((done) => toast(done ? "Code copied" : "Could not copy", done ? "i-tick" : "i-warn"));
    const copied = await copyText(m.code);
    $("wait-hint").textContent = copied ? "Copied to your clipboard." : "Tap Copy code to put it on your clipboard.";
  } else {
    $("wait-title").textContent = `Mail from ${senderLabel(m)}`;
    $("wait-subject").textContent = m.subject || "(no subject)";
    $("wait-subject").hidden = false;
    $("wait-hint").textContent = "No code was spotted in it.";
  }
  $("wait-open").hidden = false;
  $("wait-open").onclick = () => { stopWaiting(); openMessage(m.id); };
  if (state.sound) chime();
}

/* ------------------------------------------------------------------- push */

let swRegistration = null;

/** Registers the service worker that shows pushes; harmless where unsupported. */
let swListening = false;

async function registerServiceWorker() {
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
async function handleWorkerMessage(data) {
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

async function togglePush(on) {
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
function themePref() {
  const saved = store.get(PREFS.theme);
  return saved === "light" || saved === "dark" ? saved : "system";
}

const lightScheme = matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
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
  const seg = $("theme-seg");
  const pref = themePref();
  for (const button of seg.querySelectorAll(".seg-btn")) {
    button.setAttribute("aria-pressed", String(button.dataset.theme === pref));
  }
  if ($("settings").open) moveSegHighlight(seg);
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
function toggleTheme(origin) {
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

/* --------------------------------------------------------------- keyboard */

function step(direction) {
  const list = visibleMessages();
  if (!list.length) return;
  const index = list.findIndex((m) => m.id === state.open?.id);
  const next = index < 0
    ? (direction > 0 ? 0 : list.length - 1)
    : Math.min(list.length - 1, Math.max(0, index + direction));
  if (list[next].id !== state.open?.id) openMessage(list[next].id);
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$("mail-menu").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeMailMenu(); }
    return;
  }
  const target = e.target;
  const typing = target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (e.key === "Escape") {
    if (state.waiting) { stopWaiting(); return; }
    if ($("settings").open) return;  // the dialog closes itself
    if (typing && target.id === "search") {
      if (target.value) { target.value = ""; setQuery(""); } else target.blur();
      if (!isDesktop()) toggleSearch();
      return;
    }
    if (state.open) closeMessage();
    return;
  }
  if (typing || $("settings").open) return;

  switch (e.key) {
    case "/": e.preventDefault(); focusSearch(); break;
    case "j": case "ArrowDown": e.preventDefault(); step(+1); break;
    case "k": case "ArrowUp": e.preventDefault(); step(-1); break;
    case "c": copyAddress(); break;
    case "n": openNewInbox(); break;
    case "u": markUnread(); break;
    case "s": if (state.open) toggleStar(state.open.id, null); break;
    case "x": setSelecting(!state.selecting); break;
    case "r": manualRefresh(); toast("Refreshed", "i-refresh"); break;
    case "t": toggleTheme(); break;
    case ",": e.preventDefault(); openSettings(); break;
    case "#": case "Delete": deleteOpen(); break;
    case "?": openSettings(); break;
  }
});

/* ----------------------------------------------------------------- wiring */

/* Right-click menu on a message, shaped like shadcn's context menu:
   icon + label + shortcut, a separator, then a destructive Delete. */
let menuId = null;

function closeMailMenu() {
  const menu = $("mail-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  menuId = null;
}

function placeMailMenu(clientX, clientY) {
  const menu = $("mail-menu");
  menu.hidden = false;
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(pad, clientX), innerWidth - rect.width - pad);
  const top = Math.min(Math.max(pad, clientY), innerHeight - rect.height - pad);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${clientX - left}px ${clientY - top}px`;
}

function openMailMenu(event, id) {
  const msg = state.messages.find((m) => m.id === id);
  if (!msg) return;
  // The toast now sits in the top layer, so it would cover a menu the reader
  // deliberately opened. Deliberate beats transient: retire the toast.
  hideToast();
  menuId = id;
  const star = $("menu-star");
  star.querySelector("span").textContent = msg.starred ? "Unstar" : "Star";
  $("menu-unread").querySelector("span").textContent = msg.read ? "Mark unread" : "Mark read";
  placeMailMenu(event.clientX, event.clientY);
  $("mail-menu").querySelector(".menu-item")?.focus();
}

function runMailMenu(act) {
  const id = menuId;
  closeMailMenu();
  if (!id) return;
  if (act === "open") openMessage(id);
  else if (act === "star") toggleStar(id, $("feed").querySelector(`[data-star="${CSS.escape(id)}"]`));
  else if (act === "unread") {
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return;
    const next = !msg.read;
    send("PATCH", `/api/messages/${encodeURIComponent(id)}`, { read: next })
      .then(() => { msg.read = next; if (state.open?.id === id) state.open.read = next; renderFeed(); renderRail(); })
      .catch((err) => toast(err.message, "i-warn"));
  } else if (act === "delete") deleteMessage(id);
}

let pressTimer = 0;
$("feed").addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  const row = e.target.closest(".mail");
  if (!row) return;
  const { clientX, clientY } = e;
  pressTimer = setTimeout(() => openMailMenu({ clientX, clientY }, row.dataset.id), 550);
});
$("feed").addEventListener("pointerup", () => clearTimeout(pressTimer));
$("feed").addEventListener("pointercancel", () => clearTimeout(pressTimer));
$("feed").addEventListener("pointermove", () => clearTimeout(pressTimer));

$("feed").addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".mail");
  if (!row) return;
  e.preventDefault();
  clearTimeout(pressTimer);
  openMailMenu(e, row.dataset.id);
});
$("feed").addEventListener("scroll", closeMailMenu, { passive: true });

$("mail-menu").addEventListener("click", (e) => {
  const item = e.target.closest("[data-act]");
  if (item) runMailMenu(item.dataset.act);
});

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#mail-menu")) closeMailMenu();
}, true);

$("mail-menu").addEventListener("keydown", (e) => {
  const items = [...$("mail-menu").querySelectorAll(".menu-item")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    items[(i + 1) % items.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    items[(i - 1 + items.length) % items.length]?.focus();
  }
});

$("feed").addEventListener("click", (e) => {
  const star = e.target.closest("[data-star]");
  if (star) {
    e.stopPropagation();
    toggleStar(star.dataset.star, star);
    return;
  }
  const code = e.target.closest("[data-code]");
  if (code) {
    copyText(code.dataset.code).then((ok) => toast(ok ? `Copied ${code.dataset.code}` : "Couldn't copy", "i-key"));
    return;
  }
  const row = e.target.closest(".mail");
  if (!row) return;
  if (state.selecting) togglePick(row.dataset.id);
  else openMessage(row.dataset.id);
});

$("feed").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const target = e.target;
  if (target.classList?.contains("tag") || target.classList?.contains("mail")) {
    e.preventDefault();
    target.click();
  }
});

function onRailClick(e) {
  const rename = e.target.closest("[data-rename]");
  if (rename) { openLabelDialog(rename.dataset.rename); return; }
  const kill = e.target.closest("[data-kill]");
  if (kill) { deleteInbox(kill.dataset.kill); return; }
  const burn = e.target.closest("[data-burn]");
  if (burn) { toggleBlock(burn.dataset.burn); return; }
  const item = e.target.closest("[data-address]");
  if (!item) return;
  setFilter(item.dataset.address);
  // Picking from the sheet is the whole reason it was open.
  if (e.currentTarget.id === "picker-list") closeInboxPicker();
}
$("rail-list").addEventListener("click", onRailClick);
$("picker-list").addEventListener("click", onRailClick);
$("rail-list").addEventListener("scroll", moveRailHighlight, { passive: true });

$("btn-more").addEventListener("click", loadOlder);
$("btn-read-all").addEventListener("click", markAllRead);
$("btn-wipe").addEventListener("click", () => state.filter && deleteInbox(state.filter));
$("btn-rename").addEventListener("click", () => state.filter && openLabelDialog(state.filter));
$("search").addEventListener("input", (e) => setQuery(e.target.value));
$("search-clear").addEventListener("click", () => { $("search").value = ""; setQuery(""); $("search").focus(); });
$("btn-search").addEventListener("click", toggleSearch);

$("btn-copy").addEventListener("click", copyAddress);
$("btn-roll").addEventListener("click", openNewInbox);
$("btn-new-phone").addEventListener("click", openNewInbox);
$("new-inbox-close").addEventListener("click", closeNewInbox);
$("new-inbox").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeNewInbox(); });
$("new-addr-reroll").addEventListener("click", rerollCandidate);

$("btn-inboxes").addEventListener("click", openInboxPicker);
/* On desktop the rail lists every inbox, so the title is not a control there.
   disabled, not pointer-events: none, so it leaves the tab order too and a
   keyboard user never lands on a button that does nothing. */
function syncInboxSwitch() { $("btn-inboxes").disabled = isDesktop(); }
wideQuery.addEventListener("change", () => {
  syncInboxSwitch();
  // Widening to desktop moves the rows into the rail, which would leave an
  // open picker showing an empty list beside a rail that has them.
  if ($("inboxes").open && isDesktop()) closeInboxPicker();
  // The rows changed container; the signature cache would otherwise skip the
  // re-render and leave the new side empty.
  state.railSig = "";
  renderRail();
});
syncInboxSwitch();
$("inboxes-close").addEventListener("click", closeInboxPicker);
$("inboxes").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeInboxPicker(); });
// Esc and the swipe-to-dismiss gesture close the dialog without going through
// closeInboxPicker, so the switch's state is reset from the dialog itself.
$("inboxes").addEventListener("close", () => $("btn-inboxes").setAttribute("aria-expanded", "false"));
$("inboxes-new").addEventListener("click", () => { closeInboxPicker(); openNewInbox(); });
$("sheet-copy").addEventListener("click", copyAddress);
$("sheet-open").addEventListener("click", () => { closeInboxPicker(); setFilter(fullAddress()); });
$("sheet-wait").addEventListener("click", () => { closeInboxPicker(); startWaiting(); });
$("new-inbox-create").addEventListener("click", createInbox);
$("life-seg").addEventListener("click", (e) => {
  const button = e.target.closest("[data-life]");
  if (button) setPendingLife(button.dataset.life);
});
$("btn-mine").addEventListener("click", () => {
  if (!state.mailDomain) { copyAddress(); return; }
  setFilter(fullAddress());
});
$("link-domain").addEventListener("click", openSettings);

$("btn-back").addEventListener("click", () => closeMessage());
$("btn-close").addEventListener("click", () => closeMessage());
$("btn-delete").addEventListener("click", deleteOpen);
$("btn-unread").addEventListener("click", markUnread);
$("btn-code").addEventListener("click", copyCode);
$("btn-html").addEventListener("click", () => { state.showHtml = true; renderBody(); });
$("btn-text").addEventListener("click", () => { state.showHtml = false; renderBody(); });
$("btn-images").addEventListener("click", () => { state.imagesAllowed = !state.imagesAllowed; renderBody(); });
$("msg-to").addEventListener("click", () => state.open && setFilter(state.open.address));

for (const chip of document.querySelectorAll("[data-view]")) {
  chip.addEventListener("click", () => setView(chip.dataset.view));
}

$("btn-select").addEventListener("click", () => setSelecting(!state.selecting));
$("sel-cancel").addEventListener("click", () => setSelecting(false));
$("sel-read").addEventListener("click", () => bulk("read"));
$("sel-star").addEventListener("click", () => bulk("star"));
$("sel-delete").addEventListener("click", () => bulk("delete"));
$("sel-all").addEventListener("click", pickAll);
$("sel-unread").addEventListener("click", () => bulk("unread"));
$("sel-unstar").addEventListener("click", () => bulk("unstar"));
$("btn-refresh").addEventListener("click", manualRefresh);
$("btn-unsub").addEventListener("click", unsubscribeOpen);
$("btn-wait").addEventListener("click", startWaiting);
$("wait-close").addEventListener("click", stopWaiting);
$("wait").addEventListener("click", (e) => { if (e.target === e.currentTarget) stopWaiting(); });
$("set-push").addEventListener("change", (e) => togglePush(e.target.checked));
$("msg-warn-plain").addEventListener("click", () => { state.showHtml = false; renderBody(); });
$("btn-burn").addEventListener("click", () => { if (state.filter) toggleBlock(state.filter); });
// Leak cards live inside the feed; their buttons route here.
$("feed").addEventListener("click", (e) => {
  const burn = e.target.closest("[data-burn]");
  if (burn) { e.stopPropagation(); toggleBlock(burn.dataset.burn); return; }
  const owner = e.target.closest("[data-owner]");
  if (owner) { e.stopPropagation(); setOwner(owner.dataset.owner); return; }
  const show = e.target.closest(".leak [data-address]");
  if (show) { e.stopPropagation(); setView("all"); setFilter(show.dataset.address); }
}, true);

$("btn-star").addEventListener("click", () => state.open && toggleStar(state.open.id, null));

$("label-form").addEventListener("submit", (e) => {
  // A dialog form closes itself; only the Save button should write anything.
  if (e.submitter?.value === "save") saveLabel();
  else renaming = null;
});

$("limits-form").addEventListener("submit", saveLimits);
$("set-autorefresh").addEventListener("change", (e) => setAutoRefresh(e.target.checked));
$("set-images").addEventListener("change", (e) => setAlwaysImages(e.target.checked));

$("btn-sound").addEventListener("click", () => {
  setSound(!state.sound);
  if (state.sound) chime();
  toast(state.sound ? "Sound on" : "Sound off", state.sound ? "i-sound" : "i-sound-off");
});
$("btn-theme").addEventListener("click", (e) => toggleTheme(e.currentTarget));

$("btn-settings").addEventListener("click", openSettings);
$("btn-settings-close").addEventListener("click", closeSettings);
// Clicking the backdrop (that is, the dialog itself rather than the panel) closes it.
$("settings").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSettings(); });
$("domain-form").addEventListener("submit", saveDomain);
$("password-form").addEventListener("submit", changePassword);
$("set-sound").addEventListener("change", (e) => setSound(e.target.checked));
$("set-notify").addEventListener("change", (e) => toggleNotifications(e.target.checked));
$("theme-seg").addEventListener("click", (e) => {
  const button = e.target.closest(".seg-btn");
  if (button) applyTheme(button.dataset.theme);
});
$("btn-delete-all").addEventListener("click", deleteAll);
$("btn-logout").addEventListener("click", logout);

window.addEventListener("popstate", () => closeMessage({ fromHistory: true }));
window.addEventListener("resize", () => {
  moveRailHighlight();
  moveSegHighlight();
  if ($("settings").open) moveSegHighlight($("theme-seg"));
  if (state.open && state.showHtml) fitFrame($("msg-frame"));
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearTimeout(state.pollTimer); poll();   // repaint and refresh at once
    if (!liveSocket) { liveFailures = 0; liveRetry = 0; connectLive(); }
  }
});
window.addEventListener("online", () => {
  clearTimeout(state.pollTimer); poll();
  if (!liveSocket) { liveFailures = 0; liveRetry = 0; connectLive(); }
});

/* ------------------------------------------------------------------- boot */

(async function boot() {
  applyTheme(themePref());
  setSound(store.get(PREFS.sound) !== "off");
  state.notify = store.get(PREFS.notify) === "on";
  state.autoRefresh = store.get(PREFS.autoRefresh) !== "off";
  state.alwaysImages = store.get(PREFS.images) === "on";
  $("domain-pill").classList.toggle("paused", !state.autoRefresh);
  state.address = store.get(PREFS.address) || generateAddress();
  store.set(PREFS.address, state.address);
  wireDrawerDrag();
  wireDrawerDrag("new-inbox-panel", "new-inbox-grip", closeNewInbox);
  wireDrawerDrag("inboxes-panel", "inboxes-grip", closeInboxPicker);

  const painted = loadCache();
  if (painted) {
    renderRail();
    renderFeed();
  } else {
    $("feed").innerHTML = skeletonRows();   // something to look at on a cold start
  }
  renderDomain();

  try {
    await loadConfig();
  } catch (err) {
    if (err.message === "Signed out") return;
    console.warn("config unavailable", err);
  }
  await poll();
  connectLive();
  registerServiceWorker().then(() => {
    // Cold-started from a notification: the URL says what to open and copy.
    const params = new URLSearchParams(location.search);
    if (params.get("open")) {
      handleWorkerMessage({ open: params.get("open"), copy: params.get("copy") });
      history.replaceState(null, "", "/");
    }
  });
})();
