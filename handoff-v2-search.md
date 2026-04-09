# Handoff: V2 — Search Quality + Graph Expansion + Caching

**Repo:** `Sunrise-Labs-Dot-AI/engrams` (local at `~/Documents/Claude/Projects/engrams`)
**Branch:** `main`
**Budget:** $10
**Timeout:** 25 min

## Context

Engrams has hybrid search (FTS5 + sqlite-vec + Reciprocal Rank Fusion) that works well for direct lookups. But agents need richer results to make good decisions — connected memories, confidence-aware ranking, and stable ordering for prompt cache compatibility. Search also needs to be faster for repeated queries.

Read `CLAUDE.md` in the repo root for full product context. The search implementation lives in:
- `packages/core/src/search.ts` — hybrid search with RRF
- `packages/core/src/vec.ts` — sqlite-vec vector search
- `packages/core/src/embeddings.ts` — embedding generation
- `packages/mcp-server/src/server.ts` — `memory_search` tool handler

## What We're Building

### 1. Relevance-Bounded Graph Expansion

When `memory_search` returns results, automatically expand each result's connections — but only follow edges where the connected memory is semantically similar to the original query.

**Algorithm:**
```
for each result in search_results:
  connections = get_connections(result.id)  // 1-hop
  for each connection:
    connected_memory = fetch(connection.target_id)
    similarity = cosine_similarity(query_embedding, connected_memory_embedding)
    if similarity > 0.5:
      add connected_memory to result.connected[]
      // Recurse for depth 2-3, same threshold
      sub_connections = get_connections(connected_memory.id)
      for each sub_connection:
        ...same similarity check...
```

**Implementation in `packages/core/src/search.ts`:**

Add a new function `expandConnections()`:

```typescript
interface ExpandedResult {
  id: string;
  score: number;
  memory: Record<string, unknown>;
  connected: {
    memory: Record<string, unknown>;
    relationship: string;
    depth: number;
    similarity: number;
  }[];
}

async function expandConnections(
  sqlite: Database.Database,
  results: SearchResult[],
  queryEmbedding: Float32Array,
  maxDepth: number = 3,
  similarityThreshold: number = 0.5,
): Promise<ExpandedResult[]> {
  const seen = new Set<string>(results.map(r => r.id));
  
  return results.map(result => {
    const connected: ExpandedResult["connected"] = [];
    const queue: { memoryId: string; depth: number }[] = [{ memoryId: result.id, depth: 0 }];
    
    while (queue.length > 0) {
      const { memoryId, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      
      // Get outgoing + incoming connections
      const outgoing = sqlite.prepare(
        `SELECT mc.target_memory_id as id, mc.relationship, m.*
         FROM memory_connections mc
         JOIN memories m ON m.id = mc.target_memory_id
         WHERE mc.source_memory_id = ? AND m.deleted_at IS NULL`
      ).all(memoryId);
      
      const incoming = sqlite.prepare(
        `SELECT mc.source_memory_id as id, mc.relationship, m.*
         FROM memory_connections mc
         JOIN memories m ON m.id = mc.source_memory_id
         WHERE mc.target_memory_id = ? AND m.deleted_at IS NULL`
      ).all(memoryId);
      
      for (const conn of [...outgoing, ...incoming]) {
        if (seen.has(conn.id)) continue;
        seen.add(conn.id);
        
        // Check semantic similarity to query
        const embedding = getStoredEmbedding(sqlite, conn.id);
        if (!embedding) continue;
        
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        if (similarity < similarityThreshold) continue;
        
        connected.push({
          memory: conn,
          relationship: conn.relationship,
          depth: depth + 1,
          similarity,
        });
        
        queue.push({ memoryId: conn.id, depth: depth + 1 });
      }
    }
    
    return { ...result, connected };
  });
}
```

You'll need a helper to retrieve stored embeddings:

