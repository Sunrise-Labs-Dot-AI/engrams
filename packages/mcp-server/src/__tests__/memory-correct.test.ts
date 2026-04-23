import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { randomBytes } from "crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "@libsql/client";
import { startServer } from "../server.js";

function tempDbPath(): string {
  return resolve(tmpdir(), `lodis-correct-${randomBytes(8).toString("hex")}.db`);
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

function parseResult<T>(raw: unknown): T {
  const data = raw as ToolResult;
  return JSON.parse(data.content[0].text) as T;
}

async function withServer<T>(
  dbPath: string,
  fn: (client: McpClient, dbUrl: string) => Promise<T>,
): Promise<T> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const dbUrl = "file:" + dbPath;
  await startServer({ transport: serverTransport, dbUrl });

  const client = new McpClient({ name: "correct-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    return await fn(client, dbUrl);
  } finally {
    await client.close();
  }
}

describe("memory_correct MCP tool", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (existsSync(p)) unlinkSync(p);
      }
    } catch {
      // best-effort
    }
  });

  it("raises confidence to 0.9 when current is below floor", async () => {
    const result = await withServer(dbPath, async (client, dbUrl) => {
      const db = createClient({ url: dbUrl });
      const id = randomBytes(16).toString("hex");
      await db.execute({
        sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, "original content", "general", "seed", "Seed", "stated", 0.7, new Date().toISOString()],
      });
      db.close();

      const raw = await client.callTool({
        name: "memory_correct",
        arguments: { id, content: "corrected content" },
      });
      return parseResult<{
        corrected: boolean;
        previousConfidence: number;
        newConfidence: number;
        correctedCount: number;
      }>(raw);
    });

    expect(result.corrected).toBe(true);
    expect(result.previousConfidence).toBe(0.7);
    expect(result.newConfidence).toBe(0.9);
    expect(result.correctedCount).toBe(1);
  });

  it("leaves higher confidence unchanged (caps at current when >= 0.9)", async () => {
    const result = await withServer(dbPath, async (client, dbUrl) => {
      const db = createClient({ url: dbUrl });
      const id = randomBytes(16).toString("hex");
      await db.execute({
        sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, confirmed_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, "original", "general", "seed", "Seed", "stated", 0.95, new Date().toISOString(), 1],
      });
      db.close();

      const raw = await client.callTool({
        name: "memory_correct",
        arguments: { id, content: "corrected" },
      });
      return parseResult<{ newConfidence: number }>(raw);
    });

    expect(result.newConfidence).toBe(0.95);
  });

  it("does not touch last_used_at on correction", async () => {
    const result = await withServer(dbPath, async (client, dbUrl) => {
      const db = createClient({ url: dbUrl });
      const id = randomBytes(16).toString("hex");
      const originalLastUsed = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, last_used_at, used_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, "original", "general", "seed", "Seed", "stated", 0.7, new Date().toISOString(), originalLastUsed, 1],
      });

      await client.callTool({
        name: "memory_correct",
        arguments: { id, content: "corrected" },
      });

      const after = await db.execute({
        sql: `SELECT last_used_at FROM memories WHERE id = ?`,
        args: [id],
      });
      db.close();
      return {
        originalLastUsed,
        afterLastUsed: after.rows[0].last_used_at as string,
      };
    });

    expect(result.afterLastUsed).toBe(result.originalLastUsed);
  });

  it("dashboard path (correctMemoryById) uses the same formula as the MCP path", async () => {
    // Parity guard — the bug this fix addresses was two different formulas in two
    // surfaces. applyCorrect is now the single source of truth for both the MCP
    // handler (packages/mcp-server/src/server.ts) and the dashboard action
    // (packages/dashboard/src/lib/db.ts → correctMemoryById).
    const { applyCorrect } = await import("@lodis/core");
    expect(applyCorrect(0.5)).toBe(0.9);
    expect(applyCorrect(0.7)).toBe(0.9);
    expect(applyCorrect(0.9)).toBe(0.9);
    expect(applyCorrect(0.95)).toBe(0.95);
    expect(applyCorrect(0.99)).toBe(0.99);
  });

  it("increments corrected_count and emits a 'corrected' event", async () => {
    const result = await withServer(dbPath, async (client, dbUrl) => {
      const db = createClient({ url: dbUrl });
      const id = randomBytes(16).toString("hex");
      await db.execute({
        sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, "v1", "general", "seed", "Seed", "stated", 0.5, new Date().toISOString()],
      });

      await client.callTool({ name: "memory_correct", arguments: { id, content: "v2" } });
      await client.callTool({ name: "memory_correct", arguments: { id, content: "v3" } });

      const counts = await db.execute({
        sql: `SELECT corrected_count, confidence FROM memories WHERE id = ?`,
        args: [id],
      });
      const events = await db.execute({
        sql: `SELECT event_type FROM memory_events WHERE memory_id = ? ORDER BY timestamp ASC`,
        args: [id],
      });
      db.close();

      return {
        correctedCount: counts.rows[0].corrected_count as number,
        confidence: counts.rows[0].confidence as number,
        events: events.rows.map((r) => r.event_type as string),
      };
    });

    expect(result.correctedCount).toBe(2);
    expect(result.confidence).toBe(0.9);
    expect(result.events.filter((e) => e === "corrected").length).toBe(2);
  });
});
