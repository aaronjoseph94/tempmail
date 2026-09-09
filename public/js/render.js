/* Painting the rail, the list and the header; search and the view filters. */

import { PAGE_SIZE, PREFS, state } from "./state.js";
import { $, dayLabel, escapeHtml, formatBytes, formatWhen, hideToast, initialsFor, isDesktop, playRowMoves, plural, readRowTops, reducedMotion, renderRoll, senderLabel, shortAddress, store, timeAgo, toast } from "./util.js";
import { api, send } from "./api.js";
import { applyRail, refresh } from "./data.js";
import { closeMessage, paintStar, renderLeakStrip, setSelecting } from "./viewer.js";

/* -------------------------------------------------------------- rendering */

/* The site's name lives in a server setting so a fork can rename itself
   without editing markup. This is the fallback until /api/config answers, and
   it is the only place the default is written on this side. */
const BRAND_DEFAULT = "Temp Email";
export function brandName() {
  return state.config?.brandName || BRAND_DEFAULT;
}

export function renderBrand() {
  const name = brandName();
  $("brand-name").textContent = name;
  $("brand-link").setAttribute("aria-label", `${name} home`);
  $("set-brand").value = state.config?.brandName || "";
  renderTitle();
}

export function renderTitle() {
  const unread = state.addresses.reduce((n, a) => n + (a.unread || 0), 0);
  document.title = unread ? `(${unread}) ${brandName()}` : brandName();
}

export function renderDomain() {
  renderBrand();
  const had = state.mailDomain;
  state.mailDomains = state.config?.mailDomains ?? state.mailDomains;
  state.mailDomain = state.config?.mailDomain || state.mailDomain || "";
  $("domain-pill").hidden = !state.mailDomain;
  $("domain-label").textContent = state.mailDomain;
  renderAddressCard();
  // The config arrives after the first paint, so the new-inbox sheet can be
  // open and still showing "add your mail domain" by the time it lands.
  // Announced rather than called, because inbox.js already imports this module.
  if (state.mailDomain && state.mailDomain !== had) document.dispatchEvent(new CustomEvent("maildomain"));
}