```typescript
function getStoredEmbedding(sqlite: Database.Database, memoryId: string): Float32Array | null {
  const row = sqlite
    .prepare(`SELECT embedding FROM memory_embeddings WHERE memory_id = ?`)
    .get(memoryId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
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
```

**Update `hybridSearch` signature:**

```typescript
export async function hybridSearch(
  sqlite: Database.Database,
  query: string,
  options: {
    domain?: string;
    minConfidence?: number;
    limit?: number;
    expand?: boolean;        // NEW: default true
    maxDepth?: number;       // NEW: default 3
    similarityThreshold?: number; // NEW: default 0.5
  } = {},
): Promise<ExpandedResult[]>
```

**Update MCP tool schema:**

Add `expand` (boolean, default true) parameter to `memory_search`. When false, skip graph expansion for simple lookups.

### 2. Confidence-Weighted Scoring

In the RRF merge step of `hybridSearch`, apply a confidence boost after computing the raw RRF score:

```typescript
// After computing raw RRF scores in the scores Map:
// Apply confidence weighting
for (const [id, rawScore] of scores.entries()) {
  const mem = sqlite
    .prepare(`SELECT confidence FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { confidence: number } | undefined;
  if (mem) {
    // Boost range: 0.5x (confidence=0) to 1.0x (confidence=1.0)
    const boost = 0.5 + mem.confidence * 0.5;
    scores.set(id, rawScore * boost);
  }
}
```

This means a 99% confidence memory gets full score, while a 10% confidence memory gets ~55% of its raw score. High-confidence results float to the top without completely suppressing low-confidence ones.

### 3. Recency Boost

Add a mild recency factor alongside confidence. Recent memories are more likely to be relevant:

```typescript
function recencyBoost(learnedAt: string | null): number {
  if (!learnedAt) return 1.0;
  const ageMs = Date.now() - new Date(learnedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Decay from 1.1 (today) to 1.0 (30+ days old)
  // Recent memories get a 10% boost, old ones are neutral
  return 1.0 + Math.max(0, 0.1 * (1 - ageDays / 30));
}

// Apply after confidence boost:
const recency = recencyBoost(mem.learned_at);
scores.set(id, scores.get(id)! * recency);
```

### 4. Embedding Cache

Add an LRU cache for query embeddings in `packages/core/src/embeddings.ts`:

```typescript
const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  embedding: Float32Array;
  timestamp: number;
}

const embeddingCache = new Map<string, CacheEntry>();

export async function generateEmbedding(text: string): Promise<Float32Array> {
  // Check cache
  const cached = embeddingCache.get(text);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.embedding;
  }
  
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  const embedding = new Float32Array(output.data);
  
  // Store in cache, evict oldest if full
  if (embeddingCache.size >= CACHE_MAX) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey) embeddingCache.delete(oldestKey);
  }
  embeddingCache.set(text, { embedding, timestamp: Date.now() });
  
  return embedding;
}
```

This caches the most common case — an agent searching similar terms across a conversation.

### 5. Result Cache (DB-Level)

Track when the memory store was last modified:

In `packages/core/src/db.ts`, add a metadata table:

```sql
CREATE TABLE IF NOT EXISTS engrams_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO engrams_meta (key, value) VALUES ('last_modified', datetime('now'));
```

Create a trigger (or update in application code) that bumps `last_modified` on any write to `memories`:

```typescript
// In every write operation (insert, update, delete):
sqlite.prepare(`INSERT OR REPLACE INTO engrams_meta (key, value) VALUES ('last_modified', ?)`).run(now());
```

In `hybridSearch`, check the result cache:

```typescript
const resultCache = new Map<string, { results: ExpandedResult[]; lastModified: string }>();

// At start of hybridSearch:
const cacheKey = JSON.stringify({ query, ...options });
const currentLastModified = sqlite
  .prepare(`SELECT value FROM engrams_meta WHERE key = 'last_modified'`)
  .get() as { value: string } | undefined;

