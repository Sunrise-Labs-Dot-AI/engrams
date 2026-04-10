import type { Client } from "@libsql/client";
import { encrypt, decrypt } from "./crypto.js";

const BATCH_SIZE = 100;

/**
 * Migrate all data from a local database to a cloud (Turso) database.
 * Encrypts content, detail, and structured_data fields.
 * Embeddings are copied as-is (not sensitive).
 * Idempotent via INSERT OR REPLACE.
 */
export async function migrateToCloud(
  localClient: Client,
  cloudClient: Client,
  encryptionKey: Buffer,
  onProgress?: (msg: string) => void,
): Promise<{ migrated: number }> {
  let migrated = 0;

  // Initialize schema on destination
  await initSchema(cloudClient);

  // --- Memories ---
  const memoriesResult = await localClient.execute({
    sql: `SELECT * FROM memories WHERE deleted_at IS NULL`,
    args: [],
  });
  const memories = memoriesResult.rows;
  onProgress?.(`Migrating ${memories.length} memories...`);

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    for (const mem of batch) {
      const encContent = encrypt(mem.content as string, encryptionKey);
      const encDetail = mem.detail ? encrypt(mem.detail as string, encryptionKey) : null;
      const encStructured = mem.structured_data ? encrypt(mem.structured_data as string, encryptionKey) : null;

      await cloudClient.execute({
        sql: `INSERT OR REPLACE INTO memories
          (id, content, detail, domain, source_agent_id, source_agent_name,
           cross_agent_id, cross_agent_name, source_type, source_description,
           confidence, confirmed_count, corrected_count, mistake_count, used_count,
           learned_at, confirmed_at, last_used_at, deleted_at,
           has_pii_flag, entity_type, entity_name, structured_data, embedding, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          mem.id as string, encContent, encDetail,
          mem.domain as string, mem.source_agent_id as string, mem.source_agent_name as string,
          (mem.cross_agent_id as string | null) ?? null, (mem.cross_agent_name as string | null) ?? null,
          mem.source_type as string, (mem.source_description as string | null) ?? null,
          mem.confidence as number,
          mem.confirmed_count as number, mem.corrected_count as number,
          mem.mistake_count as number, mem.used_count as number,
          (mem.learned_at as string | null) ?? null, (mem.confirmed_at as string | null) ?? null,
          (mem.last_used_at as string | null) ?? null, (mem.deleted_at as string | null) ?? null,
          (mem.has_pii_flag as number) ?? 0, (mem.entity_type as string | null) ?? null,
          (mem.entity_name as string | null) ?? null, encStructured,
          mem.embedding ?? null,
          (mem.updated_at as string | null) ?? null,
        ],
      });
      migrated++;
    }
    onProgress?.(`Migrated ${Math.min(i + BATCH_SIZE, memories.length)}/${memories.length} memories...`);
  }

  // --- Memory Connections ---
  const connectionsResult = await localClient.execute({
    sql: `SELECT * FROM memory_connections`,
    args: [],
  });
  const connections = connectionsResult.rows;
  onProgress?.(`Migrating ${connections.length} connections...`);

  for (let i = 0; i < connections.length; i += BATCH_SIZE) {
    const batch = connections.slice(i, i + BATCH_SIZE);
    for (const conn of batch) {
      await cloudClient.execute({
        sql: `INSERT OR REPLACE INTO memory_connections
          (source_memory_id, target_memory_id, relationship, updated_at)
          VALUES (?, ?, ?, ?)`,
        args: [
          conn.source_memory_id as string, conn.target_memory_id as string,
          conn.relationship as string, (conn.updated_at as string | null) ?? null,
        ],
      });
      migrated++;
    }
  }

  // --- Memory Events ---
  const eventsResult = await localClient.execute({
    sql: `SELECT * FROM memory_events`,
    args: [],
  });
  const events = eventsResult.rows;
  onProgress?.(`Migrating ${events.length} events...`);

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    for (const evt of batch) {
      await cloudClient.execute({
        sql: `INSERT OR REPLACE INTO memory_events
          (id, memory_id, event_type, agent_id, agent_name, old_value, new_value, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          evt.id as string, evt.memory_id as string, evt.event_type as string,
          (evt.agent_id as string | null) ?? null, (evt.agent_name as string | null) ?? null,
          (evt.old_value as string | null) ?? null, (evt.new_value as string | null) ?? null,
          evt.timestamp as string,
        ],
      });
      migrated++;
    }
  }

  // --- Agent Permissions ---
  const permsResult = await localClient.execute({
    sql: `SELECT * FROM agent_permissions`,
    args: [],
  });
  const perms = permsResult.rows;
  onProgress?.(`Migrating ${perms.length} agent permissions...`);

  for (const perm of perms) {
    await cloudClient.execute({
      sql: `INSERT OR REPLACE INTO agent_permissions
        (agent_id, domain, can_read, can_write)
        VALUES (?, ?, ?, ?)`,
      args: [
        perm.agent_id as string, perm.domain as string,
        perm.can_read as number, perm.can_write as number,
      ],
    });
    migrated++;
  }

  // --- Engrams Meta ---
  const metaResult = await localClient.execute({
    sql: `SELECT * FROM engrams_meta`,
    args: [],
  });
  for (const meta of metaResult.rows) {
    await cloudClient.execute({
      sql: `INSERT OR REPLACE INTO engrams_meta (key, value) VALUES (?, ?)`,
      args: [meta.key as string, meta.value as string],
    });
    migrated++;
  }

  onProgress?.(`Migration complete: ${migrated} records migrated to cloud.`);
  return { migrated };
}

