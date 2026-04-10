import type { Client } from "@libsql/client";
import type { SourceType } from "./types.js";

export const DECAY_RATE = 0.01; // per 30 days
export const MIN_CONFIDENCE = 0.10;
export const DECAY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function applyConfidenceDecay(client: Client): Promise<number> {
  const now = new Date();

  const result = await client.execute({
    sql: `SELECT id, confidence, last_used_at, confirmed_at, learned_at
          FROM memories
          WHERE deleted_at IS NULL AND confidence > ?`,
    args: [MIN_CONFIDENCE],
  });

  const candidates = result.rows as unknown as {
    id: string;
    confidence: number;
    last_used_at: string | null;
    confirmed_at: string | null;
    learned_at: string | null;
  }[];

  let decayed = 0;

  for (const mem of candidates) {
    const lastActivity = mem.last_used_at || mem.confirmed_at || mem.learned_at;
    if (!lastActivity) continue;

    const elapsed = now.getTime() - new Date(lastActivity).getTime();
    const periods = Math.floor(elapsed / DECAY_INTERVAL_MS);

    if (periods <= 0) continue;

    const newConfidence = Math.max(mem.confidence - (DECAY_RATE * periods), MIN_CONFIDENCE);
    if (newConfidence < mem.confidence) {
      await client.execute({
        sql: `UPDATE memories SET confidence = ? WHERE id = ?`,
        args: [newConfidence, mem.id],
      });
      decayed++;
    }
  }

  return decayed;
}

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
