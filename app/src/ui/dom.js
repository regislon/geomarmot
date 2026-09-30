/* Small DOM helpers shared by the app shell: element lookup and the status line. */

export const el = (id) => document.getElementById(id);

export function setStatus(message, isError = false) {
  const status = el("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  if (isError) console.error(message);
}
