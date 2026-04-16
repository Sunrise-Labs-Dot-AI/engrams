/**
 * Evaluation metrics for Lodis search and retrieval quality.
 */

/** Precision at K: fraction of top-K retrieved that are relevant */
export function precisionAtK(retrieved: string[], relevant: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const relevantSet = new Set(relevant);
  const hits = topK.filter((id) => relevantSet.has(id)).length;
  return hits / topK.length;
}

/** Recall at K: fraction of relevant items found in top-K */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  const hits = relevant.filter((id) => topK.has(id)).length;
  return hits / relevant.length;
}

/** Mean Reciprocal Rank: 1/rank of the first relevant result */
export function mrr(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** F1 score: harmonic mean of precision and recall */
export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** Normalized Discounted Cumulative Gain at K */
export function ndcg(
  retrieved: string[],
  relevanceScores: Map<string, number>,
  k: number,
): number {
  const topK = retrieved.slice(0, k);

  // DCG
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceScores.get(topK[i]) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }

  // Ideal DCG
  const idealRels = [...relevanceScores.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    idcg += (Math.pow(2, idealRels[i]) - 1) / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/** Print a summary of metrics for a test case */
export function formatMetrics(name: string, metrics: Record<string, number>): string {
  const parts = Object.entries(metrics)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join(" ");
  return `[eval] ${name}: ${parts}`;
}
