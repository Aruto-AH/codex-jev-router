import { normalizeRequestedEffort, selectEffort } from "./effort-policy.mjs";
const strongFirst = (left, right) => {
  const order = { strong: 2, fast: 1 };
  return (order[right.tier] ?? 0) - (order[left.tier] ?? 0);
};

export function routeTurn({
  currentModel,
  candidates = [],
  decision,
  autoEffort = true,
  incomingEffort = "medium",
} = {}) {
  const current = candidates.find((candidate) => candidate.id === currentModel);
  const chosen = candidates.find((candidate) => candidate.id === decision?.choice);
  const fallback = current ?? [...candidates].sort(strongFirst)[0];
  if (!fallback) return null;
  const model = chosen ?? fallback;
  const hasValidDecision = Boolean(chosen) && (!autoEffort || (
    typeof decision?.metrics?.reasoningRequired === "number" &&
    Number.isFinite(decision.metrics.reasoningRequired) &&
    decision.metrics.reasoningRequired >= 0 && decision.metrics.reasoningRequired <= 1
  ));
  const selected = hasValidDecision ? model : fallback;
  const reason = hasValidDecision ? "jev" : decision ? "jev-invalid" : "jev-unavailable";

  const effort = autoEffort && hasValidDecision
    ? selectEffort({
        reasoningRequired: decision.metrics.reasoningRequired,
        supportedEfforts: selected.supportedEfforts,
        defaultEffort: selected.defaultEffort,
      })
    : normalizeRequestedEffort(
        incomingEffort,
        selected.supportedEfforts,
        selected.defaultEffort,
      );

  return {
    model: selected.id,
    tier: selected.tier,
    effort,
    confidence: hasValidDecision ? decision?.confidence ?? null : null,
    reason,
  };
}
