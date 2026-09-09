/* Everything one address is signed up to, and leaving all of it at once. */

import { state } from "./state.js";
import { $, escapeHtml, plural, toast } from "./util.js";
import { api, send } from "./api.js";
import { retireActionToast } from "./settings.js";

let subs = [];
let batch = 5;
let address = "";
let picked = new Set();
let running = false;

export async function openSubs() {
  if (!state.filter) return;
  address = state.filter;
  subs = [];
  picked = new Set();
  $("subs-progress").hidden = true;
  $("sub-list").innerHTML = "";
  $("subs-hint").textContent = "Looking…";
  retireActionToast();
  $("subs").showModal();
  await load();
}

export function closeSubs() { $("subs").close(); }

async function load() {
  try {
    const data = await api(`/api/addresses/${encodeURIComponent(address)}/subscriptions`);
    subs = data.subscriptions;
    batch = data.batch ?? batch;
  } catch (err) {
    toast(err.message, "i-warn");
    subs = [];
  }
  // Everything not already left is worth offering; the point of the sheet is
  // the one tap, so it starts ready for it.
  picked = new Set(subs.filter((s) => !s.already).map((s) => s.key));
  render();
}

function statusOf(sub) {
  if (sub.result?.ok) return { text: "Unsubscribed", tone: "ok" };
  if (sub.result?.method === "open") return { text: "Opens a page", tone: "" };
  if (sub.result?.method === "mailto") return { text: "Needs an email", tone: "" };
  if (sub.result) return { text: sub.result.detail || "Did not work", tone: "bad" };
  if (sub.already?.status === "done") return { text: "Unsubscribed", tone: "ok" };
  if (sub.oneClick) return { text: "One tap", tone: "" };
  return { text: "Opens a page", tone: "" };
}

function render() {
  $("subs-hint").textContent = subs.length
    ? `${plural(subs.length, "list")} writing to ${address}. The ones marked “one tap” can be left from here; the rest open the sender's own page.`
    : `Nothing sent to ${address} carries an unsubscribe link.`;

  $("sub-list").innerHTML = subs.map((sub) => {
    const status = statusOf(sub);
    const done = sub.result?.ok || sub.already?.status === "done";
    return `<label class="sub-row${done ? " done" : ""}">
      <input type="checkbox" data-key="${escapeHtml(sub.key)}" ${picked.has(sub.key) ? "checked" : ""} ${done ? "disabled" : ""} />
      <span class="sub-body">
        <span class="sub-name">${escapeHtml(sub.name)}</span>
        <span class="sub-meta">${escapeHtml(plural(sub.count, "message"))} · <span class="sub-status ${status.tone}">${escapeHtml(status.text)}</span></span>
      </span>
    </label>`;
  }).join("");

  const n = picked.size;
  $("subs-go").disabled = n === 0 || running;
  $("subs-go-label").textContent = running ? "Working…" : n ? `Unsubscribe from ${n}` : "Nothing selected";
}

export function onSubClick(event) {
  const box = event.target.closest("[data-key]");
  if (!box) return;
  if (box.checked) picked.add(box.dataset.key);
  else picked.delete(box.dataset.key);
  render();
}

/**
 * Works through the chosen lists a few at a time.
 *
 * Each one is an outbound request with its own timeout, so a single call that
 * tried forty would hang and then say nothing about which of the forty worked.
 * Small batches mean the sheet fills in as it goes and a failure is attached to
 * the list it belongs to.
 */
export async function runSubs() {
  if (running || !picked.size) return;
  running = true;
  const keys = [...picked];
  let done = 0;
  render();

  for (let i = 0; i < keys.length; i += batch) {
    const slice = keys.slice(i, i + batch);
    $("subs-progress").hidden = false;
    $("subs-progress").textContent = `Asking ${done + 1}–${Math.min(done + slice.length, keys.length)} of ${keys.length}…`;
    let results;
    try {
      ({ results } = await send("POST", "/api/unsubscribe", { address, keys: slice }));
    } catch (err) {
      toast(err.message, "i-warn");
      break;
    }
    for (const result of results) {
      const sub = subs.find((s) => s.key === result.key);
      if (sub) sub.result = result;
      if (result.ok) picked.delete(result.key);
    }
    done += slice.length;
    render();
  }

  running = false;
  $("subs-progress").hidden = true;
  const left = subs.filter((s) => s.result?.ok).length;
  const manual = subs.filter((s) => s.result && !s.result.ok && (s.result.method === "open" || s.result.method === "mailto")).length;
  render();
  toast(
    left
      ? `Unsubscribed from ${plural(left, "list")}${manual ? `, ${manual} still need you` : ""}`
      : "None of those could be left from here",
    left ? "i-tick" : "i-warn"
  );
}
