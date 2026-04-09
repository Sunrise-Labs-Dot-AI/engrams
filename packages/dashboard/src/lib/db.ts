import Database from "better-sqlite3";
import { resolve } from "path";
import { homedir } from "os";

let db: Database.Database | null = null;

export function getReadDb(): Database.Database {
  if (!db) {
    const dbPath = resolve(homedir(), ".engrams", "engrams.db");
    db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
  }
  return db;
}

export interface MemoryRow {
  id: string;
  content: string;
  detail: string | null;
  domain: string;
  source_agent_id: string;
  source_agent_name: string;
  cross_agent_id: string | null;
  cross_agent_name: string | null;
  source_type: string;
  source_description: string | null;
  confidence: number;
  confirmed_count: number;
  corrected_count: number;
  mistake_count: number;
  used_count: number;
  learned_at: string | null;
  confirmed_at: string | null;
  last_used_at: string | null;
  deleted_at: string | null;
}

export interface EventRow {
  id: string;
  memory_id: string;
  event_type: string;
  agent_id: string | null;
  agent_name: string | null;
  old_value: string | null;
  new_value: string | null;
  timestamp: string;
}

export interface ConnectionRow {
  source_memory_id: string;
  target_memory_id: string;
  relationship: string;
}

export interface PermissionRow {
  agent_id: string;
  domain: string;
  can_read: number;
  can_write: number;
}

export function getMemories(opts?: {
  domain?: string;
  sortBy?: "confidence" | "recency";
  search?: string;
}): MemoryRow[] {
  const db = getReadDb();

  if (opts?.search) {
    const ftsRows = db
      .prepare(
        `SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 100`,
      )
      .all(opts.search) as { rowid: number }[];

    if (ftsRows.length === 0) return [];

    const rowids = ftsRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    let q = `SELECT * FROM memories WHERE rowid IN (${placeholders}) AND deleted_at IS NULL`;
    const params: unknown[] = [...rowids];

    if (opts.domain) {
      q += ` AND domain = ?`;
      params.push(opts.domain);
    }

    q += ` ORDER BY confidence DESC`;
    return db.prepare(q).all(...params) as MemoryRow[];
  }

  let q = `SELECT * FROM memories WHERE deleted_at IS NULL`;
  const params: unknown[] = [];

  if (opts?.domain) {
    q += ` AND domain = ?`;
    params.push(opts.domain);
  }

  q +=
    opts?.sortBy === "recency"
      ? ` ORDER BY learned_at DESC`
      : ` ORDER BY confidence DESC`;

  return db.prepare(q).all(...params) as MemoryRow[];
}

export function getMemoryById(id: string): MemoryRow | undefined {
  const db = getReadDb();
  return db
    .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as MemoryRow | undefined;
}

export function getMemoryEvents(memoryId: string): EventRow[] {
  const db = getReadDb();
  return db
    .prepare(
      `SELECT * FROM memory_events WHERE memory_id = ? ORDER BY timestamp DESC`,
    )
    .all(memoryId) as EventRow[];
}

export function getMemoryConnections(memoryId: string): {
  outgoing: (ConnectionRow & { content: string })[];
  incoming: (ConnectionRow & { content: string })[];
} {
  const db = getReadDb();
  const outgoing = db
    .prepare(
      `SELECT mc.*, m.content FROM memory_connections mc
       JOIN memories m ON m.id = mc.target_memory_id
       WHERE mc.source_memory_id = ? AND m.deleted_at IS NULL`,
    )
    .all(memoryId) as (ConnectionRow & { content: string })[];

  const incoming = db
    .prepare(
      `SELECT mc.*, m.content FROM memory_connections mc
       JOIN memories m ON m.id = mc.source_memory_id
       WHERE mc.target_memory_id = ? AND m.deleted_at IS NULL`,
    )
    .all(memoryId) as (ConnectionRow & { content: string })[];

  return { outgoing, incoming };
}

export function getDomains(): { domain: string; count: number }[] {
  const db = getReadDb();
  return db
    .prepare(
      `SELECT domain, COUNT(*) as count FROM memories WHERE deleted_at IS NULL GROUP BY domain ORDER BY count DESC`,
    )
    .all() as { domain: string; count: number }[];
}

export function getAgentPermissions(): PermissionRow[] {
  const db = getReadDb();
  return db
    .prepare(`SELECT * FROM agent_permissions ORDER BY agent_id, domain`)
    .all() as PermissionRow[];
}

export function getAgents(): { agent_id: string; agent_name: string }[] {
  const db = getReadDb();
  return db
    .prepare(
      `SELECT DISTINCT source_agent_id as agent_id, source_agent_name as agent_name
       FROM memories WHERE deleted_at IS NULL ORDER BY agent_name`,
    )
    .all() as { agent_id: string; agent_name: string }[];
}

export function getDbStats(): {
  totalMemories: number;
  totalDomains: number;
  dbSizeBytes: number;
} {
  const db = getReadDb();
  const totalMemories = (
    db
      .prepare(`SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL`)
      .get() as { c: number }
  ).c;
  const totalDomains = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT domain) as c FROM memories WHERE deleted_at IS NULL`,
      )
      .get() as { c: number }
  ).c;

  const { size } = require("fs").statSync(
    resolve(homedir(), ".engrams", "engrams.db"),
  );
  return { totalMemories, totalDomains, dbSizeBytes: size };
}

export function getAllMemoriesForExport(): MemoryRow[] {
  const db = getReadDb();
  return db
    .prepare(`SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY domain, confidence DESC`)
    .all() as MemoryRow[];
}
