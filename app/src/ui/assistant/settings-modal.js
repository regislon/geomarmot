/*
 * The assistant settings: provider, route, model, key, effort and data level.
 *
 * The dialog edits a draft and writes it on Save, so closing it half-way
 * changes nothing — in particular, the data level (which ends the conversation
 * when lowered) only changes on Save.
 */

import { ADAPTERS } from "../../ai/provider.js";
import { forgetKey, isRemembered, loadKey, saveKey } from "../../ai/keys.js";
import { EFFORTS, getSettings, updateSettings } from "../../ai/settings.js";
import { serverProviders } from "../../ai/providers/local.js";
import { h } from "../inspector/widgets.js";

const PROVIDERS = [
  { value: "anthropic", label: "Claude (Anthropic)" },
  { value: "openai", label: "OpenAI" },
];

const NO_SERVER_KEY = "No key is set on a local server for this provider.";

const LEVEL_TEXT = {
  1: "Schema only — column names and types, row counts, CRS, and error codes. No values leave the browser.",
  2: "Adds per-column statistics — min, max, share of nulls, distinct count, extent, up to 5 top values.",
  3: "Adds up to 20 sample rows, preview rows and raw error messages.",
};

function field(label, control, note = null) {
  return h("label", { class: "ai-field" }, [
    h("span", { class: "ai-label", text: label }),
    control,
    ...(note !== null ? [h("span", { class: "muted ai-note", text: note })] : []),
  ]);
}

function radios(name, options, value, onChange) {
  return h(
    "div",
    { class: "ai-radios" },
    options.map((option) => {
      const input = h("input", { type: "radio", name, value: option.value });
      input.checked = String(option.value) === String(value);
      input.disabled = Boolean(option.disabled);
      input.addEventListener("change", () => onChange(option.value));
      return h("label", { class: option.disabled ? "muted" : "" }, [input, h("span", { text: ` ${option.label}` })]);
    }),
  );
}

