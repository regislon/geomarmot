/*
 * "Sign in with Google", for reading buckets where no local server is behind
 * the page (the GitHub Pages demo).
 *
 * Google's own sign-in (Google Identity Services) shows its consent screen and
 * hands the page a read-only Cloud Storage token for about an hour. The token
 * is kept in memory only — never in storage, a saved graph or a URL — and is
 * sent only to storage.googleapis.com, as a header. Its JSON API accepts
 * requests from any page, whatever the bucket's CORS settings.
 *
 * The OAuth client ID is not a secret: it names this site to Google. It comes
 * from the build (VITE_GOOGLE_CLIENT_ID) or is typed into the connector once.
 * Google's script is loaded only when this connector is used, so the app
 * still works offline otherwise.
 */

import { prefs, savePrefs } from "./prefs.js";

const SCRIPT = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
export const STORAGE_API = "https://storage.googleapis.com/storage/v1";

let token = null; // { value, expires }
let client = null;
let clientFor = "";
let loading = null;

export const builtInClientId = () => import.meta.env?.VITE_GOOGLE_CLIENT_ID || "";
export const clientId = () => builtInClientId() || prefs().gcs?.clientId || "";

export function setClientId(id) {
  savePrefs({ gcs: { ...prefs().gcs, clientId: id.trim() } });
}

export const signedIn = () => Boolean(token && token.expires > Date.now() + 60_000);

/** Load Google's script ahead of the click: the consent popup must open within the click itself. */
export function prepareSignIn() {
  if (!clientId()) return Promise.resolve(false);
  loading ||= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load Google's sign-in. Is the network blocked?"));
    };
    document.head.appendChild(script);
  });
  return loading.then(() => true);
}

let pending = null; // the signIn() call the token client answers next

/** Open Google's consent popup; resolves once a token is in hand. Call it from a click. */
export function signIn() {
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) return Promise.reject(new Error("Google's sign-in is still loading; try again in a moment."));
  if (!client || clientFor !== clientId()) {
    clientFor = clientId();
    client = oauth2.initTokenClient({
      client_id: clientFor,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) return pending?.reject(new Error(response.error_description || response.error));
        token = { value: response.access_token, expires: Date.now() + Number(response.expires_in || 3600) * 1000 };
        pending?.resolve();
      },
      error_callback: (error) => pending?.reject(new Error(error?.message || "Sign-in was cancelled.")),
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client.requestAccessToken({ prompt: "" });
  });
}

export function signOut() {
  if (token) window.google?.accounts?.oauth2?.revoke(token.value, () => {});
  token = null;
}

/** A Cloud Storage JSON API request with the token as a header. */
export async function storageFetch(url) {
  if (!signedIn()) throw new Error("Sign in with Google first.");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
  if (response.status === 401) {
    token = null;
    throw new Error("Your Google sign-in has expired. Sign in again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return response;
}
