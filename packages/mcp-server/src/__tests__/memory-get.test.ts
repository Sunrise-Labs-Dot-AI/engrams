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
  return resolve(tmpdir(), `lodis-memory-get-${randomBytes(8).toString("hex")}.db`);
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

interface GetResponse {
  memories?: Array<{ id: string; domain: string; content: string; url?: string; permanence?: string | null }>;
  count?: number;
  requested?: number;
  deduplicated?: number;
  not_found?: string[];
  error?: string;
}

function parseResult(raw: unknown): GetResponse {
  return JSON.parse((raw as ToolResult).content[0].text);
}

async function withServer<T>(
  dbPath: string,
  fn: (mcp: McpClient, dbUrl: string) => Promise<T>,
): Promise<T> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const dbUrl = "file:" + dbPath;
  await startServer({ transport: serverTransport, dbUrl });

  const mcp = new McpClient({ name: "memory-get-test", version: "0.0.0" }, { capabilities: {} });
  await mcp.connect(clientTransport);
  try {
    return await fn(mcp, dbUrl);
  } finally {
    await mcp.close();
  }
}

function memId(): string {
  return randomBytes(16).toString("hex");
}

async function seedMemory(
  db: ReturnType<typeof createClient>,
  m: {
    id: string;
    content: string;
    domain: string;
    permanence?: string | null;
    deletedAt?: string | null;
    userId?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO memories
            (id, content, domain, source_agent_id, source_agent_name, source_type,
             confidence, learned_at, updated_at, permanence, deleted_at, user_id, used_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [
      m.id,
      m.content,
      m.domain,
      "seeder",
      "Seeder",
      "stated",
      0.9,
      now,
      now,
      m.permanence ?? "active",
      m.deletedAt ?? null,
      m.userId ?? null,
    ],
  });
}

