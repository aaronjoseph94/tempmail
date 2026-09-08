/* Formatting, escaping, the $ helper, clipboard and the toast. */

import { state } from "./state.js";

/* ---------------------------------------------------------------- helpers */

export const $ = (id) => document.getElementById(id);

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// localStorage throws in private mode and when site data is blocked.
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* fine without it */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* fine without it */ } },
};

let toastTimer = null;
let toastHideTimer = null;
/** A short notice. With an action it stays longer and carries one button (Undo, say). */
export function toast(text, icon = "i-tick", { action = null, onAction = null, duration = null } = {}) {
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

export function hideToast() {
  const el = $("toast");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  el.classList.add("out");
  toastHideTimer = setTimeout(() => { el.hidden = true; hideOnTop(el); }, 140);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function timeAgo(ts) {
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

export function dayLabel(ts) {
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
export function formatWhen(ts, opts = { dateStyle: "medium", timeStyle: "short" }) {
  return new Date(ts).toLocaleString(undefined, { ...opts, hour12: true });
}

/**
 * Renders a number as sliding digit columns, the way SmoothUI's number-flow
 * does: each digit is a two-high strip that slides when the value changes.
 * Falls back to plain text when the digit count changes.
 */
export function renderRoll(el, value) {
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

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function copyText(text) {
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
export function linkify(text) {
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

/**
 * Code-shaped runs in the plain-text body, made tappable to copy.
 *
 * The server picks one code per message and the chip at the top of the list
 * carries it; this is for the ones it does not pick -- a message with no
 * "code"/"verification" wording anywhere, a second code further down, or a
 * letters-and-digits code, none of which extractCode will name. Those sit in
 * the body as plain text with no affordance at all, and are exactly the thing
 * the reader opened the mail for.
 *
 * The digit shape is the server's own candidate rule (src/text.ts), so the
 * same prices, times, dates, phone numbers and "#12345" references are
 * excluded here. It is deliberately looser than extractCode about context:
 * being wrong here copies a number the reader did not want, while being wrong
 * there would put it on a lock screen.
 */
const BODY_CODE =
  /(?<![\d#$€£]|\d[ .,:/-])(\d{3}[ -]\d{3}|\d{4,8})(?![ -]?\d|[.,]\d|[%:/-]|\s?(?:am|pm)\b)|\b(?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}\b/g;

function looksLikeCode(raw) {
  const flat = raw.replace(/[ -]/g, "");
  // Four-digit years are almost never codes, the same exception the server makes.
  return !(flat.length === 4 && +flat >= 1900 && +flat <= 2099);
}

export function markCodes(root) {
  // A TreeWalker rather than a regex over innerHTML: linkify has already put
  // anchors in there, and rewriting markup with a pattern is how you end up
  // matching inside an href.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest("a, .tag") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    BODY_CODE.lastIndex = 0;
    if (BODY_CODE.test(node.nodeValue)) targets.push(node);
  }
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    BODY_CODE.lastIndex = 0;
    for (const match of node.nodeValue.matchAll(BODY_CODE)) {
      if (!looksLikeCode(match[0])) continue;
      frag.append(node.nodeValue.slice(last, match.index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "body-code";
      button.dataset.code = match[0].replace(/[ -]/g, "");
      button.title = "Copy this code";
      button.textContent = match[0];
      frag.append(button);
      last = match.index + match[0].length;
    }
    if (last === 0) continue;              // every match was a year
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

export function initialsFor(name) {
  const parts = name.trim().split(/[\s.<@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

/**
 * How an address reads in a list.
 *
 * With one domain the part after the @ is the same on every row and only takes
 * up space, so it goes. With several it is the only thing telling two
 * otherwise identical addresses apart, so it stays.
 */
export function shortAddress(address) {
  const at = (address || "").lastIndexOf("@");
  if (at < 1) return address || "";
  return state.mailDomains.length > 1 ? address : address.slice(0, at);
}

export function senderLabel(m) {
  return m.fromName || m.fromAddress || "unknown";
}

/* One query object rather than a fresh matchMedia per call, so the breakpoint
   can also be subscribed to. */
export const wideQuery = matchMedia("(min-width: 900px)");
export function isDesktop() {
  return wideQuery.matches;
}

/* ------------------------------------------------------------------ FLIP */

/*
 * Rows move rather than jump.
 *
 * The list is rebuilt wholesale on every render, so a row that changed place --
 * because one above it went, or new mail landed on top, or the filter changed
 * under it -- used to appear at its new position with nothing to say it had
 * travelled. Read where everything sits before the rebuild and again after,
 * then hand each difference to the compositor: it draws the row back where it
 * was and carries it forward.
 *
 * Viewport coordinates on purpose. What FLIP has to smooth is what the eye
 * sees, and when a shorter list clamps the restored scroll position, some rows
 * appear to move and others do not even though every one of them shifted in
 * the document. Measuring the page rather than the screen would animate rows
 * that visibly stayed put.
 *
 * Web Animations API, no library. Transforms only, so none of this costs a
 * layout, and an animation whose element the next render replaces dies with it.
 */
const FLIP_MS = 260;
const FLIP_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";   /* --ease-out */
const FLIP_MARGIN = 200;   // px beyond the visible box still worth animating

/** Where every keyed child sits now, to compare against after a rebuild. */
export function readRowTops(container) {
  if (reducedMotion.matches) return null;
  const tops = new Map();
  for (const el of container.children) {
    const key = el.dataset.flip;
    if (!key) continue;
    // A row still playing its arrival is holding a keyframe that offsets it,
    // and getBoundingClientRect() reports where the offset puts it. Recording
    // that would hand the next render a six-pixel move that never happened.
    if (el.classList.contains("arrived") || el.classList.contains("leaving")) continue;
    tops.set(key, el.getBoundingClientRect().top);
  }
  return tops;
}

/** Slides every surviving child from where readRowTops saw it to where it is. */
export function playRowMoves(container, before) {
  if (!before || reducedMotion.matches) return;
  // Whichever of the container and the window is the tighter bound: on desktop
  // the feed is its own scroller and clips its rows, on a phone it does not.
  const box = container.getBoundingClientRect();
  const ceiling = Math.max(box.top, 0) - FLIP_MARGIN;
  const floor = Math.min(box.bottom, innerHeight) + FLIP_MARGIN;

  const moves = [];
  for (const el of container.children) {
    const key = el.dataset.flip;
    if (!key) continue;
    const was = before.get(key);
    // Not there before: either new mail, which .arrived owns, or a row coming
    // back from a filter, which has no previous position to come from.
    if (was === undefined) continue;
    const now = el.getBoundingClientRect();
    const dy = was - now.top;
    if (Math.abs(dy) < 1) continue;
    // The span the row crosses, not just where it lands. Culling on the
    // destination alone teleports anything that exits the screen while the
    // rows around it are still sliding.
    if (Math.min(was, now.top) > floor || Math.max(was, now.top) + now.height < ceiling) continue;
    moves.push([el, dy]);
  }
  // Every rect is read before the first animation starts: Element.animate()
  // dirties style, so interleaving makes each subsequent read flush a recalc.
  for (const [el, dy] of moves) {
    el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: FLIP_MS, easing: FLIP_EASE },
    );
  }
}
