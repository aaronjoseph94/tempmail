/**
 * Web Push, with nothing but WebCrypto.
 *
 * Two standards do the work. VAPID (RFC 8292) proves to the push service
 * that this Worker owns the subscription: an ES256-signed JWT plus the
 * public key. The payload itself is sealed for the browser with the
 * aes128gcm scheme of RFC 8291 / RFC 8188: an ephemeral ECDH key agreed
 * against the subscription's key, HKDF for the content key and nonce,
 * then AES-128-GCM.
 *
 * The VAPID key pair is created once and kept in settings, like the
 * session secret.
 */

import { getSetting, SETTING_VAPID_PRIVATE, SETTING_VAPID_PUBLIC, setSettingIfAbsent } from "./db";
import type { Env } from "./index";

export interface PushPayload {
  id: string;
  address: string;
  code: string | null;
  from: string;
  subject: string;
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/* ---------------------------------------------------------------- bytes */

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

/**
 * workers-types spells the ECDH "public" parameter "$public" (a reserved
 * word workaround); the runtime wants "public". This keeps both happy.
 */
function ecdhWith(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

/* ---------------------------------------------------------------- VAPID */

export interface VapidKeys {
  /** Raw uncompressed public key (65 bytes), base64url. What the browser subscribes with. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** The instance's VAPID key pair, created on first use. */
export async function getVapidKeys(env: Env): Promise<VapidKeys> {
  let pub = await getSetting(env.DB, SETTING_VAPID_PUBLIC);
  let priv = await getSetting(env.DB, SETTING_VAPID_PRIVATE);
  if (!pub || !priv) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    // First writer wins; everyone then reads back the same pair.
    await setSettingIfAbsent(env.DB, SETTING_VAPID_PRIVATE, JSON.stringify(jwk));
    await setSettingIfAbsent(env.DB, SETTING_VAPID_PUBLIC, base64url(raw));
    pub = await getSetting(env.DB, SETTING_VAPID_PUBLIC);
    priv = await getSetting(env.DB, SETTING_VAPID_PRIVATE);
    if (!pub || !priv) throw new Error("could not create the push keys");
  }
  return { publicKey: pub, privateJwk: JSON.parse(priv) as JsonWebKey };
}

/** `Authorization: vapid t=<jwt>, k=<key>` for one push service origin. */
export async function vapidAuthorization(keys: VapidKeys, audience: string, subject: string): Promise<string> {
  const header = base64url(text(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(text(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA output is already the raw r||s that JWS wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text(signingInput));
  return `vapid t=${signingInput}.${base64url(signature)}, k=${keys.publicKey}`;
}

/* ----------------------------------------------------------- encryption */

/** Seals `plaintext` for one subscription: the aes128gcm body of RFC 8291. */
export async function encryptPayload(subscription: Subscription, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromBase64url(subscription.p256dh);
  const authSecret = fromBase64url(subscription.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("malformed subscription keys");

  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits(ecdhWith(uaKey), local.privateKey, 256);

  // IKM = HKDF(salt = auth, ikm = shared, info = "WebPush: info" || 0 || ua_public || as_public)
  const ikm = await hkdf(shared, authSecret, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, text("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([2]));   // 0x02: this is the last record
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function hkdf(ikm: ArrayBuffer | Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/* -------------------------------------------------------------- sending */

/** True when at least one browser has asked for pushes. */
export async function anySubscriptions(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS one FROM push_subscriptions LIMIT 1").first();
  return !!row;
}

/**
 * Pushes one payload to every subscription. Endpoints that answer 404 or
 * 410 are gone for good and are forgotten; other failures are logged.
 */
export async function sendPush(env: Env, payload: PushPayload): Promise<{ sent: number; dropped: number; failed: number }> {
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<Subscription>();
  if (!results.length) return { sent: 0, dropped: 0, failed: 0 };
  const keys = await getVapidKeys(env);
  const body = text(JSON.stringify(payload));
  const subject = `mailto:postmaster@${payload.address.split("@")[1] ?? "localhost"}`;
  const tally = { sent: 0, dropped: 0, failed: 0 };

  await Promise.all(results.map(async (sub) => {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuthorization(keys, new URL(sub.endpoint).origin, subject),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "120",
          urgency: "high",
        },
        body: await encryptPayload(sub, body),
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(sub.endpoint).run();
        tally.dropped++;
      } else if (res.ok) {
        tally.sent++;
      } else {
        console.warn("push rejected", res.status, sub.endpoint.slice(0, 60));
        tally.failed++;
      }
    } catch (err) {
      console.warn("push failed", err);
      tally.failed++;
    }
  }));
  return tally;
}
