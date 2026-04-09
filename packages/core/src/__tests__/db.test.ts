import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import { searchFTS } from "../fts.js";

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

  it("creates a database file", () => {
    createDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates all expected tables", () => {
    const { sqlite } = createDatabase(dbPath);
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_connections");
    expect(tableNames).toContain("memory_events");
    expect(tableNames).toContain("agent_permissions");
    expect(tableNames).toContain("memory_fts");
  });

  it("enables WAL mode", () => {
    const { sqlite } = createDatabase(dbPath);
    const result = sqlite.pragma("journal_mode") as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe("wal");
  });
});

describe("FTS5 search", () => {
  let dbPath: string;
  let sqlite: ReturnType<typeof createDatabase>["sqlite"];

  beforeEach(() => {
    dbPath = tempDbPath();
    const result = createDatabase(dbPath);
    sqlite = result.sqlite;
  });

  afterEach(() => {
    try {
      sqlite.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // cleanup best-effort
    }
  });

  it("indexes inserted memories and returns search results", () => {
    sqlite
      .prepare(
        `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("id1", "I prefer morning meetings before 10am", "work", "agent1", "claude", "stated", 0.9);

    sqlite
      .prepare(
        `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("id2", "Favorite color is blue", "personal", "agent1", "claude", "stated", 0.9);

    const results = searchFTS(sqlite, "morning meetings");
    expect(results.length).toBe(1);

    // Verify we can join back to get the full memory
    const memory = sqlite
      .prepare(`SELECT * FROM memories WHERE rowid = ?`)
      .get(results[0].rowid) as { id: string; content: string };
    expect(memory.id).toBe("id1");
    expect(memory.content).toContain("morning meetings");
  });

  it("returns empty array for no matches", () => {
    const results = searchFTS(sqlite, "nonexistent query");
    expect(results).toEqual([]);
  });

  it("updates FTS index on memory update", () => {
    sqlite
      .prepare(
        `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("id1", "I like cats", "personal", "agent1", "claude", "stated", 0.9);

    sqlite
      .prepare(`UPDATE memories SET content = ? WHERE id = ?`)
      .run("I like dogs", "id1");

    const catResults = searchFTS(sqlite, "cats");
    expect(catResults.length).toBe(0);

    const dogResults = searchFTS(sqlite, "dogs");
    expect(dogResults.length).toBe(1);
  });
});
