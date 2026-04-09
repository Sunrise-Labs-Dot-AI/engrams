import Database from "better-sqlite3";
import { resolve } from "path";
import { homedir } from "os";

let readDb: Database.Database | null = null;
let writeDb: Database.Database | null = null;

function getDbPath(): string {
  return resolve(homedir(), ".engrams", "engrams.db");
}

export function getReadDb(): Database.Database {
  if (!readDb) {
    readDb = new Database(getDbPath(), { readonly: true });
    readDb.pragma("journal_mode = WAL");
  }
  return readDb;
}

export function getWriteDb(): Database.Database {
  if (!writeDb) {
    writeDb = new Database(getDbPath());
    writeDb.pragma("journal_mode = WAL");
    writeDb.pragma("foreign_keys = ON");
  }
  return writeDb;
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
  sortBy?: "confidence" | "recency" | "used" | "learned";
  search?: string;
  sourceType?: string;
  minConfidence?: number;
  maxConfidence?: number;
  unused?: boolean;
}): MemoryRow[] {
  const db = getReadDb();

  function applyFilters(q: string, params: unknown[]): { q: string; params: unknown[] } {
    if (opts?.domain) {
      q += ` AND domain = ?`;
      params.push(opts.domain);
    }
    if (opts?.sourceType) {
      q += ` AND source_type = ?`;
      params.push(opts.sourceType);
    }
    if (opts?.minConfidence !== undefined) {
      q += ` AND confidence >= ?`;
      params.push(opts.minConfidence);
    }
    if (opts?.maxConfidence !== undefined) {
      q += ` AND confidence <= ?`;
      params.push(opts.maxConfidence);
    }
    if (opts?.unused) {
      q += ` AND used_count = 0`;
    }
    return { q, params };
  }

  function applySort(q: string): string {
    switch (opts?.sortBy) {
      case "recency": return q + ` ORDER BY learned_at DESC`;
      case "used": return q + ` ORDER BY used_count DESC, confidence DESC`;
      case "learned": return q + ` ORDER BY learned_at ASC`;
      default: return q + ` ORDER BY confidence DESC`;
    }
  }

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
    let params: unknown[] = [...rowids];
    ({ q, params } = applyFilters(q, params));
    q = applySort(q);
    return db.prepare(q).all(...params) as MemoryRow[];
  }

  let q = `SELECT * FROM memories WHERE deleted_at IS NULL`;
  let params: unknown[] = [];
  ({ q, params } = applyFilters(q, params));
  q = applySort(q);
  return db.prepare(q).all(...params) as MemoryRow[];
}

