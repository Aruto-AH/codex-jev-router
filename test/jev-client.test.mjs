import test from "node:test";
import assert from "node:assert/strict";
import { askJev, buildJevRequest } from "../src/jev-client.mjs";

const models = [
  { id: "gpt-6-luna", tier: "fast", description: "fast model" },
  { id: "gpt-6-sol", tier: "strong", description: "strong model" },
];

test("builds a typed Jev request from the current Codex context", () => {
  const request = buildJevRequest({
    prompt: "Fix the authentication bug",
    currentModel: "gpt-6-sol",
    contextTokens: 1200,
    models,
  });

  assert.equal(request.state.request, "Fix the authentication bug");
  assert.equal(request.state.session.current_model, "gpt-6-sol");
  assert.deepEqual(request.state.environment.available_models, ["gpt-6-luna", "gpt-6-sol"]);
  assert.equal(request.questions.model.type, "choice");
  assert.equal(request.questions.reasoning_required.type, "score");
});

test("normalizes typed Jev answers into a routing decision", async () => {
  let received;
  const decision = await askJev({
    prompt: "Fix the authentication bug",
    currentModel: "gpt-6-luna",
    contextTokens: 1200,
    models,
    client: {
      systemOne: async (request) => {
        received = request;
        return {
          answers: {
            model: { choice: "gpt-6-sol", confidence: 0.91 },
            task_complexity: { score: 7 },
            reasoning_required: { score: 8 },
            tool_complexity: { score: 5 },
          },
        };
      },
    },
  });

  assert.equal(received.state.request, "Fix the authentication bug");
  assert.equal(decision.choice, "gpt-6-sol");
  assert.equal(decision.confidence, 0.91);
  assert.equal(decision.metrics.reasoningRequired, 8 / 9);
});

test("fails open when Jev is unavailable", async () => {
  const decision = await askJev({
    prompt: "Say hello",
    currentModel: "gpt-6-luna",
    models,
    client: {
      systemOne: async () => {
        throw new Error("network unavailable");
      },
    },
  });

  assert.equal(decision, null);
});
