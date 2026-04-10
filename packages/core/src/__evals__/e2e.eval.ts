import { describe, it, expect, afterAll } from "vitest";
import { hybridSearch } from "../search.js";
import { generateEmbedding } from "../embeddings.js";
import { insertEmbedding } from "../vec.js";
import { bumpLastModified } from "../db.js";
import { createTestDb, generateId, insertMemory } from "./helpers.js";
import type { Client } from "@libsql/client";

let testDb: Awaited<ReturnType<typeof createTestDb>> | null = null;

afterAll(() => {
  if (testDb) testDb.cleanup();
});

describe("e2e evals", () => {
  it("write → search → retrieve cycle", async () => {
    testDb = await createTestDb();
    const { client, vecAvailable } = testDb;

    // Write a memory
    const memId = generateId();
    const content = "The quarterly planning meeting is every first Monday of the month";
    await insertMemory(client, memId, content, {
      domain: "work",
      confidence: 0.9,
    });

    // Generate and store embedding
    const embedding = await generateEmbedding(content);
    if (vecAvailable) {
      await insertEmbedding(client, memId, embedding);
    }
    await bumpLastModified(client);

    // Search with different wording
    const { results } = await hybridSearch(client, "when is the planning meeting scheduled", {
      limit: 5,
      expand: false,
    });

    const retrievedIds = results.map((r) => r.id);
    console.log(`[e2e] Write→Search: found=${retrievedIds.includes(memId)} results=${results.length}`);

    expect(retrievedIds, "Written memory should be found via semantic search").toContain(memId);
    expect(results[0].score, "Top result should have a meaningful score").toBeGreaterThan(0);
  });

  it("write → dedup detection → confirm cycle", async () => {
    testDb = await createTestDb();
    const { client, vecAvailable } = testDb;

    // Write original memory
    const originalId = generateId();
    const originalContent = "Prefers Python for data analysis and scripting tasks";
    await insertMemory(client, originalId, originalContent, {
      domain: "coding",
      confidence: 0.85,
    });

    const originalEmbedding = await generateEmbedding(originalContent);
    if (vecAvailable) {
      await insertEmbedding(client, originalId, originalEmbedding);
    }
    await bumpLastModified(client);

    // Attempt to write a near-duplicate
    const dupContent = "Uses Python for data analysis and scripting";
    const dupEmbedding = await generateEmbedding(dupContent);

    // Check dedup: search for similar content
    const { results } = await hybridSearch(client, dupContent, {
      limit: 5,
      expand: false,
    });

    // Verify original surfaces in dedup search
    const foundOriginal = results.some((r) => r.id === originalId);
    console.log(`[e2e] Dedup detection: found original=${foundOriginal} results=${results.length}`);
    expect(foundOriginal, "Original memory should surface in dedup search").toBe(true);

    // Also verify cosine similarity is above threshold
    if (vecAvailable) {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < originalEmbedding.length; i++) {
        dot += originalEmbedding[i] * dupEmbedding[i];
        normA += originalEmbedding[i] * originalEmbedding[i];
        normB += dupEmbedding[i] * dupEmbedding[i];
      }
      const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
      console.log(`[e2e] Cosine similarity: ${similarity.toFixed(4)}`);
      expect(similarity, "Near-duplicate should have cosine similarity >= 0.7").toBeGreaterThanOrEqual(0.7);
    }

    // Confirm the original memory
    await client.execute({
      sql: `UPDATE memories SET confidence = 0.99, confirmed_count = confirmed_count + 1, confirmed_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), originalId],
    });

    const confirmedResult = await client.execute({
      sql: `SELECT confidence, confirmed_count FROM memories WHERE id = ?`,
      args: [originalId],
    });
    const confirmed = confirmedResult.rows[0] as unknown as { confidence: number; confirmed_count: number };

    expect(confirmed.confidence).toBe(0.99);
    expect(confirmed.confirmed_count).toBe(1);
  });
});
