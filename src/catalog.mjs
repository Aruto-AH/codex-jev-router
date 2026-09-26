export const AUTO_MODEL = "jev-router";

const DEFAULT_MODELS = {
  fast: "gpt-6-luna",
  strong: "gpt-6-sol",
};

export const tierForModel = (model) => {
  if (model === "gpt-6-luna") return "fast";
  if (model === "gpt-6-sol") return "strong";
  return null;
};

const rawModelsOf = (catalog) => {
  if (Array.isArray(catalog?.models)) return catalog.models;
  if (Array.isArray(catalog?.data)) return catalog.data;
  return [];
};

const effortOf = (level) => (typeof level === "string" ? level : level?.effort);

export function normalizeCatalog(catalog) {
  return rawModelsOf(catalog)
    .map((raw) => {
      const id = raw?.slug ?? raw?.id;
      if (!id || id === AUTO_MODEL || raw.supported_in_api === false) return null;
      const supportedEfforts = Array.isArray(raw.supported_reasoning_levels)
        ? raw.supported_reasoning_levels.map(effortOf).filter(Boolean)
        : [];
      return {
        id,
        tier: tierForModel(id),
        supportedEfforts,
        defaultEffort: raw.default_reasoning_level ?? raw.default_reasoning_effort ?? "medium",
      };
    })
    .filter((model) => model?.tier);
}

export function addAutoModel(catalog, backend = "jev") {
  const models = Array.isArray(catalog?.models)
    ? catalog.models
    : Array.isArray(catalog?.data)
      ? catalog.data
      : null;
  if (!models || models.some((model) => (model?.slug ?? model?.id) === AUTO_MODEL)) return catalog;

  const template = models[0];
  if (!template) return catalog;
  const auto = {
    ...template,
    slug: AUTO_MODEL,
    ...(Object.hasOwn(template, "id") ? { id: AUTO_MODEL } : {}),
    display_name: backend === "gpt" ? "Codex Router" : "Jev Router",
    description: backend === "gpt"
      ? "A separate Codex classifier selects the model and reasoning effort for each new turn."
      : "Jev selects the model and reasoning effort for each new turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
  };

  if (Array.isArray(catalog.models)) return { ...catalog, models: [auto, ...models] };
  return { ...catalog, data: [auto, ...models] };
}

export const defaultModelForTier = (tier) => DEFAULT_MODELS[tier] ?? DEFAULT_MODELS.strong;
