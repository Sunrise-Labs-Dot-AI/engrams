import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase, bumpLastModified } from "../db.js";
import { searchFTS } from "../fts.js";
import type { Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `lodis-test-${randomBytes(8).toString("hex")}.db`);
}

async function insertMemory(
  client: Client,
  id: string,
  content: string,
  opts: {
    confidence?: number;
    domain?: string;
    entityType?: string;
    entityName?: string;
    learnedAt?: string;
  } = {},
) {
  await client.execute({
    sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, entity_type, entity_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      content,
      opts.domain ?? "general",
      "agent1",
      "test",
      "stated",
      opts.confidence ?? 0.9,
      opts.learnedAt ?? new Date().toISOString(),
      opts.entityType ?? null,
      opts.entityName ?? null,
    ],
  });
}

async function insertConnection(
  client: Client,
  sourceId: string,
  targetId: string,
  relationship: string,
) {
  await client.execute({
    sql: `INSERT INTO memory_connections (source_memory_id, target_memory_id, relationship) VALUES (?, ?, ?)`,
    args: [sourceId, targetId, relationship],
  });
}

describe("search", () => {
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

  describe("FTS5 search", () => {
    it("finds memories by keyword", async () => {
      await insertMemory(client, "m1", "TypeScript is my preferred language");
      await insertMemory(client, "m2", "I enjoy morning coffee");
      await insertMemory(client, "m3", "Python is also useful for scripting");

      const results = await searchFTS(client, "TypeScript");
      expect(results.length).toBe(1);
    });

    it("returns empty for no matches", async () => {
      await insertMemory(client, "m1", "Hello world");
      const results = await searchFTS(client, "nonexistent");
      expect(results).toEqual([]);
    });

    it("searches entity_name in FTS index", async () => {
      await insertMemory(client, "m1", "She is my manager", { entityName: "Sarah Chen" });
      const results = await searchFTS(client, "Sarah Chen");
      expect(results.length).toBe(1);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await insertMemory(client, `m${i}`, `TypeScript tip number ${i}`);
      }
      const results = await searchFTS(client, "TypeScript", 3);
      expect(results.length).toBe(3);
    });
  });

  describe("entity filters (SQL level)", () => {
    it("filters by entity_type", async () => {
      await insertMemory(client, "m1", "Sarah is my manager", { entityType: "person", entityName: "Sarah" });
      await insertMemory(client, "m2", "Acme Corp builds SaaS", { entityType: "organization", entityName: "Acme" });
      await insertMemory(client, "m3", "I prefer dark mode", { entityType: "preference" });

      const personResults = await client.execute({
        sql: `SELECT * FROM memories WHERE entity_type = ? AND deleted_at IS NULL`,
        args: ["person"],
      });
      expect(personResults.rows.length).toBe(1);
      expect(personResults.rows[0].id).toBe("m1");
    });

    it("filters by entity_name case-insensitively", async () => {
      await insertMemory(client, "m1", "Sarah is my manager", { entityType: "person", entityName: "Sarah Chen" });

      const results = await client.execute({
        sql: `SELECT * FROM memories WHERE entity_name = ? COLLATE NOCASE AND deleted_at IS NULL`,
        args: ["sarah chen"],
      });
      expect(results.rows.length).toBe(1);
    });
  });

  describe("connections", () => {
    it("stores and retrieves connections between memories", async () => {
      await insertMemory(client, "m1", "Sarah is my manager");
      await insertMemory(client, "m2", "Acme Corp is my employer");
      await insertConnection(client, "m1", "m2", "works_at");

      const outgoing = await client.execute({
        sql: `SELECT * FROM memory_connections WHERE source_memory_id = ?`,
        args: ["m1"],
      });
      expect(outgoing.rows.length).toBe(1);
      expect(outgoing.rows[0].relationship).toBe("works_at");
    });

    it("supports multiple relationship types", async () => {
      await insertMemory(client, "m1", "Dogs are great pets");
      await insertMemory(client, "m2", "Cats are better pets");
      await insertConnection(client, "m1", "m2", "contradicts");

      await insertMemory(client, "m3", "Regular exercise is important");
      await insertMemory(client, "m4", "Morning walks are my favorite");
      await insertConnection(client, "m3", "m4", "supports");

      const all = await client.execute({ sql: `SELECT * FROM memory_connections`, args: [] });
      expect(all.rows.length).toBe(2);
    });

    it("follows bidirectional connections", async () => {
      await insertMemory(client, "m1", "Memory A");
      await insertMemory(client, "m2", "Memory B");
      await insertConnection(client, "m1", "m2", "related");

      const outgoing = await client.execute({
        sql: `SELECT * FROM memory_connections WHERE source_memory_id = ?`,
        args: ["m1"],
      });
      const incoming = await client.execute({
        sql: `SELECT * FROM memory_connections WHERE target_memory_id = ?`,
        args: ["m1"],
      });
      expect(outgoing.rows.length).toBe(1);
      expect(incoming.rows.length).toBe(0);

      const incomingToM2 = await client.execute({
        sql: `SELECT * FROM memory_connections WHERE target_memory_id = ?`,
        args: ["m2"],
      });
      expect(incomingToM2.rows.length).toBe(1);
    });
  });

  describe("lodis_meta for cache invalidation", () => {
    it("stores last_modified timestamp", async () => {
      const result = await client.execute({
        sql: `SELECT value FROM lodis_meta WHERE key = 'last_modified'`,
        args: [],
      });
      expect(result.rows[0].value).toBeDefined();
    });

    it("updates last_modified on bumpLastModified", async () => {
      const beforeResult = await client.execute({
        sql: `SELECT value FROM lodis_meta WHERE key = 'last_modified'`,
        args: [],
      });
      const before = beforeResult.rows[0].value as string;

      await bumpLastModified(client);

      const afterResult = await client.execute({
        sql: `SELECT value FROM lodis_meta WHERE key = 'last_modified'`,
        args: [],
      });
      const after = afterResult.rows[0].value as string;
      expect(after).not.toBe(before);
    });
  });
});
