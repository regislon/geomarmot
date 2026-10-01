/* The rows of a connector's file list, shared by the folder and the bucket. */

export function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function row(icon, label, detail, onClick, disabled = false) {
  const item = document.createElement("button");
  item.className = `browse-row${disabled ? " disabled" : ""}`;
  item.disabled = disabled;
  item.innerHTML = `<span class="browse-icon">${icon}</span><span class="browse-name"></span><span class="browse-detail"></span>`;
  item.querySelector(".browse-name").textContent = label;
  item.querySelector(".browse-detail").textContent = detail;
  if (onClick) item.addEventListener("click", onClick);
  return item;
}

/** Path segments as buttons: [["Buckets", go], ["gs://b", go], …]. */
export function breadcrumb(bar, crumbs) {
  bar.replaceChildren();
  crumbs.forEach(([label, go], index) => {
    if (index) bar.appendChild(document.createTextNode("/"));
    const button = document.createElement("button");
    button.className = "crumb";
    button.textContent = label;
    button.addEventListener("click", go);
    bar.appendChild(button);
  });
}

export function setNote(note, message, isError = false) {
  note.textContent = message || "";
  note.classList.toggle("error", Boolean(isError));
}
