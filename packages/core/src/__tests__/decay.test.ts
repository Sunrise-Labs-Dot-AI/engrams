import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import { applyConfidenceDecay, DECAY_RATE, MIN_CONFIDENCE } from "../confidence.js";
import type { Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `engrams-test-${randomBytes(8).toString("hex")}.db`);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function insertMemory(
  client: Client,
  id: string,
  confidence: number,
  learnedAt: string,
  lastUsedAt: string | null = null,
  confirmedAt: string | null = null,
) {
  await client.execute({
    sql: `INSERT INTO memories (id, content, domain, source_agent_id, source_agent_name, source_type, confidence, learned_at, last_used_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, `Memory ${id}`, "general", "agent1", "test", "stated", confidence, learnedAt, lastUsedAt, confirmedAt],
  });
}

describe("applyConfidenceDecay", () => {
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

  it("decays memory after 30 days of inactivity", async () => {
    await insertMemory(client, "m1", 0.9, daysAgo(35));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(1);

    const result = await client.execute({ sql: `SELECT confidence FROM memories WHERE id = 'm1'`, args: [] });
    expect(result.rows[0].confidence as number).toBeCloseTo(0.9 - DECAY_RATE);
  });

  it("applies 2x decay for 60 days of inactivity", async () => {
    await insertMemory(client, "m1", 0.9, daysAgo(65));
    await applyConfidenceDecay(client);

    const result = await client.execute({ sql: `SELECT confidence FROM memories WHERE id = 'm1'`, args: [] });
    expect(result.rows[0].confidence as number).toBeCloseTo(0.9 - DECAY_RATE * 2);
  });

  it("does not decay within 30 days", async () => {
    await insertMemory(client, "m1", 0.9, daysAgo(15));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(0);

    const result = await client.execute({ sql: `SELECT confidence FROM memories WHERE id = 'm1'`, args: [] });
    expect(result.rows[0].confidence).toBe(0.9);
  });

  it("does not go below MIN_CONFIDENCE", async () => {
    await insertMemory(client, "m1", 0.12, daysAgo(365));
    await applyConfidenceDecay(client);

    const result = await client.execute({ sql: `SELECT confidence FROM memories WHERE id = 'm1'`, args: [] });
    expect(result.rows[0].confidence).toBe(MIN_CONFIDENCE);
  });

  it("skips memories already at MIN_CONFIDENCE", async () => {
    await insertMemory(client, "m1", MIN_CONFIDENCE, daysAgo(365));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(0);
  });

  it("does not decay recently used memories", async () => {
    await insertMemory(client, "m1", 0.9, daysAgo(90), daysAgo(5));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(0);
  });

  it("does not decay recently confirmed memories", async () => {
    await insertMemory(client, "m1", 0.9, daysAgo(90), null, daysAgo(10));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(0);
  });

  it("uses most recent activity timestamp", async () => {
    // learned 90 days ago but confirmed 5 days ago — should not decay
    await insertMemory(client, "m1", 0.9, daysAgo(90), null, daysAgo(5));
    const decayed = await applyConfidenceDecay(client);
    expect(decayed).toBe(0);
  });
});
