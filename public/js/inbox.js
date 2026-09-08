/* Making, naming and watching an inbox. */

import { PREFS, ROLL_MODES, state } from "./state.js";
import { $, copyText, renderRoll, senderLabel, store, toast } from "./util.js";
import { send } from "./api.js";
import { chime, refresh, schedulePoll } from "./data.js";
import { loadAddresses, moveSegHighlight, renderAddressCard, renderListHead, renderRail } from "./render.js";
import { openMessage } from "./viewer.js";
import { openSettings, retireActionToast } from "./settings.js";

/* --------------------------------------------------------------- labels */

export let renaming = null;

export function openLabelDialog(address) {
  renaming = address;
  const entry = state.addresses.find((a) => a.address === address);
  $("label-target").textContent = address;
  $("label-input").value = entry?.label ?? "";
  retireActionToast();
  $("label-dialog").showModal();
  $("label-input").focus();
  $("label-input").select();
}

export async function saveLabel() {
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

export function generateAddress() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(10 + Math.random() * 90)}`;
}

export function fullAddress() {
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
export function openNewInbox() {
  rerollCandidate();
  setPendingLife(pendingLife);
  retireActionToast();
  $("new-inbox").showModal();
}

export function closeNewInbox() { $("new-inbox").close(); }

/* The phone's inbox menu. Separate from creation: picking an inbox has no use
   for a lifetime choice and a Create button, and on a short phone they cost
   the room the list needs. No mail-domain guard either -- switching inbox and
   copying the current address work without one; only creating needs it. */
export function openInboxPicker() {
  $("sheet-addr-text").textContent = fullAddress();
  retireActionToast();
  $("btn-inboxes").setAttribute("aria-expanded", "true");
  $("inboxes").showModal();
  $("inboxes-panel").querySelector(".drawer-scroll").scrollTop = 0;
}

export function closeInboxPicker() {
  $("inboxes").close();
  $("btn-inboxes").setAttribute("aria-expanded", "false");
}

export function rerollCandidate() {
  state.candidate = state.mailDomain ? generateAddress() : "";
  $("new-addr-text").textContent = state.candidate ? `${state.candidate}@${state.mailDomain}` : "Add your mail domain in Settings";
  $("new-inbox-create").disabled = !state.candidate;
  $("new-addr-reroll").disabled = !state.candidate;
}

export function setPendingLife(life) {
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
export async function createInbox() {
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

export async function copyAddress() {
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

/* --------------------------------------------------------- wait for code */

export function startWaiting() {
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

export function stopWaiting() {
  if (!state.waiting) return;
  state.waiting = null;
  $("wait").hidden = true;
  document.body.classList.remove("waiting");
  schedulePoll();
}

/** The awaited message landed: show the code big, copy it, chime. */
export async function codeArrived(m) {
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
