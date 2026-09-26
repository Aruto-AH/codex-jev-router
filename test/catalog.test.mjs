import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_MODEL,
  addAutoModel,
  normalizeCatalog,
  tierForModel,
} from "../src/catalog.mjs";

test("only exact GPT-6 Luna and Sol IDs are routing candidates", () => {
  assert.equal(tierForModel("gpt-6-luna"), "fast");
  assert.equal(tierForModel("gpt-6-sol"), "strong");
  for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol-preview"]) {
    assert.equal(tierForModel(id), null);
  }
  assert.equal(tierForModel("gpt-5.5"), null);
});

test("normalizes model capabilities from a Codex catalog", () => {
  const [model] = normalizeCatalog({
    models: [
      {
        slug: "gpt-6-sol",
        supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
        default_reasoning_level: "medium",
      },
    ],
  });

  assert.deepEqual(model, {
    id: "gpt-6-sol",
    tier: "strong",
    supportedEfforts: ["medium", "high"],
    defaultEffort: "medium",
  });
});

test("adds a selectable Jev Router entry without changing the upstream catalog", () => {
  const catalog = { models: [{ slug: "gpt-5.6-sol", display_name: "Sol" }] };
  const augmented = addAutoModel(catalog);

  assert.equal(augmented.models[0].slug, AUTO_MODEL);
  assert.equal(augmented.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[0].slug, "gpt-5.6-sol");
});

test("filters unrelated native models without changing the picker catalog", () => {
  const catalog = { models: ["gpt-5.6-luna", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"].map((slug) => ({ slug })) };
  assert.deepEqual(normalizeCatalog(catalog).map((model) => model.id), ["gpt-6-luna", "gpt-6-sol"]);
  assert.deepEqual(addAutoModel(catalog).models.slice(1), catalog.models);
});

test("excludes exact routing models when native catalog marks them unsupported in API", () => {
  const catalog = { models: [
    { slug: "gpt-6-luna", supported_in_api: false },
    { slug: "gpt-6-sol", supported_in_api: true },
    { slug: "gpt-6-astra", supported_in_api: true },
  ] };
  assert.deepEqual(normalizeCatalog(catalog).map((model) => model.id), ["gpt-6-sol"]);
  assert.deepEqual(addAutoModel(catalog).models.slice(1), catalog.models);
});
