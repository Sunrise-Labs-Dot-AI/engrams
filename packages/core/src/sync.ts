import { createClient, type Client } from "@libsql/client";
import type Database from "better-sqlite3";
import { encryptMemory, decryptMemory, type EncryptionKeys } from "./crypto.js";

export interface SyncConfig {
  tursoUrl: string;
  tursoAuthToken: string;
  keys: EncryptionKeys;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
}

/**
 * Initialize the remote Turso database with the same schema as local.
 * This is idempotent — safe to call on every sync.
 */
export async function initRemoteSchema(client: Client): Promise<void> {
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
      device_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_connections (
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      device_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL,
      device_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      pushed INTEGER NOT NULL DEFAULT 0,
      pulled INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Push local changes to Turso. Encrypts sensitive fields before upload.
 * Uses updated_at > last_sync_at to find changed records.
 */
export async function pushChanges(
  sqlite: Database.Database,
  client: Client,
  config: SyncConfig,
  deviceId: string,
): Promise<number> {
  const lastSync = await getLastSyncTime(client, deviceId);

  const changedMemories = sqlite.prepare(`
    SELECT * FROM memories WHERE updated_at > ? OR (updated_at IS NULL AND learned_at > ?)
  `).all(lastSync, lastSync) as Record<string, unknown>[];

  let pushed = 0;
  for (const mem of changedMemories) {
    const encrypted = encryptMemory(
      {
        content: mem.content as string,
        detail: mem.detail as string | null,
        structured_data: mem.structured_data as string | null,
      },
      config.keys.encryptionKey,
    );

    await client.execute({
      sql: `INSERT OR REPLACE INTO memories
        (id, content, detail, domain, source_agent_id, source_agent_name,
         cross_agent_id, cross_agent_name, source_type, source_description,
         confidence, confirmed_count, corrected_count, mistake_count, used_count,
         learned_at, confirmed_at, last_used_at, deleted_at,
         has_pii_flag, entity_type, entity_name, structured_data,
         device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        mem.id as string, encrypted.content, encrypted.detail,
        mem.domain as string, mem.source_agent_id as string, mem.source_agent_name as string,
        (mem.cross_agent_id as string | null) ?? null, (mem.cross_agent_name as string | null) ?? null,
        mem.source_type as string, (mem.source_description as string | null) ?? null,
        mem.confidence as number,
        mem.confirmed_count as number, mem.corrected_count as number,
        mem.mistake_count as number, mem.used_count as number,
        (mem.learned_at as string | null) ?? null, (mem.confirmed_at as string | null) ?? null,
        (mem.last_used_at as string | null) ?? null, (mem.deleted_at as string | null) ?? null,
        (mem.has_pii_flag as number) ?? 0, (mem.entity_type as string | null) ?? null,
        (mem.entity_name as string | null) ?? null, encrypted.structured_data,
        deviceId,
      ],
    });
    pushed++;
  }

  // Push changed connections
  const changedConnections = sqlite.prepare(`
    SELECT * FROM memory_connections WHERE updated_at > ? OR updated_at IS NULL
  `).all(lastSync) as Record<string, unknown>[];

  for (const conn of changedConnections) {
    await client.execute({
      sql: `INSERT OR REPLACE INTO memory_connections
        (source_memory_id, target_memory_id, relationship, device_id, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))`,
      args: [
        conn.source_memory_id as string, conn.target_memory_id as string,
        conn.relationship as string, deviceId,
      ],
    });
  }

  // Push events (append-only, no conflict)
  const changedEvents = sqlite.prepare(`
    SELECT * FROM memory_events WHERE timestamp > ?
  `).all(lastSync) as Record<string, unknown>[];

  for (const evt of changedEvents) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO memory_events
        (id, memory_id, event_type, agent_id, agent_name, old_value, new_value, timestamp, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        evt.id as string, evt.memory_id as string, evt.event_type as string,
        (evt.agent_id as string | null) ?? null, (evt.agent_name as string | null) ?? null,
        (evt.old_value as string | null) ?? null, (evt.new_value as string | null) ?? null,
        evt.timestamp as string, deviceId,
      ],
    });
  }

  return pushed + changedConnections.length + changedEvents.length;
}

/**
 * Pull remote changes from Turso. Decrypts after download.
 * Only pulls changes from OTHER devices (skips own device_id).
 */
export async function pullChanges(
  sqlite: Database.Database,
  client: Client,
  config: SyncConfig,
  deviceId: string,
): Promise<number> {
  const lastSync = await getLastSyncTime(client, deviceId);

  const result = await client.execute({
    sql: `SELECT * FROM memories WHERE device_id != ? AND updated_at > ?`,
    args: [deviceId, lastSync],
  });

  let pulled = 0;
  for (const row of result.rows) {
    const decrypted = decryptMemory(
      {
        content: row.content as string,
        detail: row.detail as string | null,
        structured_data: row.structured_data as string | null,
      },
      config.keys.encryptionKey,
    );

    // Last-write-wins: only update if remote is newer
    const local = sqlite.prepare(`SELECT updated_at FROM memories WHERE id = ?`).get(row.id as string) as { updated_at: string } | undefined;
    if (local && local.updated_at >= (row.updated_at as string)) continue;

    sqlite.prepare(`
      INSERT OR REPLACE INTO memories
        (id, content, detail, domain, source_agent_id, source_agent_name,
         cross_agent_id, cross_agent_name, source_type, source_description,
         confidence, confirmed_count, corrected_count, mistake_count, used_count,
         learned_at, confirmed_at, last_used_at, deleted_at,
         has_pii_flag, entity_type, entity_name, structured_data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, decrypted.content, decrypted.detail,
      row.domain, row.source_agent_id, row.source_agent_name,
      row.cross_agent_id, row.cross_agent_name,
      row.source_type, row.source_description,
      row.confidence, row.confirmed_count, row.corrected_count,
      row.mistake_count, row.used_count,
      row.learned_at, row.confirmed_at, row.last_used_at, row.deleted_at,
      row.has_pii_flag, row.entity_type, row.entity_name,
      decrypted.structured_data, row.updated_at,
    );
    pulled++;
  }

  // Pull connections from other devices
  const connResult = await client.execute({
    sql: `SELECT * FROM memory_connections WHERE device_id != ? AND updated_at > ?`,
    args: [deviceId, lastSync],
  });
  for (const row of connResult.rows) {
    sqlite.prepare(`
      INSERT OR IGNORE INTO memory_connections (source_memory_id, target_memory_id, relationship, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(row.source_memory_id, row.target_memory_id, row.relationship, row.updated_at);
    pulled++;
  }

  // Pull events from other devices (append-only)
  const evtResult = await client.execute({
    sql: `SELECT * FROM memory_events WHERE device_id != ? AND timestamp > ?`,
    args: [deviceId, lastSync],
  });
  for (const row of evtResult.rows) {
    sqlite.prepare(`
      INSERT OR IGNORE INTO memory_events (id, memory_id, event_type, agent_id, agent_name, old_value, new_value, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.memory_id, row.event_type, row.agent_id, row.agent_name, row.old_value, row.new_value, row.timestamp);
    pulled++;
  }

  return pulled;
}

/**
 * Full sync: push local changes, then pull remote changes, then log.
 */
export async function sync(
  sqlite: Database.Database,
  config: SyncConfig,
  deviceId: string,
): Promise<SyncResult> {
  const client = createClient({
    url: config.tursoUrl,
    authToken: config.tursoAuthToken,
  });

  try {
    await initRemoteSchema(client);
    const pushed = await pushChanges(sqlite, client, config, deviceId);
    const pulled = await pullChanges(sqlite, client, config, deviceId);

    // Log sync
    await client.execute({
      sql: `INSERT INTO sync_log (device_id, pushed, pulled) VALUES (?, ?, ?)`,
      args: [deviceId, pushed, pulled],
    });

    // Update local last_modified to trigger cache invalidation
    sqlite.prepare(`INSERT OR REPLACE INTO engrams_meta (key, value) VALUES ('last_modified', datetime('now'))`).run();

    return { pushed, pulled, conflicts: 0 };
  } finally {
    client.close();
  }
}

async function getLastSyncTime(client: Client, deviceId: string): Promise<string> {
  const result = await client.execute({
    sql: `SELECT synced_at FROM sync_log WHERE device_id = ? ORDER BY synced_at DESC LIMIT 1`,
    args: [deviceId],
  });
  return result.rows.length > 0 ? (result.rows[0].synced_at as string) : "1970-01-01T00:00:00Z";
}
