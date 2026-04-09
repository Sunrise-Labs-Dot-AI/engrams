import type Database from "better-sqlite3";
import { searchFTS } from "./fts.js";
import { searchVec } from "./vec.js";
import { generateEmbedding } from "./embeddings.js";

const RRF_K = 60;

export interface SearchResult {
  id: string;
  score: number;
  memory: Record<string, unknown>;
}

export async function hybridSearch(
  sqlite: Database.Database,
  query: string,
  options: {
    domain?: string;
    minConfidence?: number;
    limit?: number;
  } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 20;
  const fetchLimit = limit * 3;

  // 1. FTS5 keyword search → resolve rowids to memory IDs
  const ftsIds: string[] = [];
  try {
    const ftsResults = searchFTS(sqlite, query, fetchLimit);
    if (ftsResults.length > 0) {
      const rowids = ftsResults.map((r) => r.rowid);
      const placeholders = rowids.map(() => "?").join(",");
      const rows = sqlite
        .prepare(`SELECT id FROM memories WHERE rowid IN (${placeholders}) AND deleted_at IS NULL`)
        .all(...rowids) as { id: string }[];
      ftsIds.push(...rows.map((r) => r.id));
    }
  } catch {
    // FTS5 failure — continue with vector search only
  }

  // 2. Vector similarity search (if sqlite-vec is available)
  const vecIds: string[] = [];
  try {
    const queryEmbedding = await generateEmbedding(query);
    const vecResults = searchVec(sqlite, queryEmbedding, fetchLimit);
    vecIds.push(...vecResults.map((r) => r.memory_id));
  } catch {
    // Embedding or sqlite-vec not available — FTS5 only
  }

  // 3. Reciprocal Rank Fusion
  const scores = new Map<string, number>();

  ftsIds.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  vecIds.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  // 4. Sort by RRF score, fetch full memories
  const rankedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (rankedIds.length === 0) return [];

  const placeholders = rankedIds.map(() => "?").join(",");
  let sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  const params: unknown[] = [...rankedIds];

  if (options.domain) {
    sql += ` AND domain = ?`;
    params.push(options.domain);
  }
  if (options.minConfidence !== undefined) {
    sql += ` AND confidence >= ?`;
    params.push(options.minConfidence);
  }

  const rows = sqlite.prepare(sql).all(...params) as Record<string, unknown>[];

  // Preserve RRF ranking order
  const rowMap = new Map(rows.map((r) => [r.id as string, r]));
  return rankedIds
    .filter((id) => rowMap.has(id))
    .map((id) => ({
      id,
      score: scores.get(id)!,
      memory: rowMap.get(id)!,
    }));
}
