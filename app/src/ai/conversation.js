// @ts-check
/*
 * One conversation with the provider, and what happens when the data level changes.
 *
 * Two histories are kept. `messages` is exactly what the provider will be sent
 * — it is only ever appended to, so the provider's own blocks (thinking) go
 * back unchanged. `log` is what the chat panel shows the user, local detail
 * included.
 *
 * Lowering the level ends the provider conversation: assistant text can quote
 * data it was shown earlier, and that cannot be filtered out afterwards. The
 * request in flight is cancelled and its result discarded, and the next
 * request starts over from three things only: the system prompt, the user's own
 * typed messages, and a summary of the graph built by the app at the new level
 * (never by the model). Raising the level keeps the conversation as it is.
 */

import { gate } from "./gate/index.js";

/** @typedef {import("./providers/common.js").Message} Message */

export class Conversation {
  /**
   * @param {{ level: 1|2|3, summarize: (level: 1|2|3) => any }} options
   *   summarize builds the graph payload for a level; it is gated here.
   */
  constructor({ level, summarize }) {
    this.level = level;
    /** The highest level this provider conversation has reached, for param origins. */
    this.levelReached = level;
    this.summarize = summarize;
    /** @type {Message[]} */
    this.messages = [];
    /** @type {Array<{ kind: string, text: string, sent: boolean, detail?: any }>} */
    this.log = [];
    /** @type {string[]} */
    this.userTexts = [];
    this.restarted = false;
    this.epoch = 0;
    /** @type {AbortController|null} */
    this.controller = null;
  }

  /** Start a request: a signal that aborts when the level is lowered, and the epoch it belongs to. */
  begin() {
    this.controller?.abort();
    this.controller = new AbortController();
    return { signal: this.controller.signal, epoch: this.epoch };
  }

  /** Whether a result from `epoch` may still be used. */
  isCurrent(epoch) {
    return epoch === this.epoch;
  }

  /** Stop the request in flight, if any. */
  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  /** Change the level; lowering it ends the provider conversation. */
  setLevel(level) {
    const previous = this.level;
    this.level = level;
    if (level >= previous) {
      this.levelReached = Math.max(this.levelReached, level);
      return false;
    }
    this.stop();
    this.epoch += 1;
    this.messages = [];
    this.levelReached = level;
    this.restarted = true;
    for (const entry of this.log) entry.sent = false;
    this.log.push({
      kind: "notice",
      text: `Data level lowered to ${level}: a new conversation starts. Nothing above is sent to the model again.`,
      sent: false,
    });
    return true;
  }

  /**
   * Add the user's message and return the provider messages to send.
   * After a restart, the first message carries the user's earlier messages and
   * the gated graph summary.
   */
  addUserMessage(text) {
    this.log.push({ kind: "user", text, sent: true });
    /** @type {any[]} */
    const content = [];
    if (this.messages.length === 0) {
      if (this.restarted && this.userTexts.length) {
        content.push({
          type: "text",
          text: `Earlier in this session I asked:\n${this.userTexts.map((t) => `- ${t}`).join("\n")}`,
        });
      }
      const summary = gate("graph", this.summarize(this.level), this.level);
      content.push({
        type: "text",
        text: `The graph as it stands (data level ${this.level}):\n${JSON.stringify(summary)}`,
      });
    }
    content.push({ type: "text", text });
    this.userTexts.push(text);
    this.messages.push({ role: "user", content });
    return this.messages;
  }

  /** Append the assistant's turn exactly as the provider returned it. */
  addAssistantTurn(content, text) {
    this.messages.push({ role: "assistant", content });
    if (text) this.log.push({ kind: "assistant", text, sent: true });
  }

  /**
   * Append tool results. Each payload has already been through gate(); the
   * local detail is kept for the chat only.
   * @param {Array<{ id: string, name: string, payload: any, isError?: boolean, local?: any }>} results
   */
  addToolResults(results) {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: JSON.stringify(r.payload),
        ...(r.isError && { is_error: true }),
      })),
    });
    for (const r of results)
      this.log.push({ kind: "tool", text: r.name, sent: true, detail: { sent: r.payload, local: r.local } });
  }

  /** A note for the chat only. */
  note(kind, text) {
    this.log.push({ kind, text, sent: false });
  }
}