/**
 * Migrate all data from a cloud (Turso) database to a local database.
 * Decrypts content, detail, and structured_data fields.
 * Embeddings are copied as-is.
 * Idempotent via INSERT OR REPLACE.
 */
export async function migrateToLocal(
  cloudClient: Client,
  localClient: Client,
  encryptionKey: Buffer,
  onProgress?: (msg: string) => void,
): Promise<{ migrated: number }> {
  let migrated = 0;

  // Initialize schema on destination
  await initSchema(localClient);

  // --- Memories ---
  const memoriesResult = await cloudClient.execute({
    sql: `SELECT * FROM memories`,
    args: [],
  });
  const memories = memoriesResult.rows;
  onProgress?.(`Migrating ${memories.length} memories...`);

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    for (const mem of batch) {
      const decContent = decrypt(mem.content as string, encryptionKey);
      const decDetail = mem.detail ? decrypt(mem.detail as string, encryptionKey) : null;
      const decStructured = mem.structured_data ? decrypt(mem.structured_data as string, encryptionKey) : null;

      await localClient.execute({
        sql: `INSERT OR REPLACE INTO memories
          (id, content, detail, domain, source_agent_id, source_agent_name,
           cross_agent_id, cross_agent_name, source_type, source_description,
           confidence, confirmed_count, corrected_count, mistake_count, used_count,
           learned_at, confirmed_at, last_used_at, deleted_at,
           has_pii_flag, entity_type, entity_name, structured_data, embedding, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          mem.id as string, decContent, decDetail,
          mem.domain as string, mem.source_agent_id as string, mem.source_agent_name as string,
          (mem.cross_agent_id as string | null) ?? null, (mem.cross_agent_name as string | null) ?? null,
          mem.source_type as string, (mem.source_description as string | null) ?? null,
          mem.confidence as number,
          mem.confirmed_count as number, mem.corrected_count as number,
          mem.mistake_count as number, mem.used_count as number,
          (mem.learned_at as string | null) ?? null, (mem.confirmed_at as string | null) ?? null,
          (mem.last_used_at as string | null) ?? null, (mem.deleted_at as string | null) ?? null,
          (mem.has_pii_flag as number) ?? 0, (mem.entity_type as string | null) ?? null,
          (mem.entity_name as string | null) ?? null, decStructured,
          mem.embedding ?? null,
          (mem.updated_at as string | null) ?? null,
        ],
      });
      migrated++;
    }
    onProgress?.(`Migrated ${Math.min(i + BATCH_SIZE, memories.length)}/${memories.length} memories...`);
  }

  // --- Memory Connections ---
  const connectionsResult = await cloudClient.execute({
    sql: `SELECT * FROM memory_connections`,
    args: [],
  });
  for (const conn of connectionsResult.rows) {
    await localClient.execute({
      sql: `INSERT OR REPLACE INTO memory_connections
        (source_memory_id, target_memory_id, relationship, updated_at)
        VALUES (?, ?, ?, ?)`,
      args: [
        conn.source_memory_id as string, conn.target_memory_id as string,
        conn.relationship as string, (conn.updated_at as string | null) ?? null,
      ],
    });
    migrated++;
  }

  // --- Memory Events ---
  const eventsResult = await cloudClient.execute({
    sql: `SELECT * FROM memory_events`,
    args: [],
  });
  for (const evt of eventsResult.rows) {
    await localClient.execute({
      sql: `INSERT OR REPLACE INTO memory_events
        (id, memory_id, event_type, agent_id, agent_name, old_value, new_value, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        evt.id as string, evt.memory_id as string, evt.event_type as string,
        (evt.agent_id as string | null) ?? null, (evt.agent_name as string | null) ?? null,
        (evt.old_value as string | null) ?? null, (evt.new_value as string | null) ?? null,
        evt.timestamp as string,
      ],
    });
    migrated++;
  }

  // --- Agent Permissions ---
  const permsResult = await cloudClient.execute({
    sql: `SELECT * FROM agent_permissions`,
    args: [],
  });
  for (const perm of permsResult.rows) {
    await localClient.execute({
      sql: `INSERT OR REPLACE INTO agent_permissions
        (agent_id, domain, can_read, can_write)
        VALUES (?, ?, ?, ?)`,
      args: [
        perm.agent_id as string, perm.domain as string,
        perm.can_read as number, perm.can_write as number,
      ],
    });
    migrated++;
  }

  // --- Engrams Meta ---
  const metaResult = await cloudClient.execute({
    sql: `SELECT * FROM engrams_meta`,
    args: [],
  });
  for (const meta of metaResult.rows) {
    await localClient.execute({
      sql: `INSERT OR REPLACE INTO engrams_meta (key, value) VALUES (?, ?)`,
      args: [meta.key as string, meta.value as string],
    });
    migrated++;
  }

  onProgress?.(`Migration complete: ${migrated} records migrated to local.`);
  return { migrated };
}

