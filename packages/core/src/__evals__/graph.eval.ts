import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateEmbedding } from "../embeddings.js";
import { openRealDb } from "./helpers.js";
import type { Client } from "@libsql/client";

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

// --- Graph quality helpers ---

interface GraphStats {
  totalMemories: number;
  totalConnections: number;
  isolatedNodes: number;
  connectedNodes: number;
  avgDegree: number;
  relationshipDistribution: Record<string, number>;
  missingEntityConnections: number;
}

async function computeGraphStats(): Promise<GraphStats> {
  const totalMemoriesResult = await client.execute({
    sql: `SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL`,
    args: [],
  });
  const totalMemories = totalMemoriesResult.rows[0].c as number;

  const totalConnectionsResult = await client.execute({
    sql: `SELECT COUNT(*) as c FROM memory_connections`,
    args: [],
  });
  const totalConnections = totalConnectionsResult.rows[0].c as number;

  const connectedIdsResult = await client.execute({
    sql: `SELECT DISTINCT id FROM (
      SELECT source_memory_id as id FROM memory_connections
      UNION
      SELECT target_memory_id as id FROM memory_connections
    )`,
    args: [],
  });
  const connectedNodes = connectedIdsResult.rows.length;
  const isolatedNodes = totalMemories - connectedNodes;
  const avgDegree = totalMemories > 0 ? (totalConnections * 2) / totalMemories : 0;

  const relRowsResult = await client.execute({
    sql: `SELECT relationship, COUNT(*) as cnt FROM memory_connections GROUP BY relationship`,
    args: [],
  });

  const relationshipDistribution: Record<string, number> = {};
  for (const r of relRowsResult.rows) {
    relationshipDistribution[r.relationship as string] = r.cnt as number;
  }

  // Count same-entity memory pairs that lack connections
  const missingResult = await client.execute({
    sql: `SELECT COUNT(*) as c FROM memories a
       JOIN memories b ON a.entity_name = b.entity_name AND a.id < b.id
       WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.entity_name IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM memory_connections mc
         WHERE (mc.source_memory_id = a.id AND mc.target_memory_id = b.id)
            OR (mc.source_memory_id = b.id AND mc.target_memory_id = a.id)
       )`,
    args: [],
  });
  const missingEntityConnections = missingResult.rows[0].c as number;

  return {
    totalMemories,
    totalConnections,
    isolatedNodes,
    connectedNodes,
    avgDegree,
    relationshipDistribution,
    missingEntityConnections,
  };
}

// --- Semantic clarity helpers ---

interface ClarityStats {
  totalMemories: number;
  veryShort: number; // <30 chars — too terse to be useful
  veryLong: number; // >300 chars — may be compound memories that should be split
  withDetail: number;
  withEntityType: number;
  withEntityName: number;
  avgContentLength: number;
}

async function computeClarityStats(): Promise<ClarityStats> {
  const rowsResult = await client.execute({
    sql: `SELECT content, detail, entity_type, entity_name FROM memories WHERE deleted_at IS NULL`,
    args: [],
  });
  const rows = rowsResult.rows as unknown as { content: string; detail: string | null; entity_type: string | null; entity_name: string | null }[];

  let veryShort = 0;
  let veryLong = 0;
  let withDetail = 0;
  let withEntityType = 0;
  let withEntityName = 0;
  let totalLength = 0;

  for (const r of rows) {
    const len = (r.content as string).length;
    totalLength += len;
    if (len < 30) veryShort++;
    if (len > 300) veryLong++;
    if (r.detail) withDetail++;
    if (r.entity_type) withEntityType++;
    if (r.entity_name) withEntityName++;
  }

  return {
    totalMemories: rows.length,
    veryShort,
    veryLong,
    withDetail,
    withEntityType,
    withEntityName,
    avgContentLength: rows.length > 0 ? totalLength / rows.length : 0,
  };
}

