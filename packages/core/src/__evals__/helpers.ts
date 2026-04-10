import { existsSync, copyFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir, homedir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import type { Client } from "@libsql/client";
import type { EngramsDatabase } from "../db.js";

const REAL_DB_PATH = resolve(homedir(), ".engrams", "engrams.db");

export function tempDbPath(prefix = "engrams-eval"): string {
  return resolve(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.db`);
}

/**
 * Copy the user's real database to a temp location for read-only eval tests.
 * Returns null if no real DB exists (e.g. CI).
 */
export function copyRealDb(): string | null {
  if (!existsSync(REAL_DB_PATH)) return null;
  const dest = tempDbPath("engrams-eval-real");
  copyFileSync(REAL_DB_PATH, dest);
  // Copy WAL/SHM if they exist (for consistent state)
  if (existsSync(REAL_DB_PATH + "-wal")) {
    copyFileSync(REAL_DB_PATH + "-wal", dest + "-wal");
  }
  if (existsSync(REAL_DB_PATH + "-shm")) {
    copyFileSync(REAL_DB_PATH + "-shm", dest + "-shm");
  }
  return dest;
}

/**
 * Open a copied real DB. Returns the client handle + cleanup function.
 */
export async function openRealDb() {
  const dbPath = copyRealDb();
  if (!dbPath) return null;
  const { client } = await createDatabase({ url: "file:" + dbPath });
  return {
    client,
    dbPath,
    cleanup: () => cleanupDb(dbPath, client),
  };
}

/**
 * Create a fresh empty test DB with all tables/indexes set up.
 */
export async function createTestDb() {
  const dbPath = tempDbPath("engrams-eval-test");
  const { db, client, vecAvailable } = await createDatabase({ url: "file:" + dbPath });
  return {
    db,
    client,
    vecAvailable,
    dbPath,
    cleanup: () => cleanupDb(dbPath, client),
  };
}

export function cleanupDb(dbPath: string, client: Client) {
  try {
    client.close();
  } catch {
    // already closed
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    } catch {
      // best-effort
    }
  }
}

export async function insertMemory(
  client: Client,
  id: string,
  content: string,
  opts: {
    detail?: string | null;
    confidence?: number;
    domain?: string;
    entityType?: string;
    entityName?: string;
    learnedAt?: string;
    sourceAgentId?: string;
    sourceAgentName?: string;
  } = {},
) {
  await client.execute({
    sql: `INSERT INTO memories (id, content, detail, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, entity_type, entity_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      content,
      opts.detail ?? null,
      opts.domain ?? "general",
      opts.sourceAgentId ?? "eval-agent",
      opts.sourceAgentName ?? "eval",
      "stated",
      opts.confidence ?? 0.9,
      opts.learnedAt ?? new Date().toISOString(),
      opts.entityType ?? null,
      opts.entityName ?? null,
    ],
  });
}

export function generateId(): string {
  return randomBytes(16).toString("hex");
}
