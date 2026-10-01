/*
 * Toolbar menus: a button that opens a short list of actions.
 *
 * Opens on click or with the arrow keys, closes on Escape, on a click outside
 * or after an item runs; Up and Down move between items. Built on plain
 * buttons with menu roles, so screen readers announce it as a menu.
 */

import { el } from "./dom.js";

const menus = [];

function closeAll(except = null) {
  for (const menu of menus) if (menu !== except) menu.close();
}

/**
 * @param {string} buttonId
 * @param {string} listId
 * @param {Record<string, () => void>} actions  item id → what it does
 */
export function initMenu(buttonId, listId, actions) {
  const button = el(buttonId);
  const list = el(listId);
  const items = () => [...list.querySelectorAll('[role="menuitem"]:not([disabled])')];

  const menu = {
    open(focusFirst = false) {
      closeAll(menu);
      list.hidden = false;
      button.setAttribute("aria-expanded", "true");
      if (focusFirst) items()[0]?.focus();
    },
    close() {
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
    },
  };
  menus.push(menu);

  button.addEventListener("click", () => (list.hidden ? menu.open() : menu.close()));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      menu.open(true);
    }
  });
  list.addEventListener("keydown", (event) => {
    const all = items();
    const index = all.indexOf(document.activeElement);
    if (event.key === "ArrowDown") all[(index + 1) % all.length]?.focus();
    else if (event.key === "ArrowUp") all[(index - 1 + all.length) % all.length]?.focus();
    else if (event.key === "Escape") {
      menu.close();
      button.focus();
    } else return;
    event.preventDefault();
  });
  for (const [id, run] of Object.entries(actions)) {
    el(id).addEventListener("click", () => {
      menu.close();
      run();
    });
  }
  return menu;
}

// One listener for every menu: a click outside, or Escape, closes whatever is open.
document.addEventListener("click", (event) => {
  if (!event.target.closest?.(".menu")) closeAll();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAll();
});
