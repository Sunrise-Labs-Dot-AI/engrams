import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { createDatabase } from "../db.js";
import { utilityBoost } from "../search.js";
import type { Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `lodis-test-${randomBytes(8).toString("hex")}.db`);
}

async function insertRetrieval(
  client: Client,
  id: string,
  noiseIds: string[],
) {
  await client.execute({
    sql: `INSERT INTO context_retrievals
          (id, query, token_budget, format, tokens_used, returned_memory_ids_json, saturation_json, score_distribution_json, created_at, rated_at, noise_memory_ids_json)
          VALUES (?, 'q', 1000, 'hierarchical', 500, '[]', '{}', '{}', ?, ?, ?)`,
    args: [id, new Date().toISOString(), new Date().toISOString(), JSON.stringify(noiseIds)],
  });
}

describe("utilityBoost", () => {
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

  it("returns 1.0 for a memory with no signal", async () => {
    const b = await utilityBoost(client, "m1", 0, 0);
    expect(b).toBe(1);
  });

  it("boosts upward for referenced memories", async () => {
    const b3 = await utilityBoost(client, "m1", 3, 0);
    expect(b3).toBeGreaterThan(1);
    expect(b3).toBeCloseTo(1 + 0.08 * Math.log(4), 5);

    const b20 = await utilityBoost(client, "m1", 20, 0);
    expect(b20).toBeGreaterThan(b3);
  });

  it("clamps upper bound to 1.5", async () => {
    const b = await utilityBoost(client, "m1", 100000, 0);
    expect(b).toBe(1.5);
  });

  it("clamps lower bound to 0.7", async () => {
    // Need noise_count ≥ 3 with ≥ 2 distinct retrievals for the penalty to kick in
    await insertRetrieval(client, "r1", ["m1"]);
    await insertRetrieval(client, "r2", ["m1"]);
    const b = await utilityBoost(client, "m1", 0, 100000);
    expect(b).toBe(0.7);
  });

  it("does NOT penalize memory flagged as noise in a single retrieval only", async () => {
    await insertRetrieval(client, "r1", ["m1"]);
    const b = await utilityBoost(client, "m1", 0, 10);
    expect(b).toBe(1); // gating requires distinct_retrievals >= 2
  });

  it("does NOT penalize when noise_count < 3", async () => {
    await insertRetrieval(client, "r1", ["m1"]);
    await insertRetrieval(client, "r2", ["m1"]);
    const b = await utilityBoost(client, "m1", 0, 2);
    expect(b).toBe(1); // noise_count < 3 short-circuits the check
  });

  it("applies noise penalty when both gates are satisfied", async () => {
    await insertRetrieval(client, "r1", ["m1"]);
    await insertRetrieval(client, "r2", ["m1"]);
    const b = await utilityBoost(client, "m1", 0, 5);
    expect(b).toBeLessThan(1);
    expect(b).toBeCloseTo(1 - 0.05 * Math.log(6), 5);
  });

  it("net positive when referenced dominates noise", async () => {
    await insertRetrieval(client, "r1", ["m1"]);
    await insertRetrieval(client, "r2", ["m1"]);
    const b = await utilityBoost(client, "m1", 10, 3);
    // boost = 1 + 0.08*ln(11) - 0.05*ln(4) ≈ 1.123
    expect(b).toBeGreaterThan(1);
  });
});
