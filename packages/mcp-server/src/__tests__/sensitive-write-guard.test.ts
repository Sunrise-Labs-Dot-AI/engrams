// §B sensitive-write-guard test from the Agent Permissions redesign plan.
//
// When the user has marked a domain sensitive, and an agent with no existing
// rule for that domain writes a memory there, the MCP server must auto-insert
// (agent_id, domain, 0, 0) so the agent can't later read or write this
// domain without the user explicitly allowing it. This test asserts that
// behavior end-to-end via the MCP client.

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
  return resolve(tmpdir(), `lodis-sensitive-guard-${randomBytes(8).toString("hex")}.db`);
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

function parse<T>(raw: unknown): T {
  return JSON.parse((raw as ToolResult).content[0].text) as T;
}

async function withServer<T>(
  dbPath: string,
  fn: (client: McpClient, dbUrl: string) => Promise<T>,
): Promise<T> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const dbUrl = "file:" + dbPath;
  await startServer({ transport: serverTransport, dbUrl });

  const client = new McpClient({ name: "sensitive-guard-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client, dbUrl);
  } finally {
    await client.close();
  }
}

describe("memory_write — sensitive-domain auto-block", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tempDbPath(); });
  afterEach(() => {
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (existsSync(p)) unlinkSync(p);
      }
    } catch { /* noop */ }
  });

  it("auto-inserts (agent_id, domain, 0, 0) when a new agent writes to a sensitive domain", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        await db.execute({
          sql: `INSERT INTO sensitive_domains (user_id, domain, marked_at) VALUES (?, ?, ?)`,
          args: [null, "private", new Date().toISOString()],
        });

        const raw = await mcp.callTool({
          name: "memory_write",
          arguments: {
            content: "A private fact",
            domain: "private",
            sourceAgentId: "new-agent",
            sourceAgentName: "New Agent",
            sourceType: "stated",
          },
        });
        const res = parse<{ id?: string; error?: string }>(raw);
        expect(res.error).toBeUndefined();
        expect(res.id).toBeTruthy();

        const rule = (await db.execute({
          sql: `SELECT can_read, can_write FROM agent_permissions
                  WHERE agent_id = ? AND domain = ?`,
          args: ["new-agent", "private"],
        })).rows[0] as unknown as { can_read: number; can_write: number } | undefined;
        expect(rule).toBeDefined();
        expect(rule!.can_read).toBe(0);
        expect(rule!.can_write).toBe(0);

        const audit = (await db.execute({
          sql: `SELECT event_type FROM memory_events WHERE event_type = 'sensitive_auto_block'`,
          args: [],
        })).rows;
        expect(audit.length).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("does not overwrite an existing rule when the agent already has one", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        await db.execute({
          sql: `INSERT INTO sensitive_domains (user_id, domain, marked_at) VALUES (?, ?, ?)`,
          args: [null, "private", new Date().toISOString()],
        });
        await db.execute({
          sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
                VALUES (?, ?, 1, 1, ?)`,
          args: ["trusted-agent", "private", null],
        });

        const raw = await mcp.callTool({
          name: "memory_write",
          arguments: {
            content: "A private fact",
            domain: "private",
            sourceAgentId: "trusted-agent",
            sourceAgentName: "Trusted Agent",
            sourceType: "stated",
          },
        });
        const res = parse<{ error?: string }>(raw);
        expect(res.error).toBeUndefined();

        const rule = (await db.execute({
          sql: `SELECT can_read, can_write FROM agent_permissions
                  WHERE agent_id = ? AND domain = ?`,
          args: ["trusted-agent", "private"],
        })).rows[0] as unknown as { can_read: number; can_write: number };
        expect(rule.can_read).toBe(1);
        expect(rule.can_write).toBe(1);

        const audit = (await db.execute({
          sql: `SELECT event_type FROM memory_events WHERE event_type = 'sensitive_auto_block'`,
          args: [],
        })).rows;
        expect(audit.length).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("does nothing for non-sensitive domains", async () => {
    await withServer(dbPath, async (mcp, dbUrl) => {
      const db = createClient({ url: dbUrl });
      try {
        const raw = await mcp.callTool({
          name: "memory_write",
          arguments: {
            content: "A public fact",
            domain: "general",
            sourceAgentId: "any-agent",
            sourceAgentName: "Any Agent",
            sourceType: "stated",
          },
        });
        const res = parse<{ error?: string }>(raw);
        expect(res.error).toBeUndefined();

        const rules = (await db.execute({
          sql: `SELECT COUNT(*) as c FROM agent_permissions WHERE agent_id = ?`,
          args: ["any-agent"],
        })).rows[0] as unknown as { c: number };
        expect(rules.c).toBe(0);
      } finally {
        db.close();
      }
    });
  });
});
