import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";

export const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

const MAX_SCORE = COMPLEXITY_SCALE.length - 1;

const TIER_GUIDANCE = {
  fast: "trivial, mechanical, or purely factual work; avoid design judgment and multi-file reasoning",
  strong: "hard reasoning, ambiguity, unknown-cause debugging, security, concurrency, or high blast radius",
};

const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass.",
      "Judge the required reasoning, scope, ambiguity, tool use, and blast radius rather than the requested answer length.",
    ],
    Object.fromEntries(
      models.map((model) => [
        model.id,
        {
        model: model.description ?? model.id,
        tier: model.tier,
        guidance: TIER_GUIDANCE[model.tier] ?? "choose only when this exact model is appropriate",
      },
      ]),
    ),
  );

export function buildJevRequest({ prompt, currentModel, contextTokens = 0, models }) {
  return {
    state: {
      request: prompt,
      session: {
        current_model: currentModel,
        context_tokens: contextTokens,
      },
      environment: {
        available_models: models.map((model) => model.id),
      },
    },
    questions: {
      model: questionForModels(models),
      task_complexity: score(
        "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
        COMPLEXITY_SCALE,
      ),
      reasoning_required: score(
        "How much reasoning is required to complete the request correctly in one pass?",
        COMPLEXITY_SCALE,
      ),
      tool_complexity: score(
        "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
        COMPLEXITY_SCALE,
      ),
    },
  };
}

export function createJevClient({ apiKey, baseURL, defaultModel = "jev-latest" } = {}) {
  if (!(apiKey ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY)) return null;
  return new TypeSafeClient({
    apiKey,
    baseURL,
    defaultModel,
    timeout: 1500,
    retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn",
  });
}

const normalizedScore = (answer) => {
  const value = Number(answer?.score);
  return Number.isFinite(value) ? value / MAX_SCORE : null;
};

export async function askJev({
  prompt,
  currentModel,
  contextTokens = 0,
  models,
  client,
  signal,
} = {}) {
  if (!prompt || !Array.isArray(models) || models.length === 0) return null;
  const apiClient = client ?? createJevClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    baseURL: process.env.JEV_BASE_URL,
    defaultModel: process.env.JEV_MODEL ?? "jev-latest",
  });
  if (!apiClient) return null;

  try {
    const request = buildJevRequest({ prompt, currentModel, contextTokens, models });
    const result = await apiClient.systemOne(request, { signal });
    const answers = result?.answers ?? {};
    const model = answers.model ?? {};
    return {
      choice: model.choice,
      confidence: Number.isFinite(Number(model.confidence)) ? Number(model.confidence) : 0,
      metrics: {
        taskComplexity: normalizedScore(answers.task_complexity),
        reasoningRequired: normalizedScore(answers.reasoning_required),
        toolComplexity: normalizedScore(answers.tool_complexity),
      },
    };
  } catch {
    return null;
  }
}