describe("memory_get", () => {
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
      /* best-effort */
    }
  });

  it("returns a single record by id with deeplink", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const id = memId();
        await seedMemory(db, { id, content: "hello world", domain: "general" });

        const raw = await mcp.callTool({ name: "memory_get", arguments: { id } });
        const res = parseResult(raw);

        expect(res.error).toBeUndefined();
        expect(res.count).toBe(1);
        expect(res.requested).toBe(1);
        expect(res.not_found).toEqual([]);
        expect(res.memories?.[0]?.id).toBe(id);
        expect(res.memories?.[0]?.url).toContain(`/memory/${id}`);
      } finally {
        db.close();
      }
    });
  });

  it("batch ids: soft-deleted row appears in not_found, others returned", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const a = memId();
        const b = memId();
        const c = memId();
        await seedMemory(db, { id: a, content: "alpha", domain: "general" });
        await seedMemory(db, { id: b, content: "bravo", domain: "general", deletedAt: new Date().toISOString() });
        await seedMemory(db, { id: c, content: "charlie", domain: "general" });

        const raw = await mcp.callTool({ name: "memory_get", arguments: { ids: [a, b, c] } });
        const res = parseResult(raw);

        expect(res.count).toBe(2);
        expect(res.requested).toBe(3);
        expect(res.not_found).toEqual([b]);
        const returnedIds = new Set(res.memories?.map((m) => m.id) ?? []);
        expect(returnedIds.has(a)).toBe(true);
        expect(returnedIds.has(c)).toBe(true);
        expect(returnedIds.has(b)).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it("dedup: duplicates collapse to a single fetch and a single auto-track", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const id = memId();
        await seedMemory(db, { id, content: "dedup target", domain: "general" });

        const raw = await mcp.callTool({ name: "memory_get", arguments: { ids: [id, id, id, id] } });
        const res = parseResult(raw);

        expect(res.count).toBe(1);
        expect(res.requested).toBe(1);
        expect(res.deduplicated).toBe(3);
        expect(res.not_found).toEqual([]);

        const after = (await db.execute({ sql: `SELECT used_count FROM memories WHERE id = ?`, args: [id] })).rows[0] as { used_count: number };
        expect(after.used_count).toBe(1);

        const evts = (await db.execute({ sql: `SELECT COUNT(*) AS n FROM memory_events WHERE memory_id = ? AND event_type = 'used'`, args: [id] })).rows[0] as { n: number };
        expect(evts.n).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("rejects malformed IDs without touching SQL", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const good = memId();
        await seedMemory(db, { id: good, content: "ok", domain: "general" });

        const raw = await mcp.callTool({ name: "memory_get", arguments: { ids: [good, "not-hex"] } });
        const res = parseResult(raw);

        expect(res.error).toBeDefined();
        expect(res.error).toContain("Invalid memory ID");

        // No auto-track side effect on the valid ID either.
        const after = (await db.execute({ sql: `SELECT used_count FROM memories WHERE id = ?`, args: [good] })).rows[0] as { used_count: number };
        expect(after.used_count).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("permission-blocked row appears in not_found, indistinguishable from missing; auto-track does not fire", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const allowedId = memId();
        const blockedId = memId();
        const phantomId = memId(); // valid hex, never inserted
        await seedMemory(db, { id: allowedId, content: "allowed row", domain: "work" });
        await seedMemory(db, { id: blockedId, content: "secret row", domain: "health" });

        // Isolated + allowlist: deny everything except domain `work`.
        await db.execute({
          sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write) VALUES (?, ?, ?, ?)`,
          args: ["agent_x", "*", 0, 0],
        });
        await db.execute({
          sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write) VALUES (?, ?, ?, ?)`,
          args: ["agent_x", "work", 1, 1],
        });

        const raw = await mcp.callTool({
          name: "memory_get",
          arguments: { ids: [allowedId, blockedId, phantomId], agentId: "agent_x" },
        });
        const res = parseResult(raw);

        expect(res.count).toBe(1);
        expect(res.requested).toBe(3);
        // Both blocked and phantom IDs land in the same opaque bucket.
        expect(new Set(res.not_found)).toEqual(new Set([blockedId, phantomId]));
        expect(res.memories?.[0]?.id).toBe(allowedId);

        // Auto-track must NOT have fired on the blocked row.
        const blockedRow = (await db.execute({ sql: `SELECT used_count FROM memories WHERE id = ?`, args: [blockedId] })).rows[0] as { used_count: number };
        expect(blockedRow.used_count).toBe(0);
        const blockedEvts = (await db.execute({ sql: `SELECT COUNT(*) AS n FROM memory_events WHERE memory_id = ? AND event_type = 'used'`, args: [blockedId] })).rows[0] as { n: number };
        expect(blockedEvts.n).toBe(0);

        // Auto-track DID fire on the allowed row.
        const allowedRow = (await db.execute({ sql: `SELECT used_count FROM memories WHERE id = ?`, args: [allowedId] })).rows[0] as { used_count: number };
        expect(allowedRow.used_count).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("archived row excluded by default; surfaced when includeArchived=true", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const id = memId();
        await seedMemory(db, { id, content: "old fact", domain: "general", permanence: "archived" });

        const def = parseResult(await mcp.callTool({ name: "memory_get", arguments: { id } }));
        expect(def.count).toBe(0);
        expect(def.not_found).toEqual([id]);

        const opted = parseResult(await mcp.callTool({ name: "memory_get", arguments: { id, includeArchived: true } }));
        expect(opted.count).toBe(1);
        expect(opted.memories?.[0]?.id).toBe(id);
      } finally {
        db.close();
      }
    });
  });

  it("requires either id or ids", async () => {
    await withServer(dbPath, async (mcp) => {
      const res = parseResult(await mcp.callTool({ name: "memory_get", arguments: {} }));
      expect(res.error).toContain("requires either `id` or `ids`");
    });
  });

  it("rejects when both id and ids are supplied", async () => {
    await withServer(dbPath, async (mcp) => {
      const id = memId();
      const res = parseResult(await mcp.callTool({ name: "memory_get", arguments: { id, ids: [id] } }));
      expect(res.error).toContain("not both");
    });
  });

  it("caps batch at 50 IDs after dedup", async () => {
    await withServer(dbPath, async (mcp) => {
      const ids = Array.from({ length: 51 }, () => memId());
      const res = parseResult(await mcp.callTool({ name: "memory_get", arguments: { ids } }));
      expect(res.error).toContain("at most 50");
    });
  });

  it("rejects empty ids array with the same error as missing fields", async () => {
    await withServer(dbPath, async (mcp) => {
      const res = parseResult(await mcp.callTool({ name: "memory_get", arguments: { ids: [] } }));
      expect(res.error).toContain("requires either `id` or `ids`");
    });
  });
});
