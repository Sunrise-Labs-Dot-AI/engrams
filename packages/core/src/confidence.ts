import type { SourceType } from "./types.js";

const INITIAL_CONFIDENCE: Record<SourceType, number> = {
  stated: 0.9,
  observed: 0.75,
  inferred: 0.65,
  "cross-agent": 0.7,
};

export function getInitialConfidence(sourceType: SourceType): number {
  return INITIAL_CONFIDENCE[sourceType] ?? 0.7;
}

export function applyConfirm(_current: number): number {
  return 0.99;
}

export function applyCorrect(): number {
  return 0.5;
}

export function applyMistake(current: number): number {
  return Math.max(current - 0.15, 0.1);
}

export function applyUsed(current: number): number {
  return Math.min(current + 0.02, 0.99);
}
