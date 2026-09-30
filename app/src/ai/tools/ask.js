// @ts-check
export default {
  name: "ask_user",
  description:
    "Ask the user a question when the request is ambiguous and the data cannot answer it (for example which of two " +
    "columns holds the easting). Offer choices when there are a few obvious answers; an empty list asks for free text.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["question", "choices"],
    properties: {
      question: { type: "string", maxLength: 500 },
      choices: { type: "array", maxItems: 6, items: { type: "string", maxLength: 100 } },
    },
  },
  async run({ question, choices }, { askUser }) {
    const answer = await askUser(question, choices);
    return { type: "answer", payload: { answer: String(answer).slice(0, 4000) } };
  },
};
