# Handoff: V2 — Embedding Pipeline + Vector Search + Hybrid Search

**Repo:** `Sunrise-Labs-Dot-AI/engrams` (local at `~/Documents/Claude/Projects/engrams`)
**Branch:** `main`
**Budget:** $10
**Timeout:** 25 min

## Context

Engrams V1 is complete and running: MCP server with 12 tools, SQLite + FTS5, counter-based confidence, server-side dedup, auto usage tracking, Next.js dashboard. Users are actively seeding memories across multiple projects.

**The problem:** FTS5 is keyword-only. "I like early meetings" won't find a memory containing "prefers morning meetings." Dedup also misses semantically identical memories phrased differently. This milestone adds an embedding pipeline so search and dedup work on meaning, not just keywords.

Read `CLAUDE.md` in the repo root for full product context.

## What We're Building

1. **Embedding pipeline** — generate 384-dim vectors for every memory using a local model
2. **Vector storage** — store embeddings in sqlite-vec for cosine similarity search
3. **Hybrid search** — combine FTS5 keyword results + vector similarity via Reciprocal Rank Fusion
4. **Smarter dedup** — use cosine similarity for duplicate detection in `memory_write`
5. **Lazy backfill** — generate embeddings for existing memories that don't have them yet

## Architecture

```
memory_write → generate embedding → store in sqlite-vec
                                  → store memory in SQLite

memory_search → FTS5 keyword search → ranked results ─┐
             → sqlite-vec cosine    → ranked results ──┤
                                                       ├→ RRF merge → return top-N
```

## Step 1: Add Dependencies

**packages/core:**
```bash
pnpm add @anthropic-ai/tokenizer  # NOT needed — just listing what we're NOT using
pnpm add onnxruntime-node          # ONNX runtime for running the model
```

Actually, use **@xenova/transformers** (now `@huggingface/transformers`) for the embedding model. It bundles ONNX runtime and handles model download/caching:

```bash
# In packages/core
pnpm add @huggingface/transformers

# In packages/core (for sqlite-vec)
pnpm add sqlite-vec
```

**Important version notes:**
- `@huggingface/transformers` is the renamed `@xenova/transformers` — use the latest version
- `sqlite-vec` is a Node.js binding for the sqlite-vec SQLite extension — check npm for the current package name, it may be `sqlite-vec` or `@anthropic-ai/sqlite-vec` or similar. Search npm and use whatever is available. If no npm package exists, use the prebuilt binary approach (download `.dylib`/`.so` and load via `sqlite.loadExtension()`)

## Step 2: Embedding Pipeline (`packages/core/src/embeddings.ts`)

```typescript
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolve } from "path";
import { homedir } from "os";

let embedder: FeatureExtractionPipeline | null = null;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

export { EMBEDDING_DIM };

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    const cacheDir = resolve(homedir(), ".engrams", "models");
    embedder = await pipeline("feature-extraction", MODEL_ID, {
      cache_dir: cacheDir,
      quantized: true,  // Use quantized (q8) model for CPU
    });
  }
  return embedder;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  const model = await getEmbedder();
  const results: Float32Array[] = [];
  // Batch for efficiency but don't OOM — process in chunks of 32
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    for (const text of batch) {
      const output = await model(text, { pooling: "mean", normalize: true });
      results.push(new Float32Array(output.data));
    }
  }
  return results;
}
```

**Model details:**
- `Xenova/all-MiniLM-L6-v2` — 384 dimensions, ~22MB quantized, ~85% STS-B accuracy
- Downloads on first use to `~/.engrams/models/`
- Runs entirely local — no API calls, no cost
- Quantized (q8) for CPU performance

## Step 3: sqlite-vec Setup (`packages/core/src/vec.ts`)