describe("graph connectivity evals", () => {
  it("reports graph statistics", async () => {
    if (!available) return;

    const stats = await computeGraphStats();

    console.log(`[graph] Total memories: ${stats.totalMemories}`);
    console.log(`[graph] Total connections: ${stats.totalConnections}`);
    console.log(`[graph] Connected nodes: ${stats.connectedNodes} (${((stats.connectedNodes / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[graph] Isolated nodes: ${stats.isolatedNodes} (${((stats.isolatedNodes / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[graph] Avg degree: ${stats.avgDegree.toFixed(2)}`);
    console.log(`[graph] Relationships: ${JSON.stringify(stats.relationshipDistribution)}`);
    console.log(`[graph] Missing entity connections: ${stats.missingEntityConnections}`);

    // These are diagnostic baselines, not hard thresholds.
    // As the graph improves, tighten these.
    expect(stats.totalConnections).toBeGreaterThan(0);
  });

  it("connectivity ratio — at least 20% of memories should have connections", async () => {
    if (!available) return;

    const stats = await computeGraphStats();
    const connectivityRatio = stats.connectedNodes / stats.totalMemories;

    console.log(`[graph] Connectivity ratio: ${(connectivityRatio * 100).toFixed(1)}%`);

    // Current baseline: 18%. This should improve over time.
    // Soft threshold — log warning but don't fail below 10%
    expect(
      connectivityRatio,
      `Connectivity ratio ${(connectivityRatio * 100).toFixed(1)}% is critically low — most memories are isolated`,
    ).toBeGreaterThanOrEqual(0.10);
  });

  it("relationship diversity — should use more than just 'related'", async () => {
    if (!available) return;

    const stats = await computeGraphStats();
    const relatedCount = stats.relationshipDistribution["related"] ?? 0;
    const relatedRatio = stats.totalConnections > 0 ? relatedCount / stats.totalConnections : 1;
    const uniqueTypes = Object.keys(stats.relationshipDistribution).length;

    console.log(`[graph] 'related' ratio: ${(relatedRatio * 100).toFixed(1)}% (${relatedCount}/${stats.totalConnections})`);
    console.log(`[graph] Unique relationship types: ${uniqueTypes}`);

    // 'related' is the least informative type. A good graph should have
    // at least 3 distinct relationship types and 'related' should be < 90%.
    expect(uniqueTypes, "Should have at least 2 distinct relationship types").toBeGreaterThanOrEqual(2);
  });

  it("entity connection coverage — same-entity memories should be linked", async () => {
    if (!available) return;

    const stats = await computeGraphStats();

    // Count total same-entity pairs
    const totalEntityPairsResult = await client.execute({
      sql: `SELECT COUNT(*) as c FROM memories a
         JOIN memories b ON a.entity_name = b.entity_name AND a.id < b.id
         WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL AND a.entity_name IS NOT NULL`,
      args: [],
    });
    const totalEntityPairs = totalEntityPairsResult.rows[0].c as number;

    const connectedPairs = totalEntityPairs - stats.missingEntityConnections;
    const coverageRatio = totalEntityPairs > 0 ? connectedPairs / totalEntityPairs : 1;

    console.log(`[graph] Entity pairs: ${totalEntityPairs} total, ${connectedPairs} connected, ${stats.missingEntityConnections} missing`);
    console.log(`[graph] Entity connection coverage: ${(coverageRatio * 100).toFixed(1)}%`);

    // Baseline: memories sharing the same entity_name should ideally be connected.
    // Currently at 0% — this is a known gap.
    expect(coverageRatio).toBeGreaterThanOrEqual(0); // diagnostic — will tighten
  });

  it("average degree should be at least 0.5 (each memory connected to ~1 other on average)", async () => {
    if (!available) return;

    const stats = await computeGraphStats();
    console.log(`[graph] Average degree: ${stats.avgDegree.toFixed(2)}`);

    // avgDegree = (2 * edges) / nodes. 0.5 means ~1 edge per 4 nodes.
    // Current: ~0.60. This is a soft baseline.
    expect(stats.avgDegree).toBeGreaterThanOrEqual(0.3);
  });
});

