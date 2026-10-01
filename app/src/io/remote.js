/* Remote paths: turning gs:// and storage URLs into URLs the browser can read. */

const GCS_HOST = "storage.googleapis.com";

/**
 * Whether a local server with the bucket proxy is behind this page. Not on a
 * static host (GitHub Pages): there gs:// paths cannot work, and storage URLs
 * are fetched directly, which succeeds only for buckets that send CORS headers.
 */
let proxyAvailable = true;
export function setProxyAvailable(available) {
  proxyAvailable = Boolean(available);
}
export const isProxyAvailable = () => proxyAvailable;

/**
 * Turn whatever the user pasted into a URL the browser can actually read.
 *
 * Cloud-storage forms are rewritten onto the local server's /proxy/gs route:
 * most buckets send no CORS headers, so a direct fetch fails in the browser no
 * matter how public the object is. Anything else is passed through untouched and succeeds or fails on
 * the remote host's own CORS policy.
 */
export function resolveUrl(input) {
  const text = input.trim();
  // Relative to the page, never rooted at "/", so the app keeps working when it
  // is served under a path prefix.
  const proxy = (path) => new URL(path, window.location.href).href;

  // A gs:// path is written the way gsutil prints it — unescaped — so its
  // segments have to be encoded. Without this, a key holding a "#" or "?" is
  // silently truncated at that character, and one holding a space produces a
  // URL the proxy cannot forward.
  if (text.startsWith("gs://")) {
    if (!proxyAvailable) {
      throw new Error("gs:// paths need the local server (the geomarmot command); this copy of the app has none.");
    }
    const path = text.slice("gs://".length).split("/").map(encodeURIComponent).join("/");
    return proxy(`proxy/gs/${path}`);
  }
  try {
    const url = new URL(text);
    if (!proxyAvailable) return url.href;
    if (url.hostname === GCS_HOST) {
      return proxy(`proxy/gs${url.pathname}`);
    }
    if (url.hostname.endsWith(`.${GCS_HOST}`)) {
      const bucket = url.hostname.slice(0, -(GCS_HOST.length + 1));
      return proxy(`proxy/gs/${bucket}${url.pathname}`);
    }
    return url.href;
  } catch {
    throw new Error(`"${text}" is not a URL or a gs:// path.`);
  }
}
