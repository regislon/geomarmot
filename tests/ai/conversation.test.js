import { describe, test, expect } from "vitest";
import { Conversation } from "../../app/src/ai/conversation.js";

const CANARY = "CANARY-row-21";
const summarize = (level) => ({ level, sources: [], nodes: [], edges: [] });

describe("Conversation", () => {
  test("the first message carries the gated graph summary; later ones do not", () => {
    const c = new Conversation({ level: 1, summarize });
    c.addUserMessage("make points");
    expect(c.messages[0].content[0].text).toContain('"level":1');
    c.addAssistantTurn([{ type: "text", text: "ok" }], "ok");
    c.addUserMessage("thanks");
    expect(c.messages[2].content).toEqual([{ type: "text", text: "thanks" }]);
  });

  test("assistant turns are appended exactly as returned", () => {
    const c = new Conversation({ level: 3, summarize });
    c.addUserMessage("hi");
    const turn = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "hello" },
    ];
    c.addAssistantTurn(turn, "hello");
    expect(c.messages[1].content).toBe(turn);
  });

  test("lowering the level ends the conversation and cancels the request in flight", () => {
    const c = new Conversation({ level: 3, summarize });
    c.addUserMessage("show me rows");
    c.addAssistantTurn([{ type: "text", text: `I saw ${CANARY}` }], `I saw ${CANARY}`);
    c.addToolResults([{ id: "t1", name: "sample", payload: { rows: [[CANARY]] } }]);
    const { signal, epoch } = c.begin();
    expect(c.setLevel(1)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(c.isCurrent(epoch)).toBe(false);
    expect(c.levelReached).toBe(1);

    const sent = JSON.stringify(c.addUserMessage("now filter it"));
    expect(sent).not.toContain(CANARY);
    expect(sent).toContain("show me rows");
    expect(sent).toContain("data level 1");
    expect(c.messages).toHaveLength(1);
    expect(c.log.filter((e) => e.text.includes(CANARY)).every((e) => !e.sent)).toBe(true);
  });

  test("raising the level keeps the conversation", () => {
    const c = new Conversation({ level: 1, summarize });
    c.addUserMessage("hi");
    c.addAssistantTurn([{ type: "text", text: "hello" }], "hello");
    expect(c.setLevel(3)).toBe(false);
    expect(c.messages).toHaveLength(2);
    expect(c.levelReached).toBe(3);
  });

  test("a summary that breaks the level's schema is refused", () => {
    const c = new Conversation({
      level: 1,
      summarize: () => ({ level: 1, sources: [], nodes: [], edges: [], rows: [[CANARY]] }),
    });
    expect(() => c.addUserMessage("hi")).toThrow(/privacy gate/);
  });
});