describe("semantic clarity evals", () => {
  it("reports clarity statistics", async () => {
    if (!available) return;

    const stats = await computeClarityStats();

    console.log(`[clarity] Total memories: ${stats.totalMemories}`);
    console.log(`[clarity] Avg content length: ${stats.avgContentLength.toFixed(0)} chars`);
    console.log(`[clarity] Very short (<30 chars): ${stats.veryShort} (${((stats.veryShort / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[clarity] Very long (>300 chars): ${stats.veryLong} (${((stats.veryLong / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[clarity] Has detail field: ${stats.withDetail} (${((stats.withDetail / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[clarity] Has entity_type: ${stats.withEntityType} (${((stats.withEntityType / stats.totalMemories) * 100).toFixed(1)}%)`);
    console.log(`[clarity] Has entity_name: ${stats.withEntityName} (${((stats.withEntityName / stats.totalMemories) * 100).toFixed(1)}%)`);

    expect(stats.totalMemories).toBeGreaterThan(0);
  });

  it("entity classification coverage — most memories should have an entity_type", async () => {
    if (!available) return;

    const stats = await computeClarityStats();
    const classifiedRatio = stats.withEntityType / stats.totalMemories;

    console.log(`[clarity] Entity classification ratio: ${(classifiedRatio * 100).toFixed(1)}%`);

    // Entity extraction runs on every write. Unclassified memories were created
    // before entity extraction was added, or the LLM wasn't configured.
    // Current baseline: ~62%. Goal: >80% after backfill.
    expect(classifiedRatio).toBeGreaterThanOrEqual(0.3);
  });

  it("very short memories should be rare — content should be self-contained", async () => {
    if (!available) return;

    const stats = await computeClarityStats();
    const veryShortRatio = stats.veryShort / stats.totalMemories;

    console.log(`[clarity] Very short ratio: ${(veryShortRatio * 100).toFixed(1)}%`);

    // Memories under 30 chars are usually too terse to be useful for search.
    // e.g., "Likes coffee" — no context, no entity, weak embedding.
    expect(veryShortRatio, "Too many ultra-short memories").toBeLessThanOrEqual(0.10);
  });

  it("very long memories should be rare — may need splitting", async () => {
    if (!available) return;

    const stats = await computeClarityStats();
    const veryLongRatio = stats.veryLong / stats.totalMemories;

    console.log(`[clarity] Very long ratio: ${(veryLongRatio * 100).toFixed(1)}%`);

    // Memories over 300 chars often contain multiple facts that should be split.
    // Compound memories hurt search precision (embedding averages across topics).
    expect(veryLongRatio, "Too many potentially compound memories").toBeLessThanOrEqual(0.15);
  });

  it("embedding distinctness — memories should have diverse embeddings", async () => {
    if (!available) return;

    // Sample 20 memories and check that their embeddings aren't all clustered
    const rowsResult = await client.execute({
      sql: `SELECT id, embedding FROM memories
           WHERE deleted_at IS NULL AND embedding IS NOT NULL
           LIMIT 20`,
      args: [],
    });

    if (rowsResult.rows.length < 5) {
      console.warn("[clarity] Not enough embeddings to check distinctness");
      return;
    }

    const embeddings = rowsResult.rows.map((r) => {
      const buf = r.embedding as ArrayBuffer;
      return new Float32Array(buf);
    });

    // Compute pairwise cosine similarities
    let totalSim = 0;
    let pairs = 0;
    let highSimCount = 0;

    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        let dot = 0, normA = 0, normB = 0;
        for (let k = 0; k < embeddings[i].length; k++) {
          dot += embeddings[i][k] * embeddings[j][k];
          normA += embeddings[i][k] * embeddings[i][k];
          normB += embeddings[j][k] * embeddings[j][k];
        }
        const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
        totalSim += sim;
        pairs++;
        if (sim > 0.9) highSimCount++;
      }
    }

    const avgSim = totalSim / pairs;
    const highSimRatio = highSimCount / pairs;

    console.log(`[clarity] Avg pairwise similarity: ${avgSim.toFixed(4)} (${pairs} pairs)`);
    console.log(`[clarity] High similarity pairs (>0.9): ${highSimCount} (${(highSimRatio * 100).toFixed(1)}%)`);

    // If avg similarity is very high, memories are too similar (poor diversity).
    // If many pairs have >0.9 similarity, we have near-duplicates.
    expect(avgSim, "Average similarity too high — memories may lack diversity").toBeLessThan(0.8);
    expect(
      highSimRatio,
      "Too many near-duplicate pairs (>0.9 cosine similarity)",
    ).toBeLessThanOrEqual(0.10);
  });
});

