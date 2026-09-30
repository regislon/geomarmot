/*
 * The assistant drawer: a toolbar button opens it beside the canvas, its gear
 * opens the settings. The conversation itself lives in ui/assistant/chat.js.
 */

import { initAssistantSettings } from "./settings-modal.js";

export function initAssistant() {
  const drawer = document.getElementById("assistant");
  const settings = initAssistantSettings();
  document.getElementById("btn-assistant").addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
  });
  document.getElementById("assistant-close").addEventListener("click", () => (drawer.hidden = true));
  document.getElementById("assistant-settings").addEventListener("click", () => settings.open());
  return { drawer, settings };
}