```typescript
import type Database from "better-sqlite3";

export const EMBEDDING_DIM = 384;

export function setupVec(sqlite: Database.Database): void {
  // Load the sqlite-vec extension
  // Method depends on how sqlite-vec is installed:
  // Option A: npm package provides loadable path
  // Option B: load from a known system path
  // Try the npm package approach first:
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(sqlite);
  } catch {
    // Fallback: try loading as extension
    // sqlite.loadExtension("vec0");
    console.error("sqlite-vec not available — vector search disabled, falling back to FTS5 only");
    return;
  }

  // Create the virtual table for vector search
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    );
  `);
}

export function insertEmbedding(
  sqlite: Database.Database,
  memoryId: string,
  embedding: Float32Array,
): void {
  sqlite
    .prepare(`INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`)
    .run(memoryId, Buffer.from(embedding.buffer));
}

export function searchVec(
  sqlite: Database.Database,
  queryEmbedding: Float32Array,
  limit = 20,
): { memory_id: string; distance: number }[] {
  return sqlite
    .prepare(
      `SELECT memory_id, distance FROM memory_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(Buffer.from(queryEmbedding.buffer), limit) as {
    memory_id: string;
    distance: number;
  }[];
}
```

**Critical notes on sqlite-vec:**
- sqlite-vec uses `vec0` virtual table type
- Embeddings are stored as raw float buffers — use `Buffer.from(float32Array.buffer)` to convert
- `MATCH` operator does cosine similarity search
- `distance` is cosine distance (lower = more similar)
- The extension must be loaded before creating the virtual table
- If sqlite-vec isn't available, the server should gracefully fall back to FTS5 only — don't crash

## Step 4: Hybrid Search with Reciprocal Rank Fusion (`packages/core/src/search.ts`)

```typescript
import type Database from "better-sqlite3";
import { searchFTS } from "./fts.js";
import { searchVec, EMBEDDING_DIM } from "./vec.js";
import { generateEmbedding } from "./embeddings.js";

const RRF_K = 60; // Standard RRF constant

interface SearchResult {
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
  const fetchLimit = limit * 3; // Over-fetch for RRF merge

  // 1. FTS5 keyword search
  const ftsResults = searchFTS(sqlite, query, fetchLimit);
  const ftsIds: string[] = [];
  if (ftsResults.length > 0) {
    const rowids = ftsResults.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const rows = sqlite
      .prepare(`SELECT id FROM memories WHERE rowid IN (${placeholders}) AND deleted_at IS NULL`)
      .all(...rowids) as { id: string }[];
    ftsIds.push(...rows.map((r) => r.id));
  }

  // 2. Vector similarity search (if sqlite-vec is available)
  let vecIds: string[] = [];
  try {
    const queryEmbedding = await generateEmbedding(query);
    const vecResults = searchVec(sqlite, queryEmbedding, fetchLimit);
    vecIds = vecResults.map((r) => r.memory_id);
  } catch {
    // sqlite-vec not available or embedding failed — FTS5 only
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
```

## Step 5: Update `memory_write` — Generate Embedding on Write

In `packages/mcp-server/src/server.ts`, after inserting the memory:

```typescript
// After db.insert(memories)...
// Generate and store embedding (async, non-blocking for the response)
try {
  const { generateEmbedding } = await import("@engrams/core");
  const { insertEmbedding } = await import("@engrams/core");
  const embedding = await generateEmbedding(params.content + (params.detail ? " " + params.detail : ""));
  insertEmbedding(sqlite, id, embedding);
} catch {
  // Embedding generation failed — memory is still saved, just without vector search
}
```

## Step 6: Update `memory_search` — Use Hybrid Search

Replace the current FTS5-only search in the `memory_search` tool handler with:

```typescript
const { hybridSearch } = await import("@engrams/core");
const results = await hybridSearch(sqlite, params.query, {
  domain: params.domain,
  minConfidence: params.minConfidence,
  limit: params.limit ?? 20,
});
// Auto-track usage (existing logic) on results...
```

## Step 7: Update Dedup — Use Cosine Similarity

In the `memory_write` dedup check, replace FTS5 dedup with vector similarity:

```typescript
if (!params.force) {
  try {
    const embedding = await generateEmbedding(params.content);
    const similar = searchVec(sqlite, embedding, 3);
    // Cosine distance < 0.3 means very similar (> 0.85 cosine similarity)
    const closeMatches = similar.filter((s) => s.distance < 0.3);
    if (closeMatches.length > 0) {
      const existing = sqlite
        .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
        .get(closeMatches[0].memory_id);
      if (existing) {
        return textResult({
          duplicate_detected: true,
          existing_memory: existing,
          similarity: 1 - closeMatches[0].distance,
          message: "A semantically similar memory already exists...",
        });
      }
    }
  } catch {
    // Fall back to FTS5 dedup if vector search unavailable
    // ... existing FTS5 dedup code ...
  }
}
```

## Step 8: Backfill Existing Memories

Add a function to `packages/core/src/embeddings.ts`:

```typescript
export async function backfillEmbeddings(
  sqlite: Database.Database,
): Promise<number> {
  // Find memories without embeddings
  const missing = sqlite
    .prepare(`
      SELECT m.id, m.content, m.detail FROM memories m
      LEFT JOIN memory_embeddings e ON m.id = e.memory_id
      WHERE m.deleted_at IS NULL AND e.memory_id IS NULL
    `)
    .all() as { id: string; content: string; detail: string | null }[];

  for (const mem of missing) {
    const text = mem.content + (mem.detail ? " " + mem.detail : "");
    const embedding = await generateEmbedding(text);
    insertEmbedding(sqlite, mem.id, embedding);
  }

  return missing.length;
}
```

Call this on server startup (after sqlite-vec setup) to backfill any memories created before V2:

```typescript
// In startServer(), after setupVec:
backfillEmbeddings(sqlite).then((count) => {
  if (count > 0) process.stderr.write(`Backfilled embeddings for ${count} memories\n`);
}).catch(() => {});
```

## Step 9: Update Database Init

In `packages/core/src/db.ts`, add sqlite-vec setup:

```typescript
import { setupVec } from "./vec.js";

// In createDatabase(), after setupFTS:
setupVec(sqlite);
```

## Step 10: Export New Modules

In `packages/core/src/index.ts`, add:

```typescript
export { generateEmbedding, generateEmbeddings, getEmbedder, backfillEmbeddings } from "./embeddings.js";
export { setupVec, insertEmbedding, searchVec, EMBEDDING_DIM } from "./vec.js";
export { hybridSearch } from "./search.js";
```

## Graceful Degradation

**This is critical:** The embedding pipeline and sqlite-vec are additive. If either fails (model download interrupted, sqlite-vec not available on the platform), the server MUST fall back to FTS5-only search. Never crash the MCP server because embeddings aren't available.

Pattern:
- `setupVec` catches errors and logs a warning
- `hybridSearch` catches vector search errors and returns FTS5 results only
- `memory_write` catches embedding errors and saves the memory without a vector
- `backfillEmbeddings` is best-effort, runs async on startup

## Verification

```bash
pnpm build && pnpm test
```

Then in a Claude Code session with Engrams connected:

1. **Search with synonyms:** Write a memory "I protect Wednesday mornings for deep work", then search "deep focus time schedule" — should find it via embedding similarity even though no keywords match
2. **Dedup with paraphrasing:** Try writing "I like to keep Wednesday mornings free for focused work" — should detect as duplicate of the existing memory
3. **Backfill:** Existing memories from V1 should have embeddings generated on server restart
4. **Fallback:** If you remove sqlite-vec, the server should still work with FTS5 only

## Notes

- First run will download the model (~22MB) to `~/.engrams/models/`. This takes a few seconds. Subsequent runs are instant (cached).
- The embedding is generated from `content + detail` concatenated. This gives the vector richer context than content alone.
- sqlite-vec is pre-v1 and may have platform-specific issues. The graceful fallback to FTS5 is the safety net.
- RRF with k=60 is the standard constant from the original paper. No tuning needed.
- Cosine distance threshold of 0.3 for dedup (~0.85 similarity) is conservative. Can be tuned after dogfooding.
