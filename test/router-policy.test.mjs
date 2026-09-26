import test from "node:test";
import assert from "node:assert/strict";
import { routeTurn } from "../src/router-policy.mjs";

const candidates = [
  {
    id: "gpt-6-luna",
    tier: "fast",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-sol",
    tier: "strong",
    supportedEfforts: ["medium", "high", "max"],
    defaultEffort: "medium",
  },
];

test("selects Jev's exact model and derives effort from reasoning demand", () => {
  const route = routeTurn({
    currentModel: "gpt-6-luna",
    candidates,
    decision: {
      choice: "gpt-6-sol",
      confidence: 0.94,
      metrics: { reasoningRequired: 0.92 },
    },
    autoEffort: true,
    incomingEffort: "medium",
  });

  assert.equal(route.model, "gpt-6-sol");
  assert.equal(route.effort, "max");
  assert.equal(route.reason, "jev");
});

test("keeps the current model when Jev fails", () => {
  const route = routeTurn({
    currentModel: "gpt-6-luna",
    candidates,
    decision: null,
    autoEffort: true,
    incomingEffort: "high",
  });

  assert.equal(route.model, "gpt-6-luna");
  assert.equal(route.effort, "high");
  assert.equal(route.reason, "jev-unavailable");
});

test("preserves the user's effort when automatic effort is disabled", () => {
  const route = routeTurn({
    currentModel: "gpt-6-luna",
    candidates,
    decision: {
      choice: "gpt-6-sol",
      confidence: 0.9,
      metrics: { reasoningRequired: 0.1 },
    },
    autoEffort: false,
    incomingEffort: "high",
  });

  assert.equal(route.model, "gpt-6-sol");
  assert.equal(route.effort, "high");
});

test("rejects unknown and malformed Jev choices", () => {
  for (const decision of [
    { choice: "gpt-6-astra", metrics: { reasoningRequired: 0.9 } },
    { choice: "gpt-6-sol", metrics: { reasoningRequired: null } },
  ]) {
    const route = routeTurn({ currentModel: "gpt-6-luna", candidates, decision });
    assert.equal(route.model, "gpt-6-luna");
    assert.equal(route.reason, "jev-invalid");
  }
  assert.equal(routeTurn({ candidates: [], decision: null }), null);
});
