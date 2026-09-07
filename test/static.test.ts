import { beforeEach, describe, expect, it } from "vitest";
import { call, freshDatabase, signIn } from "./helpers";

beforeEach(freshDatabase);

const html = { headers: { accept: "text/html,application/xhtml+xml" } };

describe("before signing in", () => {
  it("shows the sign-in page for every page URL, with a 200 and no redirect", async () => {
    for (const path of ["/", "/index.html", "/login", "/anything/else", "/app.js"]) {
      const res = await call(path, html);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain('id="setup-form"');
      expect(body, path).not.toContain('id="feed"');
    }
  });

  it("serves the files the sign-in page needs", async () => {
    for (const path of ["/style.css", "/theme.js", "/login.js", "/icon.svg", "/manifest.webmanifest"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await (await call("/style.css")).text()).toContain("--accent");
  });

  it("does not leak the app script", async () => {
    const res = await call("/app.js");
    expect(await res.text()).not.toContain("openMessage");
  });
});

describe("after signing in", () => {
  it("serves the app shell and its script", async () => {
    const cookie = await signIn();
    const page = await call("/", { cookie, ...html });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('id="feed"');
    expect(body).toContain('<script src="/app.js');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");

    const script = await call("/app.js", { cookie });
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("openMessage");
  });

  it("sends /login back to the inbox", async () => {
    const cookie = await signIn();
    for (const path of ["/login", "/login.html"]) {
      const res = await call(path, { cookie, ...html });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://mail.example.test/");
    }
  });

  it("falls back to the app for unknown pages but 404s unknown files", async () => {
    const cookie = await signIn();
    const page = await call("/some/deep/link", { cookie, ...html });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="feed"');
    expect((await call("/missing.png", { cookie })).status).toBe(404);
  });

  it("answers preflight-style OPTIONS without a body", async () => {
    const res = await call("/api/messages", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});