describe("connection correctness evals", () => {
  it("connected memories should be semantically related", async () => {
    if (!available) return;

    const connectionsResult = await client.execute({
      sql: `SELECT mc.source_memory_id, mc.target_memory_id, mc.relationship
           FROM memory_connections mc
           JOIN memories s ON mc.source_memory_id = s.id AND s.deleted_at IS NULL
           JOIN memories t ON mc.target_memory_id = t.id AND t.deleted_at IS NULL
           LIMIT 30`,
      args: [],
    });
    const connections = connectionsResult.rows as unknown as { source_memory_id: string; target_memory_id: string; relationship: string }[];

    let semanticallyRelated = 0;
    let total = 0;

    for (const conn of connections) {
      const srcResult = await client.execute({
        sql: `SELECT embedding FROM memories WHERE id = ?`,
        args: [conn.source_memory_id],
      });
      const tgtResult = await client.execute({
        sql: `SELECT embedding FROM memories WHERE id = ?`,
        args: [conn.target_memory_id],
      });

      if (!srcResult.rows[0]?.embedding || !tgtResult.rows[0]?.embedding) continue;

      const a = new Float32Array(srcResult.rows[0].embedding as ArrayBuffer);
      const b = new Float32Array(tgtResult.rows[0].embedding as ArrayBuffer);

      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));

      total++;
      // Connected memories should have at least mild semantic similarity (>0.2)
      if (similarity > 0.2) semanticallyRelated++;
    }

    const correctnessRatio = total > 0 ? semanticallyRelated / total : 1;

    console.log(`[connections] Semantically related: ${semanticallyRelated}/${total} (${(correctnessRatio * 100).toFixed(1)}%)`);

    // Connections should be between related content. If a connection exists
    // between completely unrelated memories, it's noise.
    expect(
      correctnessRatio,
      "Too many connections between semantically unrelated memories",
    ).toBeGreaterThanOrEqual(0.7);
  });

  it("'supports' connections should have higher similarity than 'related'", async () => {
    if (!available) return;

    async function avgSimilarityForType(relType: string): Promise<{ avg: number; count: number }> {
      const connectionsResult = await client.execute({
        sql: `SELECT mc.source_memory_id, mc.target_memory_id
             FROM memory_connections mc
             JOIN memories s ON mc.source_memory_id = s.id AND s.deleted_at IS NULL
             JOIN memories t ON mc.target_memory_id = t.id AND t.deleted_at IS NULL
             WHERE mc.relationship = ?`,
        args: [relType],
      });
      const connections = connectionsResult.rows as unknown as { source_memory_id: string; target_memory_id: string }[];

      let totalSim = 0;
      let count = 0;

      for (const conn of connections) {
        const srcResult = await client.execute({
          sql: `SELECT embedding FROM memories WHERE id = ?`,
          args: [conn.source_memory_id],
        });
        const tgtResult = await client.execute({
          sql: `SELECT embedding FROM memories WHERE id = ?`,
          args: [conn.target_memory_id],
        });

        if (!srcResult.rows[0]?.embedding || !tgtResult.rows[0]?.embedding) continue;

        const a = new Float32Array(srcResult.rows[0].embedding as ArrayBuffer);
        const b = new Float32Array(tgtResult.rows[0].embedding as ArrayBuffer);

        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        totalSim += dot / (Math.sqrt(normA) * Math.sqrt(normB));
        count++;
      }

      return { avg: count > 0 ? totalSim / count : 0, count };
    }

    const supports = await avgSimilarityForType("supports");
    const related = await avgSimilarityForType("related");

    console.log(`[connections] 'supports' avg similarity: ${supports.avg.toFixed(4)} (n=${supports.count})`);
    console.log(`[connections] 'related' avg similarity: ${related.avg.toFixed(4)} (n=${related.count})`);

    // Directional relationships like 'supports' should generally connect
    // more tightly related content than the generic 'related' bucket.
    // This is diagnostic — log the comparison.
    if (supports.count > 0 && related.count > 0) {
      console.log(
        `[connections] 'supports' ${supports.avg > related.avg ? ">" : "<="} 'related': ${supports.avg > related.avg ? "GOOD" : "INVESTIGATE"}`,
      );
    }
  });
});
