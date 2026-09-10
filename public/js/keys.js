/* Keyboard shortcuts. */

import { state } from "./state.js";
import { $, isDesktop, toast } from "./util.js";
import { focusSearch, setQuery, toggleSearch, toggleStar, visibleMessages } from "./render.js";
import { closeMailMenu, closeMessage, deleteOpen, manualRefresh, markUnread, openMessage, setSelecting } from "./viewer.js";
import { copyAddress, openNewInbox, stopWaiting } from "./inbox.js";
import { openSettings, toggleTheme } from "./settings.js";

export function openKeys() {
  $("keys").showModal();
}
export function closeKeys() {
  if ($("keys").open) $("keys").close();
}

/* --------------------------------------------------------------- keyboard */

export function step(direction) {
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

  // Any open dialog owns the keyboard. Naming just #settings here meant every
  // shortcut still fired underneath the two sheets and the rename box: "," on
  // top of an open sheet stacked Settings over it, and closing that revealed
  // the sheet still sitting there.
  const modal = document.querySelector("dialog[open]");

  if (e.key === "Escape") {
    if (state.waiting) { stopWaiting(); return; }
    if (modal) return;  // the dialog closes itself
    if (typing && target.id === "search") {
      if (target.value) { target.value = ""; setQuery(""); } else target.blur();
      if (!isDesktop()) toggleSearch();
      return;
    }
    if (state.open) closeMessage();
    return;
  }
  if (typing || modal) return;

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
    case "?": e.preventDefault(); openKeys(); break;
    case "#": case "Delete": deleteOpen(); break;
  }
});
