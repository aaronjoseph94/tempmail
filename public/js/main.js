/* tempmail — inbox front-end.
   Plain browser JavaScript, no build step. Talks to the JSON API in src/api.ts.

   Motion notes: entrances run ~0.22s, exits ~0.12s, and anything that moves
   between two places (the rail highlight, the segmented control) is measured
   first and then animated, so it travels rather than jumping. Everything
   defers to prefers-reduced-motion. */

/* Event wiring and boot. The only module nothing imports from. */

import { PREFS, state } from "./state.js";
import { $, copyText, isDesktop, store, toast, wideQuery } from "./util.js";
import { chime, connectLive, liveFailures, liveRetry, liveSocket, loadCache, loadConfig, loadOlder, poll } from "./data.js";
import { closeListMenu, deleteInbox, dismissListMenu, moveRailHighlight, moveSegHighlight, openListMenu, renderDomain, renderFeed, renderRail, setBox, setFilter, setOwner, setQuery, setView, skeletonRows, toggleBlock, toggleSearch, toggleStar } from "./render.js";
import { bulk, closeMailMenu, closeMessage, copyCode, deleteOpen, fitFrame, manualRefresh, markJunk, markUnread, openMessage, pickAll, renderBody, runMailMenu, setSelecting, togglePick, unsubscribeOpen, wireFeedGestures } from "./viewer.js";
import { closeInboxPicker, closeNewInbox, copyAddress, createInbox, fullAddress, generateAddress, openInboxPicker, openLabelDialog, openNewInbox, renaming, renderCandidate, rerollCandidate, saveLabel, setPendingLife, startWaiting, stopWaiting } from "./inbox.js";
import { applyScheme, applyTheme, changePassword, closeSettings, deleteAll, dropDomain, makeDomainDefault, handleWorkerMessage, logout, markAllRead, openSettings, registerServiceWorker, forgetJunk, saveBrand, saveDomain, saveLimits, schemePref, setAlwaysImages, setAutoRefresh, setScreener, setSound, themePref, toggleNotifications, togglePush, toggleTheme, wireDrawerDrag } from "./settings.js";
import { step } from "./keys.js";

/* ----------------------------------------------------------------- wiring */

/* Long press opens the message menu on a touch screen; right-click does the
   same on a desktop. Both are wired on the feed rather than on each row, so a
   list that re-renders under the pointer never loses its handlers. */
wireFeedGestures();

/* The phone's overflow menu for the list header. Same open/dismiss shape as
   the message context menu, but anchored to its button rather than a pointer. */
$("btn-list-menu").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("list-menu").hidden) openListMenu(); else dismissListMenu();
});
$("list-menu").addEventListener("keydown", (e) => {
  const items = [...$("list-menu").querySelectorAll(".menu-item")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); dismissListMenu(); }
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#list-menu, #btn-list-menu")) closeListMenu();
}, true);
addEventListener("resize", closeListMenu);

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

/* Copying a code, wherever it is spelled: the chip on a list row, the chip in
   the open message, or a code-shaped run in the body that markCodes wrapped. */
function copyCodeFrom(target) {
  const code = target.closest("[data-code]");
  if (!code) return false;
  copyText(code.dataset.code).then((ok) => toast(ok ? `Copied ${code.dataset.code}` : "Couldn't copy", "i-key"));
  return true;
}

$("msg-text").addEventListener("click", (e) => copyCodeFrom(e.target));

$("feed").addEventListener("click", (e) => {
  const star = e.target.closest("[data-star]");
  if (star) {
    e.stopPropagation();
    toggleStar(star.dataset.star, star);
    return;
  }
  if (copyCodeFrom(e.target)) return;
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
  // Before the address branch: All mail carries both, and picking a box is
  // the more specific of the two intents.
  const box = e.target.closest("[data-box]");
  if (box) {
    setBox(box.dataset.box);
    if (box.dataset.box === "inbox") setFilter("");
    if (e.currentTarget.id === "picker-list") closeInboxPicker();
    return;
  }
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
/* The offered address follows what is typed, letter by letter, so the naming
   rule is something you watch work rather than something you have to be told. */
$("new-site").addEventListener("input", renderCandidate);
$("new-domain").addEventListener("change", renderCandidate);
$("domain-list").addEventListener("click", (e) => {
  const promote = e.target.closest("[data-domain]");
  if (promote) { makeDomainDefault(promote.dataset.domain); return; }
  const drop = e.target.closest("[data-drop]");
  if (drop) dropDomain(drop.dataset.drop);
});
document.addEventListener("maildomain", () => { if ($("new-inbox").open) renderCandidate(); });
$("new-site").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("new-inbox-create").disabled) { e.preventDefault(); createInbox(); }
});

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
$("btn-junk").addEventListener("click", () => state.open && markJunk([state.open.id], state.open.box !== "junk"));
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
$("sel-junk").addEventListener("click", () => markJunk([...state.picked], state.box !== "junk"));
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
$("set-screener").addEventListener("change", (e) => setScreener(e.target.checked));
$("junk-forget").addEventListener("click", forgetJunk);

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
$("brand-form").addEventListener("submit", saveBrand);
$("domain-form").addEventListener("submit", saveDomain);
$("password-form").addEventListener("submit", changePassword);
$("set-sound").addEventListener("change", (e) => setSound(e.target.checked));
$("set-notify").addEventListener("change", (e) => toggleNotifications(e.target.checked));
$("scheme-swatches").addEventListener("click", (e) => {
  const button = e.target.closest("[data-scheme]");
  if (button) applyScheme(button.dataset.scheme);
});
$("scheme-swatches").addEventListener("keydown", (e) => {
  // A radiogroup is arrow-navigable; without this a keyboard user can reach
  // the row but only ever pick whichever swatch tab landed on.
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const buttons = [...$("scheme-swatches").querySelectorAll("[data-scheme]")];
  const at = buttons.findIndex((b) => b.dataset.scheme === schemePref());
  const next = buttons[(at + step + buttons.length) % buttons.length];
  applyScheme(next.dataset.scheme);
  next.focus();
});
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
  state.leaksSeen = Number(store.get(PREFS.leaksSeen)) || 0;
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
