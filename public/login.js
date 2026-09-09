/* Sign-in and first-run setup. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const errorBox = $("gate-error");
  const loginForm = $("login-form");
  const setupForm = $("setup-form");

  function showError(text) {
    if (!text) {
      errorBox.hidden = true;
      return;
    }
    errorBox.innerHTML = '<svg class="icon sm" aria-hidden="true"><use href="#i-warn"/></svg><span></span>';
    errorBox.querySelector("span").textContent = text;
    errorBox.hidden = false;
    // Re-trigger the shake even when the same message comes back twice.
    errorBox.style.animation = "none";
    void errorBox.offsetWidth;
    errorBox.style.animation = "";
  }

  /** Disables the form and spins the submit button while a request is out.
      The label is matched by class so the spinner, which is also a span,
      can never be mistaken for it. */
  function setBusy(form, busy) {
    for (const el of form.elements) el.disabled = busy;
    const button = form.querySelector('button[type="submit"]');
    const label = button.querySelector(".label");
    label.hidden = busy;
    button.querySelector(".spinner")?.remove();
    if (busy) button.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function submit(form, path, body) {
    showError("");
    setBusy(form, true);
    try {
      await post(path, body);
      location.replace("/");
    } catch (err) {
      showError(err.message);
      setBusy(form, false);
      form.querySelector("input").focus();
    }
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(loginForm, "/api/login", { password: $("login-password").value });
  });

  setupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = $("setup-password").value;
    if (password !== $("setup-confirm").value) {
      showError("The passwords don't match.");
      $("setup-confirm").focus();
      return;
    }
    submit(setupForm, "/api/setup", { password, mailDomain: $("setup-domain").value.trim() });
  });

  // Reveal toggles, shared by both forms.
  for (const button of document.querySelectorAll("[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.reveal);
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      button.querySelector("use").setAttribute("href", shown ? "#i-eye" : "#i-eye-off");
      button.setAttribute("aria-label", shown ? "Show password" : "Hide password");
      input.focus();
    });
  }

  /* A rough four-step strength read: length carries most of the weight,
     with a nudge for mixing character classes. It only guides the choice —
     the server enforces the actual minimum. */
  function strengthOf(password) {
    if (!password) return 0;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (classes >= 3 && password.length >= 8) score += 1;
    return Math.min(4, score);
  }

  const STRENGTH_TEXT = [
    "Use at least 8 characters.",
    "Weak — longer is better than complicated.",
    "Fair. A few more words would help.",
    "Good.",
    "Strong.",
  ];

  $("setup-password").addEventListener("input", (e) => {
    const level = strengthOf(e.target.value);
    $("strength").dataset.level = String(level);
    $("strength-text").textContent = STRENGTH_TEXT[level];
  });

  /** A sensible first guess: mail.example.com → example.com. */
  function guessDomain() {
    const host = location.hostname;
    if (!host.includes(".") || host.endsWith(".workers.dev") || /^[\d.]+$/.test(host)) return "";
    return host.replace(/^(mail|inbox|www|app|temp|tempmail)\./, "");
  }

  function show(form) {
    $("gate-loading").hidden = true;
    form.hidden = false;
    $("gate-foot").hidden = false;
    form.querySelector("input").focus();
  }

  /* The site's name is a server setting, so a fork renames itself without
     touching this file. It rides on /api/status because the sign-in screen
     has to show it before any session exists, and that call already happens. */
  function applyBrand(name) {
    if (!name) return;
    const slot = $("brand-name");
    if (slot) slot.textContent = name;
    document.title = `${name} \u00b7 sign in`;
  }

  /* ------------------------------------------------------------ passkeys */

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

  const passkeysUsable = () =>
    typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.get && isSecureContext;

  /**
   * Signs in with a passkey.
   *
   * The challenge is the server's own signed string, sent as bytes: the
   * authenticator signs over it, and the server checks its own signature on
   * the way back rather than having stored anything in the meantime.
   */
  async function signInWithPasskey() {
    const button = $("passkey-btn");
    showError("");
    button.disabled = true;
    try {
      const options = await post("/api/webauthn/login/options", {});
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: new TextEncoder().encode(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: "preferred",
          allowCredentials: options.allowCredentials.map((c) => ({ type: "public-key", id: base64url.toBytes(c.id) })),
        },
      });
      if (!assertion) throw new Error("No passkey was offered.");
      await post("/api/webauthn/login", {
        id: assertion.id,
        challenge: options.challenge,
        clientDataJSON: base64url.fromBuffer(assertion.response.clientDataJSON),
        authenticatorData: base64url.fromBuffer(assertion.response.authenticatorData),
        signature: base64url.fromBuffer(assertion.response.signature),
      });
      location.replace("/");
    } catch (err) {
      // A cancelled prompt is a decision, not a failure worth shouting about.
      if (err && (err.name === "NotAllowedError" || err.name === "AbortError")) showError("");
      else showError(err.message || "That passkey did not work.");
      button.disabled = false;
    }
  }

  $("passkey-btn").addEventListener("click", signInWithPasskey);

  fetch("/api/status")
    .then((res) => res.json())
    .then((status) => {
      applyBrand(status.brandName);
      if (status.authed) {
        location.replace("/");
      } else if (status.setupRequired) {
        $("setup-domain").value = guessDomain();
        show(setupForm);
      } else {
        show(loginForm);
        $("passkey-btn").hidden = !(status.passkeys > 0 && passkeysUsable());
      }
    })
    .catch(() => show(loginForm));
})();
