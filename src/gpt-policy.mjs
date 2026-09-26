import { normalizeRequestedEffort } from "./effort-policy.mjs";

const STRONG_TASK = /\b(?:implement|build|design|architect|propose|plan|refactor|migrate|release|integrate|review|fix|debug|investigate|resolve|change|create|delete|remove|drop|wipe|rewrite|replace)\b|(?:実装|設計|提案|計画|移行|統合|リリース|レビュー|修正|原因|調査|変更|構築|削除|置換)/i;
const HIGH_RISK_SCOPE = /(?:architecture|system design|security|authentication|authorization|concurren|race condition|deadlock|database schema|migration|destructive|breaking change|release|final integration|high[- ]blast[- ]radius|entire codebase|whole repository|all files|アーキテクチャ|セキュリティ|認証|認可|並行|競合|デッドロック|データベース.*(?:スキーマ|移行)|破壊的|最終統合|リリース|全体|広範囲|全ファイル)/i;
const UNKNOWN_DEBUG = /(?:unknown|unclear|intermittent|原因不明|再現しない|断続的)/i;
const INFORMATION_OR_WORDING_TASK = /^\s*(?:(?:read|show|list|summarize|explain|inspect)\b|(?:fix|correct|change)\s+(?:a |the )?(?:typo|wording|text)\b|(?:閲覧|確認|説明|要約|文言|誤字)(?:を|の|について)?)/i;

export function requiresSol(prompt) {
  const text = String(prompt ?? "");
  if (INFORMATION_OR_WORDING_TASK.test(text)) return false;
  return STRONG_TASK.test(text) && (HIGH_RISK_SCOPE.test(text) || UNKNOWN_DEBUG.test(text));
}

export function routeGptTurn({ prompt, currentModel, candidates = [], decision,
  autoEffort = true, incomingEffort = "medium" } = {}) {
  const current = candidates.find((model) => model.id === currentModel);
  const fallback = current ?? candidates.find((model) => model.tier === "strong") ?? candidates[0];
  if (!fallback) return null;
  const valid = decision && candidates.some((model) => model.id === decision.model) &&
    ["low", "medium", "high", "max"].includes(decision.effort) &&
    typeof decision.confidence === "number" && Number.isFinite(decision.confidence) &&
    decision.confidence >= 0 && decision.confidence <= 1;
  const floor = valid && (requiresSol(prompt) || decision.confidence < 0.65);
  const strong = candidates.find((model) => model.tier === "strong");
  const chosen = valid ? candidates.find((model) => model.id === decision.model) : fallback;
  const selected = floor && strong ? strong : chosen;
  const desiredEffort = valid && autoEffort ?
    (floor && strong && selected.id !== decision.model && ["low", "medium"].includes(decision.effort) ? "high" : decision.effort)
    : incomingEffort;
  return {
    model: selected.id,
    tier: selected.tier,
    effort: normalizeRequestedEffort(desiredEffort, selected.supportedEfforts, selected.defaultEffort),
    confidence: valid ? decision.confidence : null,
    reason: valid ? (floor && strong && selected.id !== decision.model ? "gpt-floor" : "gpt") : "gpt-unavailable",
  };
}
