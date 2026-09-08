/* The open message: body, header strips, context menu and selection mode. */

import { state } from "./state.js";
import { $, copyText, escapeHtml, formatBytes, formatWhen, hideToast, initialsFor, isDesktop, linkify, markCodes, plural, senderLabel, toast } from "./util.js";
import { api, send } from "./api.js";
import { poll, refresh } from "./data.js";
import { closeListMenu, domainOf, moveSegHighlight, relatedDomain, renderFeed, renderRail, renderTitle, toggleBlock, toggleStar, visibleMessages } from "./render.js";

/* ----------------------------------------------------------------- viewer */

let openSeq = 0;

export async function openMessage(id) {
  // The reader is a full-screen panel on a phone at z-index 50; the overflow
  // menu sits at 80 and would paint over it. body.reading also stops the
  // scroll dismissal firing, so it has to be closed here.
  closeListMenu();
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

export function bumpUnread(address, delta) {
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
  // Angle brackets are mail-header syntax; on a line of its own the address
  // needs no delimiters. Hidden outright when the name slot already holds it,
  // so the sender block never carries a blank row.
  const addr = $("msg-from-addr");
  addr.textContent = msg.fromName ? msg.fromAddress : "";
  addr.hidden = !msg.fromName;
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

export function renderBody() {
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
    markCodes(text);
  }
}

/** The star control in the open message, from state.open. */
export function paintStar() {
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
export function fitFrame(frame) {
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

export function closeMessage({ fromHistory = false } = {}) {
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

export async function deleteOpen() {
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
  noteDeleted(id);
  refresh().catch(() => {});
}

/*
 * The toast has one slot: raising a second one replaces the first's Undo button
 * and its ten-second window. That was survivable when deleting took a
 * right-click and a menu; a swipe makes two deletes about a second's work, and
 * the first message would quietly become unrecoverable. So deletes that land
 * inside one window accumulate, and Undo brings back everything it names.
 */
let pendingUndo = [];

function noteDeleted(id) {
  pendingUndo.push(id);
  const ids = pendingUndo.slice();
  toast(ids.length === 1 ? "Message deleted" : `${ids.length} messages deleted`, "i-trash", {
    action: "Undo",
    onAction: () => { pendingUndo = []; restore(ids); },
  });
  // The window closes with the toast, however it closes.
  clearTimeout(noteDeleted.t);
  noteDeleted.t = setTimeout(() => { pendingUndo = []; }, 10200);
}

/* --------------------------------------------------------- feed gestures */

/*
 * Long-press and swipe-to-delete, as one state machine.
 *
 * They share a pointerdown, so they cannot be two independent handlers: the
 * press timer has to die the moment a drag is recognised, and the drag has to
 * lose to the scroller if the finger is really going up or down.
 *
 * Touch only. A mouse has a right-click and a keyboard has the context menu,
 * and a pointer that can hover has no business flinging rows around.
 */
const SLOP = 10;        // px of travel before the axis is decided
const EDGE = 28;        // px at each screen edge left to the browser's back gesture
const COMMIT = 0.28;    // fraction of the row's width that counts as "delete it"
const PRESS_MS = 550;

export function wireFeedGestures() {
  const feed = $("feed");
  let press = 0;
  let g = null;               // the gesture in flight, or null
  let swallow = false;        // eat the click a finished swipe leaves behind
  let swallowTimer = 0;

  const cancelPress = () => { clearTimeout(press); press = 0; };
  const armSwallow = () => {
    swallow = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => { swallow = false; }, 700);
  };

  function settle(row, cls) {
    row.classList.remove("swiping", "armed", "sw-l", "sw-r");
    row.classList.add(cls);
    row.style.removeProperty("translate");
    const done = () => {
      row.classList.remove(cls);
      row.style.removeProperty("--sw-dx");
      row.removeEventListener("transitionend", done);
    };
    row.addEventListener("transitionend", done);
    // transitionend never fires under prefers-reduced-motion, where the
    // duration is ~0, so the class would stick and keep the row lifted.
    setTimeout(done, 400);
  }

  feed.addEventListener("pointerdown", (e) => {
    g = null;
    swallow = false;
    cancelPress();
    if (e.pointerType !== "touch" || !e.isPrimary || state.selecting) return;
    const row = e.target.closest(".mail");
    if (!row) return;
    // The outer few px of the screen belong to the platform's back gesture,
    // which no amount of touch-action can hold on to. Starting a swipe there
    // races the browser and loses.
    if (e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
    g = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, axis: null, dx: 0 };
    const { clientX, clientY } = e;
    press = setTimeout(() => {
      g = null;
      // Lifting a finger after a long press still synthesises a click, and
      // nothing suppresses it: the menu opened, and the message opened behind
      // it. Arm the same guard the swipe uses.
      armSwallow();
      openMailMenu({ clientX, clientY }, row.dataset.id);
    }, PRESS_MS);
  });

  feed.addEventListener("pointermove", (e) => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      cancelPress();
      // Vertical wins outright: the list scrolls, and this gesture is over.
      if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; }
      g.axis = "x";
      g.width = g.row.getBoundingClientRect().width;
      feed.classList.add("swiping");
      g.row.classList.add("swiping");
      // No setPointerCapture: a touch pointer already has implicit capture on
      // the element it went down on, and asking for it again drops the capture
      // outright on Chrome, which strands the gesture a few pixels in.
    }
    // A poll can rebuild the list underneath the finger. Once the row is
    // detached, moving it does nothing anyone can see -- let go instead.
    if (!g.row.isConnected) { feed.classList.remove("swiping"); g = null; return; }
    // The browser is still free to pan vertically under pan-y, so a swipe that
    // is not perfectly level scrolls the page while the row moves. Once the
    // axis is decided the gesture is ours: take the touch off the scroller.
    if (e.cancelable) e.preventDefault();
    g.dx = dx;
    g.row.style.translate = `${dx}px`;
    g.row.style.setProperty("--sw-dx", `${dx}px`);
    g.row.classList.toggle("sw-l", dx < 0);
    g.row.classList.toggle("sw-r", dx > 0);
    g.row.classList.toggle("armed", Math.abs(dx) > g.width * COMMIT);
  });

  const end = (e) => {
    cancelPress();
    if (!g) return;
    const gesture = g;
    g = null;
    if (gesture.axis !== "x") return;
    feed.classList.remove("swiping");
    armSwallow();
    if (!gesture.row.isConnected) return;
    const commit = e.type === "pointerup" && Math.abs(gesture.dx) > gesture.width * COMMIT;
    if (!commit) { settle(gesture.row, "swipe-back"); return; }
    // Send it the way it was going, then delete. deleteMessage adds .leaving
    // and rebuilds the list; this just carries the row off screen first.
    gesture.row.classList.remove("swiping");
    gesture.row.classList.add("swipe-out");
    gesture.row.style.translate = `${gesture.dx > 0 ? 110 : -110}%`;
    deleteMessage(gesture.id);
  };
  feed.addEventListener("pointerup", end);
  feed.addEventListener("pointercancel", end);

  /* A finished swipe still ends in a click on some browsers, and that click
     would open the message the user just threw away. It is swallowed in the
     capture phase with stopImmediatePropagation, because there is a second
     capture listener on this same node (the leak-card router in main.js) and
     plain stopPropagation would not stop a sibling on the same node.

     The flag is armed only by a gesture that actually went sideways, and it is
     disarmed three ways -- by the click it was meant for, by the next
     pointerdown, and by a timer -- so it can never sit waiting to eat an
     unrelated tap later on. */
  feed.addEventListener("click", (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  feed.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".mail");
    if (!row) return;
    e.preventDefault();
    cancelPress();
    g = null;
    openMailMenu(e, row.dataset.id);
  });
  feed.addEventListener("scroll", () => { cancelPress(); closeMailMenu(); }, { passive: true });
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
const SPIN_MS = 1000;   // must match the spin animation's period in style.css

