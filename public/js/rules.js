/* The rules sheet: what happens to mail as it arrives, in the order it happens. */

import { $, escapeHtml, toast } from "./util.js";
import { api, send } from "./api.js";
import { retireActionToast } from "./settings.js";

/* The words the owner reads, against the values the server checks. Kept here
   rather than generated from the API's list because a select full of
   "from_domain" is a database schema, not a sentence. */
const FIELDS = {
  from_domain: { label: "from a company", value: "Their domain", placeholder: "bank.example" },
  from_address: { label: "from an address", value: "Their address", placeholder: "alerts@bank.example" },
  subject: { label: "about something", value: "Words in the subject", placeholder: "receipt" },
  to_address: { label: "sent to an address", value: "The address", placeholder: "shop-a1@example.com" },
  has_attachment: { label: "carrying an attachment", value: null, placeholder: "" },
};

const ACTIONS = {
  star: "star it",
  read: "mark it read",
  allow: "always let it in",
  junk: "file it as junk",
  bin: "bin it",
};

let rules = [];
let max = 20;

export async function openRules() {
  await load();
  retireActionToast();
  $("rules").showModal();
  $("rules-panel").querySelector(".drawer-scroll").scrollTop = 0;
}

export function closeRules() { $("rules").close(); }

async function load() {
  try {
    const data = await api("/api/rules");
    rules = data.rules;
    max = data.max ?? max;
  } catch (err) {
    toast(err.message, "i-warn");
    rules = [];
  }
  render();
}

/** Writes the list whole. Order is part of what a rule means, so every edit is
    an edit of the list, and sending it whole is what stops a reorder landing
    half-applied. */
async function save(next) {
  const previous = rules;
  rules = next;
  render();
  try {
    const data = await send("PUT", "/api/rules", { rules: next });
    rules = data.rules;
    max = data.max ?? max;
  } catch (err) {
    rules = previous;
    toast(err.message, "i-warn");
  }
  render();
}

function sentence(rule) {
  const field = FIELDS[rule.field] ?? { label: rule.field };
  const what = rule.value ? `${field.label} <b>${escapeHtml(rule.value)}</b>` : field.label;
  return `Mail ${what} &rarr; <b>${escapeHtml(ACTIONS[rule.action] ?? rule.action)}</b>`;
}

function render() {
  $("rule-list").innerHTML = rules.map((rule, i) => `
    <div class="rule-row${rule.enabled ? "" : " off"}">
      <span class="rule-text">${sentence(rule)}</span>
      <span class="rule-tools">
        <button type="button" class="toggle" data-toggle="${i}" aria-pressed="${!!rule.enabled}"
                aria-label="${rule.enabled ? "Turn this rule off" : "Turn this rule on"}" title="${rule.enabled ? "Turn it off" : "Turn it on"}">
          <svg class="icon sm"><use href="#${rule.enabled ? "i-tick" : "i-close"}"/></svg>
        </button>
        <button type="button" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move this rule up" title="Move up">
          <svg class="icon sm"><use href="#i-chevron"/></svg>
        </button>
        <button type="button" data-down="${i}" ${i === rules.length - 1 ? "disabled" : ""} aria-label="Move this rule down" title="Move down">
          <svg class="icon sm"><use href="#i-chevron"/></svg>
        </button>
        <button type="button" class="drop" data-drop="${i}" aria-label="Delete this rule" title="Delete">
          <svg class="icon sm"><use href="#i-trash"/></svg>
        </button>
      </span>
    </div>`).join("");
  $("rule-add").disabled = rules.length >= max;
}

/** The value box only exists for the fields that need one. */
export function renderRuleForm() {
  const field = FIELDS[$("rule-field").value] ?? FIELDS.from_domain;
  $("rule-value-field").hidden = !field.value;
  $("rule-value-label").textContent = field.value ?? "";
  $("rule-value").placeholder = field.placeholder;
  $("rule-value").required = !!field.value;
}

export function fillRuleForm() {
  $("rule-field").innerHTML = Object.entries(FIELDS)
    .map(([value, f]) => `<option value="${value}">${escapeHtml(f.label)}</option>`).join("");
  $("rule-action").innerHTML = Object.entries(ACTIONS)
    .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  renderRuleForm();
}

export async function addRule(event) {
  event.preventDefault();
  const field = $("rule-field").value;
  const value = FIELDS[field]?.value ? $("rule-value").value.trim() : "";
  if (FIELDS[field]?.value && !value) { $("rule-value").focus(); return; }
  await save([...rules, { field, value, action: $("rule-action").value, enabled: true }]);
  $("rule-value").value = "";
  toast("Rule added", "i-tick");
}

export function onRuleClick(event) {
  const at = (attribute) => {
    const button = event.target.closest(`[data-${attribute}]`);
    return button ? Number(button.dataset[attribute]) : null;
  };
  const toggle = at("toggle");
  if (toggle !== null) {
    return save(rules.map((rule, i) => (i === toggle ? { ...rule, enabled: !rule.enabled } : rule)));
  }
  const drop = at("drop");
  if (drop !== null) return save(rules.filter((_, i) => i !== drop));
  const up = at("up");
  if (up !== null) return save(swap(rules, up, up - 1));
  const down = at("down");
  if (down !== null) return save(swap(rules, down, down + 1));
}

function swap(list, a, b) {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}
