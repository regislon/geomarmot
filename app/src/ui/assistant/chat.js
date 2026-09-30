/*
 * The assistant's chat: the conversation log, the message box, ask_user
 * questions, and the draft bar with Apply and Discard.
 *
 * The log shows the user everything, including what stayed local: each tool
 * call can be opened to see exactly what was sent to the model and, where it
 * differs, what the app kept to itself.
 */

import { runTurn } from "../../ai/agent.js";
import { Conversation } from "../../ai/conversation.js";
import { summarizeGraph } from "../../ai/context.js";
import { clearDraft, draft, hasDraft, onDraftChange } from "../../ai/draft.js";
import { loadKey } from "../../ai/keys.js";
import { getSettings, onSettingsChange } from "../../ai/settings.js";
import { h } from "../inspector/widgets.js";

/**
 * @param {{ world: any, applyDraft: () => void }} options
 */
export function initChat({ world, applyDraft }) {
  const log = document.getElementById("assistant-log");
  const form = document.getElementById("assistant-form");
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("assistant-input"));
  const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("assistant-send"));
  const stopButton = document.getElementById("assistant-stop");
  const levelBadge = document.getElementById("assistant-level");

  let conversation = null;
  let running = false;
  /** @type {null | { question: string, choices: string[], resolve: (answer: string) => void }} */
  let pendingQuestion = null;

  const current = () => {
    if (!conversation) {
      conversation = new Conversation({
        level: getSettings().level,
        summarize: (level) => summarizeGraph(world, level),
      });
    }
    return conversation;
  };

  function showLevel() {
    levelBadge.textContent = `level ${getSettings().level}`;
    levelBadge.title = "What the assistant may see; change it in the settings.";
  }

  function toolEntry(entry) {
    const sent = JSON.stringify(entry.detail?.sent ?? null, null, 2);
    const local = entry.detail?.local;
    const localText = local === undefined ? null : typeof local === "string" ? local : JSON.stringify(local, null, 2);
    const children = [
      h("summary", { text: entry.text }),
      h("div", { class: "muted", text: "Sent to the model:" }),
      h("pre", { text: sent }),
    ];
    if (localText && localText !== sent) {
      children.push(
        h("div", { class: "local-only", text: "Kept in this browser (not sent):" }),
        h("pre", { text: localText }),
      );
    }
    return h("details", { class: `chat-tool${entry.retired ? " unsent" : ""}` }, children);
  }

  function questionCard() {
    const q = pendingQuestion;
    const answer = (text) => {
      pendingQuestion = null;
      q.resolve(text);
      render();
    };
    const free = h("input", { type: "text", placeholder: "Your answer" });
    return h("div", { class: "chat-msg assistant question" }, [
      h("div", { text: q.question }),
      h(
        "div",
        { class: "assistant-actions" },
        q.choices.map((choice) => h("button", { text: choice, onclick: () => answer(choice) })),
      ),
      h("div", { class: "assistant-actions" }, [
        free,
        h("button", { text: "Answer", onclick: () => free.value.trim() && answer(free.value.trim()) }),
      ]),
    ]);
  }

  function draftBar() {
    const names = draft.nodes.map((node) => `${node.type} (${node.id})`).join(", ");
    return h("div", { class: "draft-bar", id: "draft-bar" }, [
      h("span", { text: `Draft: ${names || `${draft.edges.length} connection(s)`}` }),
      h("span", { class: "spacer" }),
      h("button", { id: "draft-discard", text: "Discard", onclick: () => clearDraft() }),
      h("button", { id: "draft-apply", class: "primary", text: "Apply", onclick: () => applyDraft() }),
    ]);
  }

  function render() {
    const entries = conversation?.log || [];
    const children = entries.map((entry) =>
      entry.kind === "tool"
        ? toolEntry(entry)
        : h("div", {
            class: `chat-msg ${entry.kind}${entry.retired ? " unsent" : ""}`,
            text: entry.text,
            title: entry.retired ? "Not sent to the model after the data level was lowered" : null,
          }),
    );
    if (!entries.length) {
      children.push(
        h("p", {
          class: "muted",
          text: "Describe what you want to do with your data. The assistant proposes nodes as a draft; nothing changes until you apply it.",
        }),
      );
    }
    if (pendingQuestion) children.push(questionCard());
    if (hasDraft()) children.push(draftBar());
    log.replaceChildren(...children);
    log.scrollTop = log.scrollHeight;
    sendButton.disabled = running;
    stopButton.hidden = !running;
  }

  function askUser(question, choices) {
    return new Promise((resolve) => {
      pendingQuestion = { question, choices, resolve };
      render();
    });
  }

  async function submit(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || running) return;
    const settings = getSettings();
    const key = settings.transport === "browser" ? loadKey(settings.provider) : "";
    input.value = "";
    running = true;
    render();
    try {
      await runTurn(current(), text, { settings, key, world, askUser, onUpdate: render });
    } catch (err) {
      current().note("error", err.message || String(err));
    } finally {
      running = false;
      render();
    }
  }

  form.addEventListener("submit", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
  });
  stopButton.addEventListener("click", () => {
    conversation?.stop();
    if (pendingQuestion) {
      pendingQuestion.resolve("(the user stopped the request)");
      pendingQuestion = null;
    }
  });
  onSettingsChange((next, previous) => {
    showLevel();
    if (conversation && next.level !== previous.level) {
      const restarted = conversation.setLevel(next.level);
      if (restarted && pendingQuestion) {
        pendingQuestion.resolve("");
        pendingQuestion = null;
      }
      render();
    }
  });
  onDraftChange(render);
  showLevel();
  render();
  return { render, conversation: () => conversation };
}
