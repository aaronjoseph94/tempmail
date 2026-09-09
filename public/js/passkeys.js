/* Registering and removing passkeys. Signing in with one lives in login.js,
   which runs before any of these modules are loaded. */

import { $, escapeHtml, formatWhen, toast } from "./util.js";
import { api, send } from "./api.js";

const base64url = {
  toBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  },
  fromBuffer(buffer) {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

/** Whether this browser can make a passkey at all. */
function usable() {
  return typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create && isSecureContext;
}

let passkeys = [];

export async function loadPasskeys() {
  const note = $("passkey-note");
  if (!usable()) {
    $("passkey-add").hidden = true;
    note.hidden = false;
    note.textContent = "This browser cannot make passkeys. They need a recent browser on a secure connection.";
  } else {
    $("passkey-add").hidden = false;
  }
  try {
    passkeys = (await api("/api/passkeys")).passkeys;
  } catch {
    passkeys = [];
  }
  render();
}

function render() {
  $("passkey-list").innerHTML = passkeys.map((key) => `
    <div class="passkey-row">
      <svg class="icon sm" aria-hidden="true"><use href="#i-key"/></svg>
      <span class="passkey-body">
        <span class="passkey-name">${escapeHtml(key.name || "Passkey")}</span>
        <span class="passkey-when">${key.lastUsedAt ? `last used ${escapeHtml(formatWhen(key.lastUsedAt))}` : "never used yet"}</span>
      </span>
      <button type="button" class="passkey-drop" data-drop="${escapeHtml(key.id)}"
              aria-label="Remove ${escapeHtml(key.name || "this passkey")}" title="Remove this passkey">
        <svg class="icon sm"><use href="#i-trash"/></svg>
      </button>
    </div>`).join("");
}

/**
 * Makes one.
 *
 * The public key is taken from the browser's own getPublicKey(), which hands
 * it over in the format the server can import directly. A browser too old to
 * offer it is told so rather than registering something that could never be
 * checked at sign-in.
 */
export async function addPasskey() {
  if (!usable()) return;
  const button = $("passkey-add");
  button.disabled = true;
  try {
    const options = await send("POST", "/api/passkeys/options", {});
    const created = await navigator.credentials.create({
      publicKey: {
        challenge: new TextEncoder().encode(options.challenge),
        rp: options.rp,
        user: {
          id: new TextEncoder().encode(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials.map((c) => ({ type: "public-key", id: base64url.toBytes(c.id) })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        attestation: "none",
      },
    });
    if (!created) throw new Error("No passkey was made.");
    const spki = created.response.getPublicKey?.();
    if (!spki) throw new Error("This browser cannot hand over the key in a form this inbox can check.");

    passkeys = (await send("POST", "/api/passkeys", {
      id: created.id,
      challenge: options.challenge,
      publicKey: base64url.fromBuffer(spki),
      alg: created.response.getPublicKeyAlgorithm(),
      clientDataJSON: base64url.fromBuffer(created.response.clientDataJSON),
      name: passkeyName(),
    })).passkeys;
    render();
    toast("Passkey added", "i-key");
  } catch (err) {
    if (!err || (err.name !== "NotAllowedError" && err.name !== "AbortError")) {
      toast(err?.message || "That passkey could not be made.", "i-warn");
    }
  } finally {
    button.disabled = false;
  }
}

/** Something recognisable when there is more than one. */
function passkeyName() {
  const agent = navigator.userAgent;
  if (/iPhone|iPad/.test(agent)) return "iPhone or iPad";
  if (/Macintosh/.test(agent)) return "Mac";
  if (/Android/.test(agent)) return "Android";
  if (/Windows/.test(agent)) return "Windows";
  return "This device";
}

export async function onPasskeyClick(event) {
  const drop = event.target.closest("[data-drop]");
  if (!drop) return;
  try {
    passkeys = (await send("DELETE", `/api/passkeys/${encodeURIComponent(drop.dataset.drop)}`, {})).passkeys;
  } catch (err) {
    toast(err.message, "i-warn");
    return;
  }
  render();
  toast("Passkey removed", "i-trash");
}
