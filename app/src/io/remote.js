/* Remote paths: turning gs:// and storage URLs into URLs the browser can read. */

const GCS_HOST = "storage.googleapis.com";

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
    const path = text.slice("gs://".length).split("/").map(encodeURIComponent).join("/");
    return proxy(`proxy/gs/${path}`);
  }
  try {
    const url = new URL(text);
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