export async function manualRefresh() {
  const button = $("btn-refresh");
  const started = performance.now();
  button.classList.add("spinning");
  clearTimeout(state.pollTimer);
  try {
    await poll();
  } finally {
    // Let it finish the turn it is on. Dropping the class part-way through
    // snaps the icon back to zero from whatever angle it had reached, which
    // is the jolt at the end of a quick refresh -- and a quick refresh is the
    // usual case. Waiting out the remainder costs at most one second and
    // always lands on 360, where removing the class is invisible.
    const wait = SPIN_MS - ((performance.now() - started) % SPIN_MS);
    setTimeout(() => button.classList.remove("spinning"), wait);
  }
}

export async function markUnread() {
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

export async function copyCode() {
  const code = state.open?.code;
  if (!code) return;
  toast((await copyText(code)) ? `Copied ${code}` : "Couldn't copy — select it by hand", "i-key");
}

/* Right-click menu on a message, shaped like shadcn's context menu:
   icon + label + shortcut, a separator, then a destructive Delete. */
let menuId = null;

export function closeMailMenu() {
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

export function openMailMenu(event, id) {
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

export function runMailMenu(act) {
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
export async function unsubscribeOpen() {
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
export function renderLeakStrip(msg) {
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

/* ---------------------------------------------------------- bulk select */

export function setSelecting(on) {
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
export function pickAll() {
  const ids = selectableMessages().map((m) => m.id);
  const all = ids.length > 0 && ids.every((id) => state.picked.has(id));
  state.picked.clear();
  if (!all) for (const id of ids) state.picked.add(id);
  for (const row of $("feed").querySelectorAll(".mail")) {
    row.classList.toggle("picked", state.picked.has(row.dataset.id));
  }
  renderSelection();
}

export function togglePick(id) {
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  document.querySelector(`.mail[data-id="${CSS.escape(id)}"]`)?.classList.toggle("picked", state.picked.has(id));
  renderSelection();
}

/** The server takes at most 200 ids per call. */
export async function sendInSlices(method, path, ids, extra = {}) {
  let affected = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const result = await send(method, path, { ids: ids.slice(i, i + 200), ...extra });
    affected += result?.restored ?? result?.updated ?? result?.deleted ?? 0;
  }
  return affected;
}

export async function bulk(action) {
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
