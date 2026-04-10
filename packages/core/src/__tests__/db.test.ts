import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import { searchFTS } from "../fts.js";
import type { Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `engrams-test-${randomBytes(8).toString("hex")}.db`);
}

describe("createDatabase", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // cleanup best-effort
    }
  });

  it("creates a database file", async () => {
    await createDatabase({ url: "file:" + dbPath });
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates all expected tables", async () => {
    const { client } = await createDatabase({ url: "file:" + dbPath });
    const result = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      args: [],
    });

    const tableNames = result.rows.map((t) => t.name as string);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_connections");
    expect(tableNames).toContain("memory_events");
    expect(tableNames).toContain("agent_permissions");
    expect(tableNames).toContain("memory_fts");
  });

  it("enables WAL mode", async () => {
    const { client } = await createDatabase({ url: "file:" + dbPath });
    const result = await client.execute({ sql: "PRAGMA journal_mode", args: [] });
    expect(result.rows[0].journal_mode).toBe("wal");
  });
});

describe("FTS5 search", () => {
  let dbPath: string;
  let client: Client;

  beforeEach(async () => {
    dbPath = tempDbPath();
    const result = await createDatabase({ url: "file:" + dbPath });
    client = result.client;
  });

  afterEach(() => {
    try {
      client.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // cleanup best-effort
    }
  });

  it("indexes inserted memories and returns search results", async () => {
    await client.execute({
      sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["id1", "I prefer morning meetings before 10am", "work", "agent1", "claude", "stated", 0.9],
    });

    await client.execute({
      sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["id2", "Favorite color is blue", "personal", "agent1", "claude", "stated", 0.9],
    });

    const results = await searchFTS(client, "morning meetings");
    expect(results.length).toBe(1);

    // Verify we can join back to get the full memory
    const memResult = await client.execute({
      sql: `SELECT * FROM memories WHERE rowid = ?`,
      args: [results[0].rowid],
    });
    const memory = memResult.rows[0];
    expect(memory.id).toBe("id1");
    expect((memory.content as string)).toContain("morning meetings");
  });

  it("returns empty array for no matches", async () => {
    const results = await searchFTS(client, "nonexistent query");
    expect(results).toEqual([]);
  });

  it("updates FTS index on memory update", async () => {
    await client.execute({
      sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["id1", "I like cats", "personal", "agent1", "claude", "stated", 0.9],
    });

    await client.execute({
      sql: `UPDATE memories SET content = ? WHERE id = ?`,
      args: ["I like dogs", "id1"],
    });

    const catResults = await searchFTS(client, "cats");
    expect(catResults.length).toBe(0);

    const dogResults = await searchFTS(client, "dogs");
    expect(dogResults.length).toBe(1);
  });
});