export function renderAddressCard() {
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

export function renderStorage() {
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

export function renderRail() {
  const all = totals();
  const sig = JSON.stringify([state.filter, state.box, state.boxCounts, state.addressesTruncated, !!state.config?.screener, !!state.config?.junk?.ready, all, state.mailDomains.length, state.addresses.map((a) => [a.address, a.count, a.unread, a.label, a.mode, a.expiresAt, a.used, a.leaks?.length])]);
  if (sig !== state.railSig) {
    const hadRows = state.railSig !== "";
    state.railSig = sig;
    const rows = [railRow({ address: "", label: "All mail", count: all.count, unread: all.unread, all: true })];
    // The boxes that are not the inbox sit under All mail: a mailbox, not a
    // filter, so it belongs here rather than among the All / Unread chips --
    // which stay filters *within* whichever box is open.
    for (const box of BOX_ROWS) {
      const tally = state.boxCounts?.[box.box];
      if (!tally?.count && !box.always()) continue;
      rows.push(boxRow(box, tally));
    }
    for (const a of state.addresses) {
      rows.push(railRow({ address: a.address, label: shortAddress(a.address), name: a.label, count: a.count, unread: a.unread, entry: a }));
    }
    // A freshly rolled address has no mail yet but can still be selected.
    if (state.filter && !state.addresses.some((a) => a.address === state.filter)) {
      rows.push(railRow({ address: state.filter, label: shortAddress(state.filter), count: 0, unread: 0 }));
    }
    if (!state.addresses.length) rows.push('<div class="rail-empty">No mail received yet</div>');
    // The list is capped, because a catch-all can be handed thousands of
    // guessed addresses. Say so rather than letting older ones just vanish.
    if (state.addressesTruncated) {
      rows.push('<div class="rail-empty">Showing the most recent addresses. Search to find an older one.</div>');
    }
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

/**
 * The mailboxes that are not the inbox. Each is shown when it holds something,
 * or when its feature is switched on and it is therefore a place mail can go.
 */
const BOX_ROWS = [
  {
    box: "screener",
    label: "Screener",
    icon: "i-shield",
    title: "Mail from senders you have not heard from before",
    always: () => !!state.config?.screener,
  },
  {
    box: "junk",
    label: "Junk",
    icon: "i-ban",
    title: "Mail the filter recognised from what you have marked junk before",
    // Only once it has actually been taught something. A box that can never
    // fill is a row that only ever says nothing.
    always: () => !!state.config?.junk?.ready,
  },
];

function boxRow({ box, label, icon, title }, tally) {
  const active = state.box === box;
  const count = tally?.count ?? 0;
  const unread = tally?.unread ?? 0;
  const marker = unread > 0 ? `<span class="badge">${unread}</span>` : `<span class="count">${count}</span>`;
  return `<div class="rail-row">
    <button class="rail-item all${active ? " active" : ""}" data-box="${escapeHtml(box)}"${active ? ' aria-current="true"' : ""} title="${escapeHtml(title)}">
      <svg class="icon sm" aria-hidden="true"><use href="#${escapeHtml(icon)}"/></svg><span class="name">${escapeHtml(label)}</span>${marker}
    </button></div>`;
}

function railRow({ address, label, name, count, unread, all = false, entry = null }) {
  // Nothing in the rail is the current address while a different box is open.
  const active = state.box === "inbox" && state.filter === address;
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
    <button class="rail-item${all ? " all" : ""}${active ? " active" : ""}${dead}" data-address="${escapeHtml(address)}"${all ? ' data-box="inbox"' : ""}${active ? ' aria-current="true"' : ""} title="${escapeHtml(address || "Every address")}">
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
export function domainOf(address) {
  const at = (address || "").lastIndexOf("@");
  return at < 0 ? null : address.slice(at + 1).toLowerCase();
}
export function relatedDomain(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/**
 * Removes an inbox outright: its mail, then the address row itself, so it stops
 * appearing in the rail. Not undoable, so it asks first.
 */
export async function deleteInbox(address) {
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
export async function toggleBlock(address) {
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
export async function setOwner(address) {
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
 * Slides the single highlight element behind the active rail row: measure the
 * target, then let CSS spring the pill's offset and size to match, so it
 * travels rather than jumping. Desktop only -- below 900px the rows live in
 * the picker sheet, where each carries its own fill and there is no rail to
 * slide anything along.
 */
export function moveRailHighlight() {
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
export function moveSegHighlight(seg = $("body-toggle")) {
  const active = seg.querySelector('[aria-pressed="true"]');
  if (!active || seg.hidden) return;
  const box = active.getBoundingClientRect();
  const segBox = seg.getBoundingClientRect();
  seg.style.setProperty("--seg-x", `${box.left - segBox.left}px`);
  seg.style.setProperty("--seg-w", `${box.width}px`);
  if (seg.dataset.ready === "false") requestAnimationFrame(() => { seg.dataset.ready = "true"; });
}

/* The newest leak anywhere, or 0. A leak carries the time the stranger wrote. */
function newestLeak() {
  let newest = 0;
  for (const a of state.addresses) for (const l of a.leaks || []) newest = Math.max(newest, l.last);
  return newest;
}

/*
 * Everything the Leaks view is showing counts as seen from here on.
 *
 * The pip has to mean "there is something in here you have not looked at". It
 * used to mean "a leak exists", and a leak is a permanent fact about an
 * address -- once a stranger has written to it, it has been leaked forever --
 * so the pip could never go out however many times you visited.
 *
 * The watermark is stamped from the leaks themselves rather than from the
 * clock: the timestamps come from the server, and a browser running behind it
 * would otherwise mark a leak seen a moment before it was able to arrive.
 */
function markLeaksSeen() {
  const newest = newestLeak();
  if (newest <= state.leaksSeen) return;
  state.leaksSeen = newest;
  store.set(PREFS.leaksSeen, String(newest));
  renderViewChips();
}

function renderViewChips() {
  const unread = totals().unread;
  $("pip-unread").hidden = unread === 0;
  $("pip-leaks").hidden = !state.addresses.some((a) => a.leaks?.some((l) => l.last > state.leaksSeen));
  for (const chip of document.querySelectorAll("[data-view]")) {
    const on = chip.dataset.view === state.view;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

export function renderListHead() {
  const box = state.box !== "inbox" ? BOX_ROWS.find((b) => b.box === state.box) : null;
  const tally = box ? state.boxCounts?.[box.box] : null;
  const entry = state.filter ? state.addresses.find((a) => a.address === state.filter) : null;
  const count = box ? tally?.count ?? 0 : state.filter ? entry?.count ?? 0 : totals().count;
  const unread = box ? tally?.unread ?? 0 : state.filter ? entry?.unread ?? 0 : totals().unread;
  $("list-title").textContent = box ? box.label : state.filter || "All mail";
  $("list-sub").textContent = box
    ? (count ? `${plural(count, "message")} waiting` : "")
    : count ? `${plural(count, "message")}${unread ? ` · ${unread} unread` : ""}` : "";
  $("btn-wipe").hidden = !state.filter || !!box;
  $("btn-rename").hidden = !state.filter || !!box;
  const blocked = entry?.mode === "blocked";
  $("btn-burn").hidden = !state.filter || !!box;
  $("btn-burn").setAttribute("aria-pressed", String(blocked));
  $("btn-burn").classList.toggle("on", blocked);
  $("btn-burn").title = blocked ? "Unblock this address" : "Block this address: mail to it bounces";
  $("btn-burn").setAttribute("aria-label", $("btn-burn").title);
  $("btn-read-all").hidden = unread === 0 || !!box;
  // Stays live inside a box. A phone has no rail, so this button is the only
  // way to the list the boxes live in -- disabling it here left no way back
  // out of the Screener at all.
  $("btn-inboxes").disabled = isDesktop();
}

/* ------------------------------------------------------ list overflow menu */

/*
 * Phones show one button beside the list title instead of five. The menu is
 * built from .list-tools every time it opens and each item forwards its click
 * to the real button, so renderListHead above stays the only thing that
 * decides which actions exist and when -- there is no second copy of that
 * state to drift.
 *
 * Block's label is the one thing read live rather than from data-menu, because
 * it flips to "Unblock" with the address.
 */
export function openListMenu() {
  const menu = $("list-menu");
  const trigger = $("btn-list-menu");
  const items = [...document.querySelectorAll(".list-tools [data-menu]")].filter((b) => !b.hidden);
  if (!items.length) return;

  menu.replaceChildren(...items.map((b) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item" + (b.classList.contains("danger") ? " danger" : "");
    item.setAttribute("role", "menuitem");
    const use = b.querySelector("use")?.getAttribute("href") ?? "#i-mail";
    const label = b.id === "btn-burn" ? (b.classList.contains("on") ? "Unblock this inbox" : "Block this inbox") : b.dataset.menu;
    item.innerHTML = `<svg class="icon sm" aria-hidden="true"><use href="${escapeHtml(use)}"/></svg><span></span>`;
    item.querySelector("span").textContent = label;
    item.addEventListener("click", () => { closeListMenu(); b.click(); });
    return item;
  }));

  // Not hideToast(): this menu is the route to Block and to bulk delete, both
  // of which leave a ten-second Undo. Opening it must not throw that away.
  if (!$("toast").querySelector(".toast-act")) hideToast();

  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  placeListMenu();
  menu.querySelector(".menu-item")?.focus();
}

function placeListMenu() {
  const menu = $("list-menu");
  const at = $("btn-list-menu").getBoundingClientRect();
  // offsetWidth/Height, not getBoundingClientRect: .menu animates in from
  // scale 0.96 with fill-mode both, so the measured rect is 4% small at the
  // moment it is unhidden and the clamp below would let it hang off screen.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const pad = 8;
  const left = Math.min(Math.max(pad, at.right - w), innerWidth - w - pad);
  const below = at.bottom + 6;
  const flip = below + h > innerHeight - pad;
  const top = flip ? Math.max(pad, at.top - h - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${Math.round(at.left + at.width / 2 - left)}px ${flip ? h : 0}px`;
}

export function closeListMenu() {
  const menu = $("list-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  $("btn-list-menu").setAttribute("aria-expanded", "false");
}

/** Focus goes back to the button that opened it, or it lands on <body>. */
export function dismissListMenu() {
  if ($("list-menu").hidden) return;
  closeListMenu();
  $("btn-list-menu").focus();
}

function matchesQuery(m) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [m.subject, m.fromName, m.fromAddress, m.address, m.snippet].some((v) => (v || "").toLowerCase().includes(q));
}

export function visibleMessages() {
  return state.messages.filter(matchesQuery);
}

function feedScroller() {
  return isDesktop() ? $("feed") : document.scrollingElement;
}

export function skeletonRows(n = 6) {
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

/* The query the last feed render was painted for; see the FLIP note below. */
let flipQuery = null;

export function renderFeed(arrived = new Set()) {
  if (state.view === "leaks") {
    const leaked = state.addresses.filter((a) => a.leaks?.length);
    markLeaksSeen();
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
  const sig = JSON.stringify([state.view, state.filter, state.query, state.open?.id, state.hasMore, state.mailDomains.length, visible.map((m) => [m.id, m.read, m.starred])]);
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
      html.push(`<div class="day" data-flip="day:${escapeHtml(label)}">${escapeHtml(label)}</div>`);
    }
    html.push(mailRow(m, arrived.has(m.id) ? stagger++ : -1));
  }
  // Read where the rows are before the rebuild wipes them, and slide the
  // survivors from there to wherever they land. Not while the query is being
  // typed: renderFeed runs on every keystroke, so each round would restart the
  // one before it from wherever it had got to and the list would smear.
  const before = flipQuery === state.query ? readRowTops($("feed")) : null;
  flipQuery = state.query;
  $("feed").innerHTML = html.join("");
  scroller.scrollTop = scrollTop;
  playRowMoves($("feed"), before);

  renderEmpty(visible.length);
  $("btn-more").hidden = !state.hasMore || !!state.query;
  $("search-count").textContent = state.query ? `${visible.length}` : "";
  $("search-clear").hidden = !state.query;
}

function mailRow(m, staggerIndex) {
  const from = senderLabel(m);
  const local = shortAddress(m.address);
  const classes = [
    "mail",
    m.read ? "" : "unread",
    m.id === state.open?.id ? "open" : "",
    state.picked.has(m.id) ? "picked" : "",
    staggerIndex >= 0 ? "arrived" : "",
  ].filter(Boolean).join(" ");
  const delay = staggerIndex >= 0 ? ` style="--stagger:${Math.min(staggerIndex, 6) * 45}ms"` : "";
  return `<div class="${classes}" data-id="${escapeHtml(m.id)}" data-flip="${escapeHtml(m.id)}" role="button" tabindex="0"${delay}>
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
  const firstRun = state.addresses.length === 0 && !state.query && !state.filter && state.view === "all" && state.box === "inbox";
  $("empty-steps").hidden = !firstRun;
  $("empty-hint").hidden = !firstRun;
  if (state.box === "junk" && !state.query) {
    $("empty-title").textContent = "No junk";
    $("empty-text").textContent = state.config?.junk?.ready
      ? "Mail that looks like what you have marked junk before ends up here."
      : `Mark ${state.config?.junk?.needed ?? 5} junk and ${state.config?.junk?.needed ?? 5} good messages and the filter starts doing this for you.`;
  } else if (state.box === "screener" && !state.query) {
    $("empty-title").textContent = "Nobody is waiting";
    $("empty-text").textContent = state.config?.screener
      ? "Mail from a sender you have not heard from before waits here until you say yes."
      : "The Screener is off. Turn it on in Settings and strangers wait here instead of landing in your inbox.";
  } else if (state.query) {
    $("empty-title").textContent = "No matches";
    $("empty-text").textContent = `Nothing matches “${state.query}”.`;
  } else if (state.view === "unread") {
    $("empty-title").textContent = "All caught up";
    $("empty-text").textContent = "Nothing unread here.";
  } else if (state.view === "starred") {
    $("empty-title").textContent = "No starred mail";
    $("empty-text").textContent = "Star a message to keep it past the nightly cleanup.";
  } else if (state.view === "leaks") {
    $("empty-title").textContent = "Nobody has shared your address";
    $("empty-text").textContent =
      "Inboxes remember their original sender. If someone else emails you, you'll know who leaked your address.";
  } else if (state.filter) {
    $("empty-title").textContent = "Nothing here yet";
    $("empty-text").textContent = `Send something to ${state.filter} and it will appear here.`;
  } else {
    $("empty-title").textContent = "No mail yet";
    $("empty-text").textContent = firstRun ? "Three steps and your first message lands here." : "";
  }
}

/* ----------------------------------------------------- filtering + search */

/**
 * Switches mailbox.
 *
 * A box is not a filter: the address rail and the All / Unread / Starred /
 * Leaks chips are both about the inbox, so leaving it clears the address and
 * puts the chips away rather than offering combinations nobody asked for
 * ("starred leaks in the Screener" is not a view).
 */
export function setBox(box) {
  if (state.box === box) return;
  state.box = box;
  state.filter = "";
  state.view = "all";
  state.query = "";
  $("search").value = "";
  if (state.selecting) setSelecting(false);
  closeMessage();
  state.windowSize = PAGE_SIZE;
  state.railSig = "";
  state.feedSig = "";
  document.body.classList.toggle("in-box", box !== "inbox");
  renderRail();
  renderListHead();
  skeletonRows();
  refresh().catch(() => {});
}

export function setFilter(address) {
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
export function setQuery(text) {
  state.query = text.trim();
  state.windowSize = PAGE_SIZE;
  renderFeed();                                    // filter what is already loaded…
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch(() => {}), 250);  // …then ask the server
}

export function focusSearch() {
  document.body.classList.add("searching");
  $("btn-search").setAttribute("aria-expanded", "true");
  $("search").focus();
  $("search").select();
}

export function toggleSearch() {
  if (document.body.classList.contains("searching")) {
    document.body.classList.remove("searching");
    $("btn-search").setAttribute("aria-expanded", "false");
    if (state.query) { $("search").value = ""; setQuery(""); }
  } else {
    focusSearch();
  }
}

/* ------------------------------------------------------- views + starring */

export function setView(view) {
  if (state.view === view) return;
  // Nothing in the Leaks view is selectable, so selection mode cannot follow us there.
  if (view === "leaks" && state.selecting) setSelecting(false);
  state.view = view;
  state.windowSize = PAGE_SIZE;
  renderViewChips();
  refresh().catch((err) => toast(err.message, "i-warn"));
}

/** Stars or unstars one message, updating the row before the server replies. */
export async function toggleStar(id, button) {
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

export async function loadAddresses() {
  const data = await api("/api/addresses");
  applyRail(data.addresses, data.boxes, data.truncated);
}
