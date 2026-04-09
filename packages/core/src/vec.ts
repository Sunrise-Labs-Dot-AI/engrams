import { createRequire } from "module";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);

export const EMBEDDING_DIM = 384;

export function setupVec(sqlite: Database.Database): boolean {
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(sqlite);

    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIM}]
      );
    `);

    return true;
  } catch (err) {
    process.stderr.write(
      `[engrams] sqlite-vec not available — vector search disabled, falling back to FTS5 only: ${err}\n`,
    );
    return false;
  }
}

function toBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function insertEmbedding(
  sqlite: Database.Database,
  memoryId: string,
  embedding: Float32Array,
): void {
  sqlite
    .prepare(`INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`)
    .run(memoryId, toBuffer(embedding));
}

export function deleteEmbedding(sqlite: Database.Database, memoryId: string): void {
  sqlite.prepare(`DELETE FROM memory_embeddings WHERE memory_id = ?`).run(memoryId);
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
    .all(toBuffer(queryEmbedding), limit) as {
    memory_id: string;
    distance: number;
  }[];
}