export function getSourceTypes(): string[] {
  const db = getReadDb();
  const rows = db
    .prepare(`SELECT DISTINCT source_type FROM memories WHERE deleted_at IS NULL ORDER BY source_type`)
    .all() as { source_type: string }[];
  return rows.map((r) => r.source_type);
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

// --- Write operations ---

function generateId(): string {
  return require("crypto").randomBytes(16).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

export function deleteMemoryById(id: string): boolean {
  const db = getWriteDb();
  const timestamp = now();
  const result = db
    .prepare(`UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(timestamp, id);
  if (result.changes > 0) {
    db.prepare(
      `INSERT INTO memory_events (id, memory_id, event_type, agent_name, new_value, timestamp) VALUES (?, ?, 'removed', 'dashboard', ?, ?)`,
    ).run(generateId(), id, JSON.stringify({ reason: "deleted via dashboard" }), timestamp);
  }
  return result.changes > 0;
}

export function confirmMemoryById(id: string): { newConfidence: number } | null {
  const db = getWriteDb();
  const existing = db
    .prepare(`SELECT confidence, confirmed_count FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { confidence: number; confirmed_count: number } | undefined;
  if (!existing) return null;

  const newConfidence = Math.min(existing.confidence + 0.05, 0.99);
  const timestamp = now();
  db.prepare(
    `UPDATE memories SET confidence = ?, confirmed_count = ?, confirmed_at = ? WHERE id = ?`,
  ).run(newConfidence, existing.confirmed_count + 1, timestamp, id);
  db.prepare(
    `INSERT INTO memory_events (id, memory_id, event_type, agent_name, old_value, new_value, timestamp) VALUES (?, ?, 'confirmed', 'dashboard', ?, ?, ?)`,
  ).run(generateId(), id, JSON.stringify({ confidence: existing.confidence }), JSON.stringify({ confidence: newConfidence }), timestamp);
  return { newConfidence };
}

export function flagMemoryById(id: string): { newConfidence: number } | null {
  const db = getWriteDb();
  const existing = db
    .prepare(`SELECT confidence, mistake_count FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { confidence: number; mistake_count: number } | undefined;
  if (!existing) return null;

  const newConfidence = Math.max(existing.confidence - 0.15, 0.10);
  const timestamp = now();
  db.prepare(
    `UPDATE memories SET confidence = ?, mistake_count = ? WHERE id = ?`,
  ).run(newConfidence, existing.mistake_count + 1, id);
  db.prepare(
    `INSERT INTO memory_events (id, memory_id, event_type, agent_name, old_value, new_value, timestamp) VALUES (?, ?, 'confidence_changed', 'dashboard', ?, ?, ?)`,
  ).run(generateId(), id, JSON.stringify({ confidence: existing.confidence }), JSON.stringify({ confidence: newConfidence, flaggedAsMistake: true }), timestamp);
  return { newConfidence };
}

export function correctMemoryById(id: string, content: string, detail?: string | null): { newConfidence: number } | null {
  const db = getWriteDb();
  const existing = db
    .prepare(`SELECT content, detail, confidence, corrected_count FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { content: string; detail: string | null; confidence: number; corrected_count: number } | undefined;
  if (!existing) return null;

  const newConfidence = Math.min(Math.max(existing.confidence, 0.85), 0.99);
  const timestamp = now();
  const newDetail = detail !== undefined ? detail : existing.detail;
  db.prepare(
    `UPDATE memories SET content = ?, detail = ?, confidence = ?, corrected_count = ? WHERE id = ?`,
  ).run(content, newDetail, newConfidence, existing.corrected_count + 1, id);
  db.prepare(
    `INSERT INTO memory_events (id, memory_id, event_type, agent_name, old_value, new_value, timestamp) VALUES (?, ?, 'corrected', 'dashboard', ?, ?, ?)`,
  ).run(generateId(), id, JSON.stringify({ content: existing.content, detail: existing.detail }), JSON.stringify({ content, detail: newDetail, confidence: newConfidence }), timestamp);
  return { newConfidence };
}

export function splitMemoryById(
  id: string,
  parts: { content: string; detail?: string | null }[],
): { newIds: string[] } | null {
  const db = getWriteDb();
  const existing = db
    .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as MemoryRow | undefined;
  if (!existing) return null;

  const timestamp = now();
  const newIds: string[] = [];

  for (const part of parts) {
    const newId = generateId();
    newIds.push(newId);
    const confidence = Math.min((existing.confidence || 0.7) + 0.05, 0.99);

    db.prepare(
      `INSERT INTO memories (id, content, detail, domain, source_agent_id, source_agent_name, source_type, source_description, confidence, learned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId,
      part.content,
      part.detail ?? null,
      existing.domain,
      existing.source_agent_id,
      existing.source_agent_name,
      existing.source_type,
      existing.source_description,
      confidence,
      timestamp,
    );

    db.prepare(
      `INSERT INTO memory_events (id, memory_id, event_type, agent_name, new_value, timestamp) VALUES (?, ?, 'created', 'dashboard', ?, ?)`,
    ).run(generateId(), newId, JSON.stringify({ content: part.content, splitFrom: id }), timestamp);
  }

  // Connect new memories to each other
  for (let i = 0; i < newIds.length; i++) {
    for (let j = i + 1; j < newIds.length; j++) {
      db.prepare(
        `INSERT INTO memory_connections (source_memory_id, target_memory_id, relationship) VALUES (?, ?, 'related')`,
      ).run(newIds[i], newIds[j]);
    }
  }

  // Soft-delete original
  db.prepare(`UPDATE memories SET deleted_at = ? WHERE id = ?`).run(timestamp, id);
  db.prepare(
    `INSERT INTO memory_events (id, memory_id, event_type, agent_name, new_value, timestamp) VALUES (?, ?, 'removed', 'dashboard', ?, ?)`,
  ).run(generateId(), id, JSON.stringify({ reason: "split", splitInto: newIds }), timestamp);

  return { newIds };
}

export function clearAllMemories(): void {
  const db = getWriteDb();
  const timestamp = now();
  db.prepare(`UPDATE memories SET deleted_at = ? WHERE deleted_at IS NULL`).run(timestamp);
}
