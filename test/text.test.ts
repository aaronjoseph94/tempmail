import { describe, expect, it } from "vitest";
import { allowedDomains, domainAccepted } from "../src/email";
import type { Env } from "../src/index";
import { extractCode, htmlToText, makeSnippet, normalizeDomain } from "../src/text";

describe("htmlToText", () => {
  it("drops markup, scripts and styles but keeps the words", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head>
      <body><script>alert(1)</script><p>Hello <b>world</b></p><p>Second&nbsp;line &amp; more</p></body></html>`;
    expect(htmlToText(html)).toBe("Hello world\nSecond line & more");
  });

  it("does not confuse <header> with <head>", () => {
    expect(htmlToText("<header>Top</header><p>Body</p>")).toBe("Top\nBody");
  });

  it("decodes numeric entities and collapses whitespace", () => {
    expect(htmlToText("A&#160;B &#x263A;   C<br><br><br>D")).toBe("A B ☺ C\n\nD");
  });
});

describe("makeSnippet", () => {
  it("prefers the text part", () => {
    expect(makeSnippet("  plain   text\n\nhere ", "<p>html</p>")).toBe("plain text here");
  });

  it("falls back to stripped html", () => {
    expect(makeSnippet("", "<div>From <i>html</i></div>")).toBe("From html");
  });

  it("returns null when there is nothing to show", () => {
    expect(makeSnippet(null, null)).toBeNull();
    expect(makeSnippet("   ", "<style>x</style>")).toBeNull();
  });

  it("cuts long text at 160 characters with an ellipsis", () => {
    const snippet = makeSnippet("x".repeat(500), null)!;
    expect(snippet.length).toBe(160);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("extractCode", () => {
  it("finds a code in the subject", () => {
    expect(extractCode("Your verification code is 482913", "")).toBe("482913");
  });

  it("finds a code on its own line in the body", () => {
    expect(extractCode("Sign in to Acme", "Here is your one-time passcode:\n\n  70415\n\nIt expires in 10 minutes.")).toBe("70415");
  });

  it("joins split codes like 123 456", () => {
    expect(extractCode("Code", "Enter the code 123 456 to continue")).toBe("123456");
    expect(extractCode("Code", "Your PIN: 654-321")).toBe("654321");
  });

  it("ignores years, prices, phone numbers, times and order numbers", () => {
    expect(extractCode("Your order #48213 shipped", "Placed on 2026-09-06 at 10:30, total $1,234.56. Call 555-123-4567.")).toBeNull();
    expect(extractCode("Verification code", "Copyright 2026. Call 555 123 4567 or +1 555 9876.")).toBeNull();
    expect(extractCode("Your code", "Your code is 2026")).toBeNull(); // four-digit years are deliberately skipped
  });

  it("needs some code-like wording somewhere", () => {
    expect(extractCode("Invoice 20240915", "Amount due: 4500")).toBeNull();
    expect(extractCode("Hello", "Ref 123456")).toBeNull();
  });

  it("prefers six digits near a keyword over other numbers", () => {
    expect(extractCode("Welcome", "Order 1234 confirmed. Your verification code: 987654. Ticket 55555.")).toBe("987654");
  });

  it("handles a period after the code", () => {
    expect(extractCode("Confirm", "Your code is 4821.")).toBe("4821");
  });

  it("reads a code the wording only names afterwards", () => {
    expect(extractCode("Google", "G-482913 is your Google verification code")).toBe("482913");
  });

  it("ignores the other kinds of code", () => {
    expect(extractCode("Delivery", "Postal code 94103. Your tracking code is on the way.")).toBeNull();
    expect(extractCode("Your code", "Zip code 10001 · 2500 points earned")).toBeNull();
    expect(extractCode("Sale", "Your promo code SAVE20 takes 1500 off any order")).toBeNull();
  });

  it("ignores numbers that name themselves as references", () => {
    expect(extractCode("Password reset", "Your ticket 55512 is open. Reset your password from the link.")).toBeNull();
    expect(extractCode("Your code", "Account 87654321 · invoice 4471902")).toBeNull();
    expect(extractCode("Confirm your seat", "Booking reference 8823910 for 6 guests.")).toBeNull();
  });

  it("ignores quantities and totals", () => {
    expect(extractCode("Confirm your order", "Total: 4500 credits. 1200 points added.")).toBeNull();
    expect(extractCode("Security digest", "You have 1450 unread messages and 9200 followers.")).toBeNull();
  });

  it("does not take a hint word as a code word", () => {
    // "enter" and "security" turn up everywhere; neither names a code.
    expect(extractCode("Security update", "Please verify your address. Enter at gate 4500 after 18:00.")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("cleans up and lower-cases", () => {
    expect(normalizeDomain("  @Mail.Example.COM ")).toBe("mail.example.com");
    // Email Routing addresses a domain by its A-label, so an internationalised
    // name is punycoded rather than refused for not being ASCII.
    expect(normalizeDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeDomain("почта.рф")).toBe("xn--80a1acny.xn--p1ai");
  });

  it("treats empty input as 'no domain'", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain(undefined)).toBe("");
  });

  it("rejects things that are not domains", () => {
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("http://example.com")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("example..com")).toBeNull();
    expect(normalizeDomain(42)).toBeNull();
  });
});

describe("domain allow-list", () => {
  const withDomain = (MAIL_DOMAIN?: string) => ({ MAIL_DOMAIN }) as Env;

  it("accepts everything when MAIL_DOMAIN is unset or the old placeholder", () => {
    expect(allowedDomains(withDomain(undefined))).toEqual([]);
    expect(allowedDomains(withDomain("yourdomain.com"))).toEqual([]);
    expect(domainAccepted("x@anything.test", [])).toBe(true);
  });

  it("parses comma or space separated lists", () => {
    expect(allowedDomains(withDomain(" Example.com, @other.org  third.net "))).toEqual(["example.com", "other.org", "third.net"]);
  });

  it("matches the domain and its subdomains only", () => {
    const allowed = ["example.com"];
    expect(domainAccepted("a@example.com", allowed)).toBe(true);
    expect(domainAccepted("a@mail.example.com", allowed)).toBe(true);
    expect(domainAccepted("a@notexample.com", allowed)).toBe(false);
    expect(domainAccepted("a@example.com.evil.net", allowed)).toBe(false);
  });

  it("rejects malformed addresses", () => {
    expect(domainAccepted("nobody", [])).toBe(false);
    expect(domainAccepted("@example.com", [])).toBe(false);
    expect(domainAccepted("a@", [])).toBe(false);
  });
});
