import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hybridSearch } from "../search.js";
import { generateEmbedding } from "../embeddings.js";
import { openRealDb } from "./helpers.js";
import {
  DEDUP_TRUE_POSITIVE_CASES,
  DEDUP_TRUE_NEGATIVE_CASES,
  DEDUP_EDGE_CASES,
} from "./ground-truth.js";
import type { Client } from "@libsql/client";

/**
 * Dedup detection in the write path uses cosine similarity >= 0.7.
 * We replicate that logic here: embed the new content, run hybrid search,
 * and check if the expected existing memory appears with a high enough score.
 */

const WRITE_SIMILARITY_THRESHOLD = 0.7;

let client: Client;
let cleanup: () => void;
let available = false;

beforeAll(async () => {
  const result = await openRealDb();
  if (!result) return;
  client = result.client;
  cleanup = result.cleanup;
  available = true;
});

afterAll(() => {
  if (cleanup) cleanup();
});

async function getStoredEmbedding(memoryId: string): Promise<Float32Array | null> {
  const result = await client.execute({
    sql: `SELECT embedding FROM memories WHERE id = ?`,
    args: [memoryId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!row.embedding) return null;
  const buf = row.embedding as ArrayBuffer;
  return new Float32Array(buf);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe("dedup evals", () => {
  describe("true positives — should detect as duplicate", () => {
    for (const testCase of DEDUP_TRUE_POSITIVE_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const newEmbedding = await generateEmbedding(testCase.newContent);
        const existingEmbedding = await getStoredEmbedding(testCase.existingId);

        if (!existingEmbedding) {
          console.warn(`[dedup] No embedding for ${testCase.existingId}, skipping`);
          return;
        }

        const similarity = cosineSimilarity(newEmbedding, existingEmbedding);
        console.log(
          `[dedup] ${testCase.name}: similarity=${similarity.toFixed(4)} threshold=${WRITE_SIMILARITY_THRESHOLD}`,
        );

        expect(
          similarity,
          `Expected similarity >= ${WRITE_SIMILARITY_THRESHOLD} for duplicate detection`,
        ).toBeGreaterThanOrEqual(WRITE_SIMILARITY_THRESHOLD);
      });
    }
  });

  describe("true negatives — should NOT flag as duplicate", () => {
    for (const testCase of DEDUP_TRUE_NEGATIVE_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const newEmbedding = await generateEmbedding(testCase.newContent);
        const existingEmbedding = await getStoredEmbedding(testCase.existingId);

        if (!existingEmbedding) {
          console.warn(`[dedup] No embedding for ${testCase.existingId}, skipping`);
          return;
        }

        const similarity = cosineSimilarity(newEmbedding, existingEmbedding);
        console.log(
          `[dedup] ${testCase.name}: similarity=${similarity.toFixed(4)} threshold=${WRITE_SIMILARITY_THRESHOLD}`,
        );

        expect(
          similarity,
          `Expected similarity < ${WRITE_SIMILARITY_THRESHOLD} — these are distinct memories`,
        ).toBeLessThan(WRITE_SIMILARITY_THRESHOLD);
      });
    }
  });

  describe("edge cases", () => {
    for (const testCase of DEDUP_EDGE_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const newEmbedding = await generateEmbedding(testCase.newContent);
        const existingEmbedding = await getStoredEmbedding(testCase.existingId);

        if (!existingEmbedding) {
          console.warn(`[dedup] No embedding for ${testCase.existingId}, skipping`);
          return;
        }

        const similarity = cosineSimilarity(newEmbedding, existingEmbedding);
        console.log(
          `[dedup] ${testCase.name}: similarity=${similarity.toFixed(4)} shouldMatch=${testCase.shouldMatch}`,
        );

        if (testCase.shouldMatch) {
          expect(similarity).toBeGreaterThanOrEqual(WRITE_SIMILARITY_THRESHOLD);
        } else {
          expect(similarity).toBeLessThan(WRITE_SIMILARITY_THRESHOLD);
        }
      });
    }
  });

  describe("dedup via search path", () => {
    it("hybrid search surfaces duplicates in top results", async () => {
      if (!available) return;

      // Use a known duplicate query: rephrasing of Sunrise Labs memory
      const { results } = await hybridSearch(client, "James runs Sunrise Labs as a software studio side project", {
        limit: 5,
        expand: false,
      });

      const topIds = results.map((r) => r.id);
      const hasSunriseMemory = topIds.includes("abb48cda5d12fb1282eb932cf1882fcb");

      console.log(`[dedup] Search-based dedup: found Sunrise Labs memory in top 5: ${hasSunriseMemory}`);
      expect(hasSunriseMemory, "Existing Sunrise Labs memory should surface in dedup search").toBe(true);
    });
  });
});
