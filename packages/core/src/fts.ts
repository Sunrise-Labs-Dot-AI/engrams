import type { Client } from "@libsql/client";

export async function setupFTS(client: Client): Promise<void> {
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

  await client.executeMultiple(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid, content, detail, source_agent_name, entity_name)
      VALUES (new.rowid, new.content, new.detail, new.source_agent_name, new.entity_name);
    END;
  `);

  await client.executeMultiple(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, detail, source_agent_name, entity_name)
      VALUES ('delete', old.rowid, old.content, old.detail, old.source_agent_name, old.entity_name);
    END;
  `);

  await client.executeMultiple(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, detail, source_agent_name, entity_name)
      VALUES ('delete', old.rowid, old.content, old.detail, old.source_agent_name, old.entity_name);
      INSERT INTO memory_fts(rowid, content, detail, source_agent_name, entity_name)
      VALUES (new.rowid, new.content, new.detail, new.source_agent_name, new.entity_name);
    END;
  `);
}

export async function searchFTS(
  client: Client,
  query: string,
  limit = 20,
): Promise<{ rowid: number }[]> {
  const result = await client.execute({
    sql: `SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`,
    args: [query, limit],
  });
  return result.rows.map((row) => ({ rowid: row.rowid as number }));
}
