/**
 * The rules the owner wrote by hand.
 *
 * The first stage of the classification pipeline, and the most authoritative:
 * everything below it is the app guessing, and this is the owner saying. A
 * rule is deliberately one condition and one action -- "if from my bank, star
 * it" -- because a rule builder with brackets and ANDs is a programming
 * language, and nobody wants to debug one inside a mail app.
 *
 * Every matching rule applies, so "star anything from the bank" and "mark
 * newsletters read" both work on the same message. Order still has teeth: an
 * action that files the message somewhere -- bin or junk -- is the end of the
 * matter, and nothing below it runs.
 */

import { relatedDomain, senderDomain } from "./addresses";

export const RULE_FIELDS = ["from_address", "from_domain", "subject", "to_address", "has_attachment"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_ACTIONS = ["star", "read", "allow", "junk", "bin"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** Rules are cheap, but a list nobody can read is not a feature. */
export const MAX_RULES = 20;
export const MAX_RULE_VALUE = 200;

export interface Rule {
  id: string;
  position: number;
  enabled: number;
  field: RuleField;
  value: string;
  action: RuleAction;
}

export function isRuleField(value: unknown): value is RuleField {
  return typeof value === "string" && (RULE_FIELDS as readonly string[]).includes(value);
}

export function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === "string" && (RULE_ACTIONS as readonly string[]).includes(value);
}

/** The only field that needs no value to mean something. */
export function needsValue(field: RuleField): boolean {
  return field !== "has_attachment";
}

export interface RuleSubject {
  to: string;
  from: string;
  subject: string;
  hasAttachment: boolean;
}

/**
 * Whether one rule matches one message.
 *
 * A domain rule uses relatedDomain(), the same test the Leaks view and the
 * Screener use, so "github.com" catches mail from notifications.github.com
 * without the owner having to know that is where it comes from.
 */
export function ruleMatches(rule: Rule, message: RuleSubject): boolean {
  const value = rule.value.toLowerCase();
  switch (rule.field) {
    case "from_address":
      return message.from.toLowerCase() === value;
    case "from_domain":
      return relatedDomain(senderDomain(message.from), value);
    case "subject":
      return message.subject.toLowerCase().includes(value);
    case "to_address":
      return message.to.toLowerCase() === value;
    case "has_attachment":
      return message.hasAttachment;
  }
}

/** How a rule reads back to the owner, for the "why is this here" line. */
export function describeRule(rule: Rule): string {
  const what: Record<RuleField, string> = {
    from_address: `from ${rule.value}`,
    from_domain: `from ${rule.value}`,
    subject: `with “${rule.value}” in the subject`,
    to_address: `sent to ${rule.value}`,
    has_attachment: "with an attachment",
  };
  const did: Record<RuleAction, string> = {
    star: "starred it",
    read: "marked it read",
    allow: "let it through",
    junk: "filed it as junk",
    bin: "binned it",
  };
  return `Your rule for mail ${what[rule.field]} ${did[rule.action]}`;
}