export function initAssistantSettings() {
  const modal = document.getElementById("ai-settings-modal");
  const body = document.getElementById("ai-settings-body");
  let draft;
  let keyDraft;
  let rememberDraft;
  let available = { anthropic: false, openai: false };
  /** OpenAI's models for the current key: null until asked, then a list, or an error message. */
  let openaiModels = null;
  let modelsNote = "";
  let modelSlot = null;
  let typingModel = false;

  const keyInHand = () => keyDraft || loadKey(draft.provider);

  /** Ask OpenAI which models this key can use; only the model field re-renders. */
  async function fetchOpenAiModels() {
    const key = keyInHand();
    if (draft.provider !== "openai" || draft.transport !== "browser" || !key) return;
    modelsNote = "Reading your models…";
    fillModel();
    try {
      openaiModels = await ADAPTERS.openai.listModels(key);
      modelsNote = openaiModels.length ? "" : "This key lists no chat models.";
      if (!draft.model && openaiModels.length) draft.model = openaiModels[0];
    } catch (err) {
      openaiModels = null;
      modelsNote = `Could not list your models (${err.message}); type a model name.`;
    }
    fillModel();
  }

  function fillModel() {
    if (!modelSlot) return;
    const adapter = ADAPTERS[draft.provider];
    const list = draft.provider === "anthropic" ? adapter.MODELS : openaiModels || [];
    let control;
    if (list.length && !typingModel) {
      const options = [...list];
      if (draft.model && !options.includes(draft.model)) options.unshift(draft.model);
      control = h(
        "select",
        {
          id: "ai-model",
          onchange: (e) => {
            if (e.target.value === "__other") {
              typingModel = true;
              fillModel();
            } else draft.model = e.target.value;
          },
        },
        [
          ...options.map((m) => {
            const option = h("option", { value: m, text: m });
            option.selected = m === draft.model;
            return option;
          }),
          h("option", { value: "__other", text: "Other…" }),
        ],
      );
    } else {
      control = h("input", {
        id: "ai-model",
        type: "text",
        value: draft.model,
        placeholder:
          draft.provider === "openai" && !keyInHand() ? "add your API key below to list your models" : "model name",
        oninput: (e) => (draft.model = e.target.value.trim()),
      });
    }
    modelSlot.replaceChildren(
      control,
      ...(modelsNote ? [h("span", { class: "muted ai-note", text: modelsNote })] : []),
    );
  }

  function render() {
    const serverOk = available[draft.provider];
    const model = h("div", { class: "ai-model" });
    modelSlot = model;
    fillModel();
    const key = h("input", {
      id: "ai-key",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: loadKey(draft.provider) ? "•••••••• (saved)" : "paste an API key",
      oninput: (e) => (keyDraft = e.target.value),
      onchange: () => fetchOpenAiModels(),
    });
    const remember = h("input", { id: "ai-remember", type: "checkbox" });
    remember.checked = rememberDraft;
    remember.addEventListener("change", () => (rememberDraft = remember.checked));
    const forget = h("button", {
      id: "ai-forget",
      text: "Forget key",
      onclick: (event) => {
        event.preventDefault();
        forgetKey(draft.provider);
        keyDraft = "";
        render();
      },
    });
    body.replaceChildren(
      field(
        "Provider",
        radios("ai-provider", PROVIDERS, draft.provider, (value) => {
          draft.provider = value;
          draft.model = ADAPTERS[value].DEFAULT_MODEL;
          keyDraft = "";
          rememberDraft = isRemembered(value);
          openaiModels = null;
          modelsNote = "";
          typingModel = false;
          render();
          fetchOpenAiModels();
        }),
      ),
      field(
        "Route",
        radios(
          "ai-transport",
          [
            { value: "browser", label: "From this browser, with my key" },
            { value: "server", label: "Through the local server (its key)", disabled: !serverOk },
          ],
          draft.transport,
          (value) => {
            draft.transport = value;
            render();
          },
        ),
        serverOk ? "" : NO_SERVER_KEY,
      ),
      field("Model", model),
      ...(draft.provider === "anthropic"
        ? [
            field(
              "Effort",
              h(
                "select",
                { id: "ai-effort", onchange: (e) => (draft.effort = e.target.value) },
                EFFORTS.map((effort) => {
                  const option = h("option", { value: effort, text: effort });
                  option.selected = effort === draft.effort;
                  return option;
                }),
              ),
              "Higher effort thinks longer and costs more.",
            ),
          ]
        : []),
      ...(draft.transport === "browser"
        ? [
            field("API key", key, "Kept in this tab only, unless you choose to remember it on this device."),
            h("div", { class: "ai-key-row" }, [
              h("label", {}, [remember, h("span", { text: " Remember on this device" })]),
              forget,
            ]),
          ]
        : []),
      field(
        "What the assistant may see",
        radios(
          "ai-level",
          [1, 2, 3].map((level) => ({ value: level, label: `Level ${level}: ${LEVEL_TEXT[level]}` })),
          draft.level,
          (value) => (draft.level = Number(value)),
        ),
        "Lowering the level starts a new conversation that carries none of the earlier data.",
      ),
    );
  }

  async function open() {
    draft = getSettings();
    keyDraft = "";
    rememberDraft = isRemembered(draft.provider);
    typingModel = false;
    modal.hidden = false;
    render();
    fetchOpenAiModels();
    available = await serverProviders();
    // Only the route option depends on the answer. Re-rendering the form here would replace the
    // key field under the user's typing, and what they had typed would be lost.
    if (!modal.hidden) showServerRoute();
  }

  function showServerRoute() {
    const server = body.querySelector('input[name="ai-transport"][value="server"]');
    if (!server) return;
    const ok = available[draft.provider];
    server.disabled = !ok;
    server.parentElement.classList.toggle("muted", !ok);
    const note = server.closest(".ai-field")?.querySelector(".ai-note");
    if (note) note.textContent = ok ? "" : NO_SERVER_KEY;
  }

  function save() {
    if (draft.transport === "browser" && (keyDraft || rememberDraft !== isRemembered(draft.provider))) {
      saveKey(draft.provider, keyDraft || loadKey(draft.provider), { remember: rememberDraft });
    }
    updateSettings(draft);
    modal.hidden = true;
  }

  document.getElementById("ai-settings-save").addEventListener("click", save);
  document.getElementById("ai-settings-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
  return { open };
}