/**
 * Initialize the full Engrams schema on a destination database.
 * Idempotent — safe to call multiple times.
 */
async function initSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      detail TEXT,
      domain TEXT NOT NULL DEFAULT 'general',
      source_agent_id TEXT NOT NULL,
      source_agent_name TEXT NOT NULL,
      cross_agent_id TEXT,
      cross_agent_name TEXT,
      source_type TEXT NOT NULL,
      source_description TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      confirmed_count INTEGER NOT NULL DEFAULT 0,
      corrected_count INTEGER NOT NULL DEFAULT 0,
      mistake_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      learned_at TEXT,
      confirmed_at TEXT,
      last_used_at TEXT,
      deleted_at TEXT,
      has_pii_flag INTEGER NOT NULL DEFAULT 0,
      entity_type TEXT,
      entity_name TEXT,
      structured_data TEXT,
      embedding F32_BLOB(384),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_connections (
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_permissions (
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      can_read INTEGER NOT NULL DEFAULT 1,
      can_write INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS engrams_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO engrams_meta (key, value) VALUES ('last_modified', datetime('now'));
  `);

  // FTS5
  await client.executeMultiple(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      detail,
      source_agent_name,
      entity_name,
      content='memories',
      content_rowid='rowid'
    );
  `);

  // Vector index
  try {
    await client.execute({
      sql: `CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories (libsql_vector_idx(embedding))`,
      args: [],
    });
  } catch {
    // Vector index may not be supported or may already exist
  }
}
