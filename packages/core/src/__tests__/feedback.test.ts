import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import { rateContext } from "../feedback.js";
import type { Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `lodis-test-${randomBytes(8).toString("hex")}.db`);
}

async function insertMemory(
  client: Client,
  id: string,
  opts: { userId?: string | null; confidence?: number } = {},
) {
  await client.execute({
    sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, user_id)
         VALUES (?, ?, 'general', 'agent1', 'test', 'stated', ?, ?, ?)`,
    args: [id, `Memory ${id}`, opts.confidence ?? 0.8, new Date().toISOString(), opts.userId ?? null],
  });
}

async function insertRetrieval(
  client: Client,
  id: string,
  returnedIds: string[],
  opts: { userId?: string | null; agentId?: string | null } = {},
) {
  await client.execute({
    sql: `INSERT INTO context_retrievals
          (id, user_id, agent_id, query, token_budget, format, tokens_used, returned_memory_ids_json, saturation_json, score_distribution_json, created_at)
          VALUES (?, ?, ?, 'test query', 1000, 'hierarchical', 500, ?, '{}', '{}', ?)`,
    args: [
      id,
      opts.userId ?? null,
      opts.agentId ?? null,
      JSON.stringify(returnedIds),
      new Date().toISOString(),
    ],
  });
}

async function getMemory(client: Client, id: string) {
  const r = await client.execute({
    sql: `SELECT confidence, referenced_count, noise_count, last_referenced_at FROM memories WHERE id = ?`,
    args: [id],
  });
  return r.rows[0] as unknown as {
    confidence: number;
    referenced_count: number;
    noise_count: number;
    last_referenced_at: string | null;
  };
}

describe("rateContext", () => {
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
      // best-effort
    }
  });

  it("increments referenced_count and applies confidence bump", async () => {
    await insertMemory(client, "m1", { confidence: 0.8 });
    await insertMemory(client, "m2", { confidence: 0.8 });
    await insertRetrieval(client, "r1", ["m1", "m2"]);

    const res = await rateContext(client, {
      userId: null,
      retrievalId: "r1",
      referenced: ["m1"],
      noise: ["m2"],
    });

    expect(res.status).toBe("rated");
    expect(res.referenced).toEqual(["m1"]);
    expect(res.noise).toEqual(["m2"]);

    const m1 = await getMemory(client, "m1");
    expect(m1.referenced_count).toBe(1);
    expect(m1.confidence).toBeCloseTo(0.82, 5); // +0.02 applyUsed bump
    expect(m1.last_referenced_at).not.toBeNull();

    const m2 = await getMemory(client, "m2");
    expect(m2.noise_count).toBe(1);
    expect(m2.confidence).toBe(0.8); // noise does NOT bump confidence
  });

  it("is idempotent when called twice with same args", async () => {
    await insertMemory(client, "m1");
    await insertRetrieval(client, "r1", ["m1"]);

    await rateContext(client, { userId: null, retrievalId: "r1", referenced: ["m1"] });
    const second = await rateContext(client, {
      userId: null,
      retrievalId: "r1",
      referenced: ["m1"],
    });

    expect(second.status).toBe("already_rated_same");
    const m1 = await getMemory(client, "m1");
    expect(m1.referenced_count).toBe(1); // not double-counted
  });

  it("returns already_rated_different when args change", async () => {
    await insertMemory(client, "m1");
    await insertMemory(client, "m2");
    await insertRetrieval(client, "r1", ["m1", "m2"]);

    await rateContext(client, { userId: null, retrievalId: "r1", referenced: ["m1"] });
    const second = await rateContext(client, {
      userId: null,
      retrievalId: "r1",
      referenced: ["m2"],
    });

    expect(second.status).toBe("already_rated_different");
    expect(second.original?.referenced).toEqual(["m1"]);

    const m2 = await getMemory(client, "m2");
    expect(m2.referenced_count).toBe(0); // not mutated on the second call
  });

  it("returns not_found for unknown retrievalId", async () => {
    const res = await rateContext(client, {
      userId: null,
      retrievalId: "nonexistent",
      referenced: [],
    });
    expect(res.status).toBe("not_found");
  });

  it("returns not_found when retrieval belongs to a different user", async () => {
    await insertMemory(client, "m1", { userId: "userA" });
    await insertRetrieval(client, "r1", ["m1"], { userId: "userA" });

    const res = await rateContext(client, {
      userId: "userB",
      retrievalId: "r1",
      referenced: ["m1"],
    });
    expect(res.status).toBe("not_found");
  });

  it("drops IDs not in returned_memory_ids_json", async () => {
    await insertMemory(client, "m1");
    await insertRetrieval(client, "r1", ["m1"]);

    const res = await rateContext(client, {
      userId: null,
      retrievalId: "r1",
      referenced: ["m1", "ghost-id"],
    });

    expect(res.status).toBe("rated");
    expect(res.referenced).toEqual(["m1"]);
    expect(res.droppedUnknownIds).toContain("ghost-id");
  });

  it("rejects overlap between referenced and noise", async () => {
    await insertMemory(client, "m1");
    await insertRetrieval(client, "r1", ["m1"]);

    await expect(
      rateContext(client, {
        userId: null,
        retrievalId: "r1",
        referenced: ["m1"],
        noise: ["m1"],
      }),
    ).rejects.toThrow();
  });

  it("enforces agent ownership when retrieval row has agent_id", async () => {
    await insertMemory(client, "m1");
    await insertRetrieval(client, "r1", ["m1"], { agentId: "agentA" });

    const wrongAgent = await rateContext(client, {
      userId: null,
      agentId: "agentB",
      retrievalId: "r1",
      referenced: ["m1"],
    });
    expect(wrongAgent.status).toBe("not_found");

    const rightAgent = await rateContext(client, {
      userId: null,
      agentId: "agentA",
      retrievalId: "r1",
      referenced: ["m1"],
    });
    expect(rightAgent.status).toBe("rated");
  });
});
