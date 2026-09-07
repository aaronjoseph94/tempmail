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
  view: "all",             // all | unread | starred
  selecting: false,
  picked: new Set(),
  alwaysImages: false,
};

/** Preference keys kept per device rather than on the server. */
const PREFS = {
  sound: "sound", notify: "notify", autoRefresh: "auto_refresh",
  images: "always_images", address: "address", theme: "theme",
};

/* ---------------------------------------------------------------- helpers */

// localStorage throws in private mode and when site data is blocked.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* fine without it */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* fine without it */ } },
};

let toastTimer = null;
/** A short notice. With an action it stays longer and carries one button (Undo, say). */
function toast(text, icon = "i-tick", { action = null, onAction = null, duration = null } = {}) {
  const el = $("toast");
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration ?? (action ? 10000 : 2400));
}

function hideToast() {
  const el = $("toast");
  clearTimeout(toastTimer);
  el.classList.add("out");
  setTimeout(() => { el.hidden = true; }, 140);
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

function hueFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function initialsFor(name) {
  const parts = name.trim().split(/[\s.<@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function senderLabel(m) {
  return m.fromName || m.fromAddress || "unknown";
}

function isDesktop() {
  return matchMedia("(min-width: 900px)").matches;
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
  state.hasMore = data.hasMore;
  state.nextCursor = data.nextCursor;
  $("feed").setAttribute("aria-busy", "false");
  renderFeed(arrived);
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
  if (state.notify && document.hidden && "Notification" in window && Notification.permission === "granted") {
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
  state.pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
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
    messages: state.messages.slice(0, PAGE_SIZE),
    addresses: state.addresses,
    mailDomain: state.mailDomain,
  }));
}

function loadCache() {
  try {
    const cache = JSON.parse(store.get(CACHE_KEY) || "null");
    if (!cache || !Array.isArray(cache.messages)) return false;
    state.messages = cache.messages;
    state.addresses = cache.addresses || [];
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
  const sig = JSON.stringify([state.filter, all, state.addresses.map((a) => [a.address, a.count, a.unread])]);
  if (sig !== state.railSig) {
    const hadRows = state.railSig !== "";
    state.railSig = sig;
    const rows = [railRow({ address: "", label: "All mail", count: all.count, unread: all.unread, all: true })];
    for (const a of state.addresses) {
      rows.push(railRow({ address: a.address, label: a.address.split("@")[0], name: a.label, count: a.count, unread: a.unread }));
    }
    // A freshly rolled address has no mail yet but can still be selected.
    if (state.filter && !state.addresses.some((a) => a.address === state.filter)) {
      rows.push(railRow({ address: state.filter, label: state.filter.split("@")[0], count: 0, unread: 0 }));
    }
    if (!state.addresses.length) rows.push('<div class="rail-empty">No mail received yet</div>');
    $("rail-list").innerHTML = rows.join("");
    $("addr-count").textContent = state.addresses.length ? String(state.addresses.length) : "";
    if (hadRows) for (const badge of $("rail-list").querySelectorAll(".badge")) badge.classList.add("bump");
  }
  moveRailHighlight();
  renderViewChips();
  renderListHead();
}

function railRow({ address, label, name, count, unread, all = false }) {
  const active = state.filter === address;
  const tally = unread > 0 ? `<span class="badge">${unread}</span>` : `<span class="count">${count}</span>`;
  const local = escapeHtml(label);
  // A named address shows its name with the raw local part underneath.
  const body = name
    ? `<span class="stack-2"><span class="tag-label">${escapeHtml(name)}</span><span class="sub">${local}</span></span>`
    : `<span class="name">${local}</span>`;
  const tools = all ? "" : `
    <button class="rename" data-rename="${escapeHtml(address)}" aria-label="Name ${escapeHtml(address)}" title="Give this address a name"><svg class="icon sm"><use href="#i-tag"/></svg></button>
    <button class="wipe" data-wipe="${escapeHtml(address)}" aria-label="Delete all mail to ${escapeHtml(address)}" title="Delete all mail to this address"><svg class="icon sm"><use href="#i-trash"/></svg></button>`;
  const icon = all ? '<svg class="icon sm" aria-hidden="true"><use href="#i-inbox"/></svg>' : "";
  return `<div class="rail-row">
    <button class="rail-item${all ? " all" : ""}${active ? " active" : ""}" data-address="${escapeHtml(address)}"${active ? ' aria-current="true"' : ""} title="${escapeHtml(address || "Every address")}">
      ${icon}${body}${tally}
    </button>${tools}</div>`;
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
  $("btn-wipe").hidden = !state.filter || !count;
  $("btn-rename").hidden = !state.filter;
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
  const visible = visibleMessages();
  const sig = JSON.stringify([state.filter, state.query, state.open?.id, state.hasMore, visible.map((m) => [m.id, m.read, m.starred])]);
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
    <span class="avatar" style="--hue:${hueFor((m.fromAddress || from).toLowerCase())}" aria-hidden="true">${escapeHtml(initialsFor(from))}</span>
    <span class="mail-body">
      <span class="mail-top">
        <span class="mail-from">${escapeHtml(from)}</span>
        <span class="mail-time" title="${escapeHtml(formatWhen(m.receivedAt))}">${escapeHtml(timeAgo(m.receivedAt))}</span>
        <button class="star${m.starred ? " on" : ""}" data-star="${escapeHtml(m.id)}" aria-label="${m.starred ? "Unstar" : "Star"} this message" aria-pressed="${!!m.starred}">
          <svg class="icon sm"><use href="#i-star"/></svg>
        </button>
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
  // Keep the newly selected chip in view on a phone.
  $("rail-list").querySelector(".rail-item.active")?.scrollIntoView({
    behavior: reducedMotion.matches ? "auto" : "smooth", block: "nearest", inline: "center",
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

async function openMessage(id) {
  let msg;
  try {
    msg = await api(`/api/messages/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
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
  avatar.style.setProperty("--hue", hueFor((msg.fromAddress || from).toLowerCase()));
  $("msg-from-name").textContent = msg.fromName || msg.fromAddress;
  $("msg-from-addr").textContent = msg.fromName ? `<${msg.fromAddress}>` : "";
  $("msg-to").textContent = msg.address;
  $("msg-date").textContent = formatWhen(msg.receivedAt);

  const retentionDays = state.config?.retentionDays ?? 100;
  const daysLeft = Math.max(0, Math.ceil((msg.receivedAt + retentionDays * 86400000 - Date.now()) / 86400000));
  $("msg-expiry").textContent = `deletes in ${plural(daysLeft, "day")}`;

  const star = $("btn-star");
  star.setAttribute("aria-pressed", String(!!msg.starred));
  star.querySelector("span").textContent = msg.starred ? "Starred" : "Star";
  star.classList.toggle("accent", !!msg.starred);
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
  return /(?:src|background)\s*=\s*["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
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
    "<style>html,body{margin:0}body{padding:18px;font:15px/1.6 -apple-system,system-ui,'Segoe UI',Roboto,sans-serif;color:#15140f;background:#fff;overflow-wrap:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}a{color:#a16207}</style>";

  if (/<head\b[^>]*>/i.test(out)) return out.replace(/<head\b[^>]*>/i, (tag) => tag + head);
  if (/<html\b[^>]*>/i.test(out)) return out.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${head}</head>`);
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
    frame.style.height = "";
    frame.onload = () => fitFrame(frame);
    frame.srcdoc = prepareHtml(msg.htmlBody, msg.attachments || [], state.imagesAllowed, msg.id);
  } else {
    frameObserver?.disconnect();
    frame.srcdoc = "";
    text.innerHTML = linkify(msg.textBody || (msg.htmlBody ? "(no plain-text version)" : "(empty message)"));
  }
}

/** Opens an image from the message at full size, dismissed by click or Esc. */
function zoomImage(src) {
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
    for (const img of doc.images) {
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
  const msg = state.open;
  if (!msg) return;
  const list = visibleMessages();
  const index = list.findIndex((m) => m.id === msg.id);
  const next = list[index + 1] || list[index - 1];
  // Slide the row out before the list is rebuilt without it.
  $("feed").querySelector(`.mail[data-id="${CSS.escape(msg.id)}"]`)?.classList.add("leaving");
  try {
    await send("DELETE", `/api/messages/${encodeURIComponent(msg.id)}`);
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  state.messages = state.messages.filter((m) => m.id !== msg.id);
  closeMessage();
  toast("Message deleted", "i-trash", { action: "Undo", onAction: () => restore([msg.id]) });
  if (next && isDesktop()) openMessage(next.id);
  refresh().catch(() => {});
}

/** Brings trashed messages back; the toast's Undo button lands here. */
async function restore(ids) {
  try {
    await send("POST", "/api/messages/restore", { ids });
    toast(ids.length === 1 ? "Message restored" : `Restored ${plural(ids.length, "message")}`, "i-undo");
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
    renderViewer();
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

function renderSelection() {
  const n = state.picked.size;
  const visible = visibleMessages().length;
  $("select-count").textContent = n ? `${n} selected` : "Tap messages to select";
  for (const button of $("select-bar").querySelectorAll(".btn")) {
    if (button.id !== "sel-all") button.disabled = n === 0;
  }
  $("sel-all").textContent = visible && n === visible ? "None" : "All";
  $("sel-all").disabled = visible === 0;
}

/** Selects every visible message, or clears the selection when all are picked. */
function pickAll() {
  const ids = visibleMessages().map((m) => m.id);
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
  for (let i = 0; i < ids.length; i += 200) {
    await send(method, path, { ids: ids.slice(i, i + 200), ...extra });
  }
}

async function bulk(action) {
  const ids = [...state.picked];
  if (!ids.length) return;
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

function newAddress() {
  state.address = generateAddress();
  store.set(PREFS.address, state.address);
  renderAddressCard();
  const button = $("btn-roll");
  button.classList.toggle("rolling");   // the die turns a half-step each roll
  if (state.mailDomain) copyAddress();   // ready to paste straight into a form
  else toast("New address ready", "i-dice");
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
  renderStorage();

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

async function wipeAddress(address) {
  if (!confirm(`Delete every message sent to ${address}?`)) return;
  try {
    await send("DELETE", `/api/messages?address=${encodeURIComponent(address)}`);
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  if (state.open?.address === address) closeMessage();
  toast(`Wiped ${address}`, "i-trash");
  refresh().catch(() => {});
}

async function markAllRead() {
  const query = state.filter ? `?address=${encodeURIComponent(state.filter)}` : "";
  try {
    await send("POST", `/api/read-all${query}`);
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  for (const m of state.messages) m.read = true;
  for (const a of state.addresses) if (!state.filter || a.address === state.filter) a.unread = 0;
  renderFeed();
  renderRail();
  renderTitle();
  toast("Marked as read", "i-check-all");
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch { /* the cookie clears on reload anyway */ }
  store.remove(CACHE_KEY);
  location.replace("/");
}

/* ------------------------------------------ drawer: drag-to-dismiss sheet */

/* On a phone the settings panel is a bottom sheet. Dragging the grip moves
   it with the finger; past a third of its height, or on a fast flick, it
   closes — otherwise it springs back. */
function wireDrawerDrag() {
  const panel = $("drawer-panel");
  const grip = $("drawer-grip");
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
    if (offset > panel.offsetHeight / 3 || velocity > 0.6) closeSettings();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
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
  const target = e.target;
  const typing = target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (e.key === "Escape") {
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
    case "n": newAddress(); break;
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

$("rail-list").addEventListener("click", (e) => {
  const rename = e.target.closest("[data-rename]");
  if (rename) { openLabelDialog(rename.dataset.rename); return; }
  const wipe = e.target.closest("[data-wipe]");
  if (wipe) { wipeAddress(wipe.dataset.wipe); return; }
  const item = e.target.closest("[data-address]");
  if (item) setFilter(item.dataset.address);
});
$("rail-list").addEventListener("scroll", moveRailHighlight, { passive: true });

$("btn-more").addEventListener("click", loadOlder);
$("btn-read-all").addEventListener("click", markAllRead);
$("btn-wipe").addEventListener("click", () => state.filter && wipeAddress(state.filter));
$("btn-rename").addEventListener("click", () => state.filter && openLabelDialog(state.filter));
$("search").addEventListener("input", (e) => setQuery(e.target.value));
$("search-clear").addEventListener("click", () => { $("search").value = ""; setQuery(""); $("search").focus(); });
$("btn-search").addEventListener("click", toggleSearch);

$("btn-copy").addEventListener("click", copyAddress);
$("btn-roll").addEventListener("click", newAddress);
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
  if (!document.hidden) { clearTimeout(state.pollTimer); poll(); }  // repaint and refresh at once
});
window.addEventListener("online", () => { clearTimeout(state.pollTimer); poll(); });

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
})();
