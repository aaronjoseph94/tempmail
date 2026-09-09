/* Loading messages and addresses, the poll, and the live socket. */

import { CACHE_KEY, MAX_WINDOW, PAGE_SIZE, POLL_HIDDEN_MS, POLL_LIVE_MS, POLL_VISIBLE_MS, state } from "./state.js";
import { $, senderLabel, store, toast } from "./util.js";
import { api } from "./api.js";
import { brandName, renderDomain, renderFeed, renderRail, renderStorage, renderTitle } from "./render.js";
import { openMessage } from "./viewer.js";
import { codeArrived } from "./inbox.js";

/* ------------------------------------------------------------------- data */

export async function loadConfig() {
  state.config = await api("/api/config");
  renderDomain();
  renderStorage();
}

function listUrl({ cursor = null, limit = state.windowSize } = {}) {
  const params = new URLSearchParams();
  if (state.box !== "inbox") params.set("box", state.box);
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
export async function refresh({ announce = false } = {}) {
  const seq = ++refreshSeq;
  const [list, rail] = await Promise.all([api(listUrl()), api("/api/addresses")]);
  if (seq !== refreshSeq) return; // a newer refresh already landed

  const previousNewest = state.newestSeen;
  applyList(list);
  applyRail(rail.addresses, rail.boxes, rail.truncated);
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

export function applyRail(addresses, boxes, truncated = false) {
  state.addresses = addresses;
  state.addressesTruncated = !!truncated;
  if (boxes) state.boxCounts = boxes;
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
      const note = new Notification(brandName(), { body: text, tag: "tempmail-new" });
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

export function chime() {
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

export function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.autoRefresh) return;   // the user asked to check only on demand
  let wait = document.hidden ? POLL_HIDDEN_MS : state.live ? POLL_LIVE_MS : POLL_VISIBLE_MS;
  if (state.waiting && !state.live && !document.hidden) wait = 3000;   // someone is staring at the overlay
  state.pollTimer = setTimeout(poll, wait);
}

/* ------------------------------------------------------------------ live */

export let liveSocket = null;
export let liveRetry = 0;          // consecutive reconnect attempts, for the backoff
export let liveFailures = 0;       // sockets that died within a second of opening
let livePing = null;
let liveTimer = null;
let arrivalTimer = null;

/** Opens the WebSocket that announces new mail; polling remains as a backstop. */
export function connectLive() {
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

export function dropLive() {
  liveFailures = 3;           // no reconnects until the page is reloaded
  clearTimeout(liveTimer);
  try { liveSocket?.close(); } catch { /* fine */ }
}

export async function poll() {
  try {
    await refresh({ announce: true });
  } catch (err) {
    if (err.message !== "Signed out") console.warn("poll failed", err);
  } finally {
    schedulePoll();
  }
}

export async function loadOlder() {
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

export function loadCache() {
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