const cached = resultCache.get(cacheKey);
if (cached && cached.lastModified === currentLastModified?.value) {
  return cached.results;
}

// ... do search ...

// At end, store in cache:
if (currentLastModified) {
  resultCache.set(cacheKey, { results, lastModified: currentLastModified.value });
}
```

### 6. Stable Ordering for Prompt Cache Compatibility

Agents that call `memory_search` at conversation start with similar queries benefit from deterministic result ordering — the LLM provider can cache the prompt prefix.

**Rules for stable ordering:**
- Primary sort: RRF score descending (already done)
- Tie-breaker: memory ID ascending (deterministic)
- Connected memories within a result: sorted by similarity descending, then ID ascending
- Result format: consistent JSON structure, same field order every time

```typescript
// After RRF ranking:
rankedIds.sort((a, b) => {
  const scoreDiff = scores.get(b)! - scores.get(a)!;
  if (Math.abs(scoreDiff) > 1e-10) return scoreDiff;
  return a.localeCompare(b); // Deterministic tie-break
});
```

### 7. Return Useful Metadata

Update the `memory_search` response to include decision-helping metadata:

```typescript
return textResult({
  memories: results.map(r => ({
    ...r.memory,
    _searchScore: r.score,
    _connected: r.connected.map(c => ({
      ...c.memory,
      _relationship: c.relationship,
      _depth: c.depth,
      _similarity: c.similarity,
    })),
  })),
  count: results.length,
  totalConnected: results.reduce((sum, r) => sum + r.connected.length, 0),
  cached: wasCached, // Let the agent know this was a cache hit
});
```

The `_` prefix signals these are search metadata, not memory fields.

## File Changes Summary

| File | Changes |
|------|---------|
| `packages/core/src/search.ts` | Add `expandConnections()`, `getStoredEmbedding()`, `cosineSimilarity()`, confidence weighting, recency boost, result cache, stable ordering |
| `packages/core/src/embeddings.ts` | Add LRU embedding cache with TTL |
| `packages/core/src/db.ts` | Add `engrams_meta` table, `last_modified` tracking |
| `packages/core/src/index.ts` | Export new types (`ExpandedResult`) |
| `packages/mcp-server/src/server.ts` | Update `memory_search` tool: add `expand` param, pass through new options, return connected memories + metadata, bump `last_modified` on all writes |

## Verification

```bash
pnpm build && pnpm test
```

Then test in a Claude Code session:

1. **Graph expansion:** Create two memories and connect them. Search for one — the connected memory should appear in `_connected[]`.
2. **Relevance bounding:** Create a connection to an unrelated memory. Search — the unrelated connected memory should NOT appear (below similarity threshold).
3. **Confidence weighting:** Create two memories matching the same query, one at 0.90 confidence and one at 0.30. The high-confidence one should rank first.
4. **Caching:** Run the same search twice quickly. Second call should be faster (cache hit).
5. **Stable ordering:** Run the same search 3 times. Results should be in identical order every time.
6. **expand: false:** Search with `expand: false` — results should have no `_connected` field.

## Important Notes

- The `cosineSimilarity` function operates on stored embeddings, not re-generated ones. This is fast (~microseconds per comparison).
- Graph expansion is bounded by `maxDepth: 3` and `similarityThreshold: 0.5`. These are conservative defaults. If expansion returns too many results, raise the threshold. If too few, lower it.
- The embedding cache is in-process memory. It resets on server restart, which is fine — the cache rebuilds naturally from usage.
- The result cache invalidates on ANY write to the memory store. This is simple but correct. A more granular approach (invalidate only queries affected by the changed memory) is possible but not worth the complexity yet.
- All changes must be backward-compatible. Existing callers of `hybridSearch` and `memory_search` should work without modification — new parameters are optional with sensible defaults.
- Commit and push when complete.
