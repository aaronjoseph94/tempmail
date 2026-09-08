import { beforeEach, describe, expect, it } from "vitest";
import { call, freshDatabase, signIn } from "./helpers";

beforeEach(freshDatabase);

const html = { headers: { accept: "text/html,application/xhtml+xml" } };

describe("before signing in", () => {
  it("shows the sign-in page for every page URL, with a 200 and no redirect", async () => {
    for (const path of ["/", "/index.html", "/login", "/anything/else", "/js/main.js"]) {
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

  it("serves the fonts the sign-in page asks for", async () => {
    // style.css is public, so the faces it references must be too. A missing
    // entry in PUBLIC_FILES does not 404 — it falls through to the app shell,
    // so the browser gets HTML where it wanted a font and only the sign-in
    // screen quietly loses the typeface.
    const css = await (await call("/style.css")).text();
    const referenced = [...css.matchAll(/url\("(\/fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type") ?? "", path).not.toContain("text/html");
    }
  });

  it("does not leak the app's modules", async () => {
    // The app is a module graph now, and every file in it is signed-in only.
    // A missing PUBLIC_FILES entry does not 404, it falls through to the
    // sign-in page, so this asserts on the content rather than on the status.
    for (const name of ["main", "state", "util", "api", "data", "render", "viewer", "inbox", "settings", "keys"]) {
      const body = await (await call(`/js/${name}.js`)).text();
      expect(body, name).not.toContain("openMessage");
      expect(body.toLowerCase(), name).toContain("<!doctype html>");
    }
  });
});

describe("after signing in", () => {
  it("serves the app shell and its script", async () => {
    const cookie = await signIn();
    const page = await call("/", { cookie, ...html });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('id="feed"');
    expect(body).toContain('<script type="module" src="/js/main.js');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");

    // The entry point and one module it reaches only by import, so a broken
    // specifier shows up here rather than as a blank page in the browser.
    const entry = await call("/js/main.js", { cookie });
    expect(entry.status).toBe(200);
    const source = await entry.text();
    expect(source).toContain('from "./viewer.js"');

    const viewer = await call("/js/viewer.js", { cookie });
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain("export async function openMessage");
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
