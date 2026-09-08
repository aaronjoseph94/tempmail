/* The fetch wrapper: JSON in, JSON out, and what a 401 means. */

import { CACHE_KEY } from "./state.js";
import { store } from "./util.js";
import { dropLive } from "./data.js";

/* -------------------------------------------------------------------- api */

export async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    signedOut();
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function send(method, path, body) {
  return api(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function signedOut() {
  dropLive();
  store.remove(CACHE_KEY);
  location.replace("/");
}
