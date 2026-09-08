/* Making, naming and watching an inbox. */

import { PREFS, ROLL_MODES, state } from "./state.js";
import { $, copyText, escapeHtml, renderRoll, senderLabel, store, toast } from "./util.js";
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

/* The alphabet for the random tail on a named address. No 0/o, 1/l/i: these
   get read aloud, typed on a phone and copied off a screen. */
const TAIL_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TAIL_LENGTH = 5;
/** How much of what was typed survives into the address. */
const SLUG_MAX = 24;

/**
 * A random tail, drawn without modulo bias.
 *
 * The tail is what stops an address being guessable from the site name alone:
 * "netflix@" would be the first thing anyone tried, and this inbox answers to
 * every address at the domain.
 */
function randomTail(length = TAIL_LENGTH) {
  const out = [];
  // 248 is the largest multiple of 31 under 256; bytes above it would make the
  // first eight letters of the alphabet fractionally more likely than the rest.
  const limit = 256 - (256 % TAIL_ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && out.length < length) out.push(TAIL_ALPHABET[byte % TAIL_ALPHABET.length]);
    }
  }
  return out.join("");
}

/**
 * What the owner typed, turned into the front of an address.
 *
 * A pasted URL keeps only its first host label, which is the name people mean:
 * "https://www.netflix.com/browse" is "netflix", "bbc.co.uk" is "bbc". Guessing
 * at registrable domains needs a public-suffix list and would still surprise
 * someone; taking the first word is a rule you can see working as you type.
 * Anything that is not a host is simply slugged: "My bank" becomes "my-bank".
 */
export function siteSlug(text) {
  let raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return "";
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/^@/, "").replace(/^www\./, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) raw = raw.split(".")[0];
  return raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/**
 * The domain the address is being handed to, when what was typed was one.
 *
 * This seeds `owner_domain`, which is what the Leaks view compares later
 * senders against -- so a named address knows who it belongs to before its
 * first message rather than after. The server checks it again with
 * normalizeDomain() in src/text.ts; this only decides whether to send it.
 */
export function siteDomain(text) {
  const host = String(text ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/^@/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : "";
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
  $("new-site").value = "";
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

/**
 * Fills the domain picker, and hides it when there is nothing to pick.
 *
 * One domain is the ordinary case and a select with a single option is just a
 * control that cannot be used, so it only appears once a second domain exists.
 */
export function renderDomainChoice() {
  const select = $("new-domain");
  const wanted = state.mailDomains.length > 1 ? state.mailDomains : [];
  const current = select.value;
  const sig = wanted.join(",");
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.innerHTML = wanted.map((d) => `<option value="${escapeHtml(d)}">@${escapeHtml(d)}</option>`).join("");
  }
  select.value = wanted.includes(current) ? current : (state.mailDomain || wanted[0] || "");
  $("new-domain-field").hidden = wanted.length === 0;
}

/** The domain the sheet is currently offering to make an address at. */
function chosenDomain() {
  const picked = $("new-domain").value;
  return state.mailDomains.includes(picked) ? picked : state.mailDomain;
}

/* Held steady while the sheet is open so the address does not churn under the
   cursor on every keystroke. Only the reroll button and a fresh sheet move it. */
let pendingTail = randomTail();
let pendingRandom = generateAddress();

/** Repaints the offered address from what is currently typed. */
export function renderCandidate() {
  renderDomainChoice();
  const domain = chosenDomain();
  const slug = siteSlug($("new-site").value);
  state.candidate = domain ? (slug ? `${slug}-${pendingTail}` : pendingRandom) : "";
  $("new-addr-text").textContent = state.candidate ? `${state.candidate}@${domain}` : "Add your mail domain in Settings";
  $("new-inbox-create").disabled = !state.candidate;
  $("new-addr-reroll").disabled = !state.candidate;
}

/** A different address for the same site, or a different random one. */
export function rerollCandidate() {
  pendingTail = randomTail();
  pendingRandom = generateAddress();
  renderCandidate();
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
  const address = `${state.candidate}@${chosenDomain()}`;
  const owner = siteDomain($("new-site").value);
  const button = $("new-inbox-create");
  button.disabled = true;
  try {
    // ownerDomain only when a domain was typed: it is what the Leaks view
    // measures every later sender against, so a guess would be worse than
    // nothing -- the first sender fills it in on its own otherwise.
    await send("PUT", `/api/addresses/${encodeURIComponent(address)}`, owner ? { ...ROLL_MODES[pendingLife], ownerDomain: owner } : ROLL_MODES[pendingLife]);
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
