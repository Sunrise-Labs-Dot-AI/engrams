// Atomicity test for the applyPreset server action's SQL pattern (§B
// applyPreset.test.ts from the Agent Permissions redesign plan).
//
// The action itself lives in the dashboard package ("use server") which
// has no vitest infra yet. This test exercises the exact SQL pattern it
// uses against a libsql DB to confirm:
//   1. Happy path: DELETE + INSERT wildcard + INSERT allowlist produces
//      exactly (userId, agentId, '*', 0, 0) + one (userId, agentId, d, 1, 1)
//      per allowlist entry.
//   2. Crash between DELETE and the inserts within a batch leaves prior
//      rules unchanged (transaction rollback).
//   3. Two concurrent presets serialize — no lost writes, no zero-row state
//      observable after both complete.
//
// When dashboard vitest infra lands (slice 2), this test should be
// complemented by a test that calls the action directly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { randomBytes } from "crypto";
import { createClient, type Client } from "@libsql/client";

function tempDbPath(): string {
  return resolve(tmpdir(), `lodis-preset-atomic-${randomBytes(8).toString("hex")}.db`);
}

async function setup(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS agent_permissions (
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      can_read INTEGER NOT NULL DEFAULT 1,
      can_write INTEGER NOT NULL DEFAULT 1,
      user_id TEXT
    );
  `);
}

async function rules(db: Client, agentId: string, userId: string | null) {
  const uf = userId ? " AND user_id = ?" : "";
  const args = userId ? [agentId, userId] : [agentId];
  const res = await db.execute({
    sql: `SELECT domain, can_read as r, can_write as w FROM agent_permissions
            WHERE agent_id = ?${uf}
            ORDER BY domain`,
    args,
  });
  return res.rows.map(r => ({ domain: r.domain as string, r: r.r as number, w: r.w as number }));
}

function presetStmts(agentId: string, userId: string | null, allowlist: string[]) {
  const uf = userId ? " AND user_id = ?" : "";
  const delArgs: (string | null)[] = userId ? [agentId, userId] : [agentId];
  return [
    { sql: `DELETE FROM agent_permissions WHERE agent_id = ?${uf}`, args: delArgs },
    {
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, '*', 0, 0, ?)`,
      args: [agentId, userId] as (string | null)[],
    },
    ...allowlist.map(d => ({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, ?, 1, 1, ?)`,
      args: [agentId, d, userId] as (string | null)[],
    })),
  ];
}

describe("applyPreset SQL pattern — atomicity", () => {
  let dbPath: string;
  let db: Client;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createClient({ url: "file:" + dbPath });
    await setup(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (existsSync(p)) unlinkSync(p);
      }
    } catch { /* noop */ }
  });

  it("happy path: writes exactly wildcard + allowlist rows", async () => {
    await db.batch(presetStmts("agent_x", null, ["a", "b"]), "write");
    const r = await rules(db, "agent_x", null);
    expect(r).toEqual([
      { domain: "*", r: 0, w: 0 },
      { domain: "a", r: 1, w: 1 },
      { domain: "b", r: 1, w: 1 },
    ]);
  });

  it("replaces existing rules — any prior row is wiped before inserts", async () => {
    // Seed a stale rule that should not survive the preset.
    await db.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["agent_x", "stale", 0, 0, null],
    });

    await db.batch(presetStmts("agent_x", null, ["a"]), "write");
    const r = await rules(db, "agent_x", null);
    expect(r.map(x => x.domain).sort()).toEqual(["*", "a"]);
  });

  it("is scoped to the target agent — other agents' rules survive", async () => {
    await db.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["agent_y", "untouched", 1, 1, null],
    });
    await db.batch(presetStmts("agent_x", null, ["a"]), "write");

    const xRules = await rules(db, "agent_x", null);
    const yRules = await rules(db, "agent_y", null);
    expect(xRules.map(x => x.domain).sort()).toEqual(["*", "a"]);
    expect(yRules).toEqual([{ domain: "untouched", r: 1, w: 1 }]);
  });

  it("is scoped by userId — other users' rules survive", async () => {
    await db.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["agent_x", "untouched", 1, 1, "other_user"],
    });
    await db.batch(presetStmts("agent_x", "target_user", ["a"]), "write");

    const targetRules = await rules(db, "agent_x", "target_user");
    const otherRules = await rules(db, "agent_x", "other_user");
    expect(targetRules.map(x => x.domain).sort()).toEqual(["*", "a"]);
    expect(otherRules).toEqual([{ domain: "untouched", r: 1, w: 1 }]);
  });

  it("rolls back on a failing INSERT in the batch — prior rules unchanged", async () => {
    // Seed an "Open" configuration: a single explicit block row, no wildcard.
    await db.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["agent_x", "initial", 0, 0, null],
    });

    // Introduce a deliberately invalid statement at the end to force rollback.
    const stmts = presetStmts("agent_x", null, ["a"]).concat([
      { sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id) VALUES (?)`, args: ["broken"] },
    ]);

    await expect(db.batch(stmts, "write")).rejects.toThrow();

    // After rollback, the original row should still be there and no wildcard
    // row should have been persisted.
    const r = await rules(db, "agent_x", null);
    expect(r).toEqual([{ domain: "initial", r: 0, w: 0 }]);
  });

  it("two concurrent presets serialize — final state matches one of them, no zero-row drift", async () => {
    const p1 = db.batch(presetStmts("agent_x", null, ["a"]), "write");
    const p2 = db.batch(presetStmts("agent_x", null, ["b", "c"]), "write");
    await Promise.all([p1, p2]);

    const r = await rules(db, "agent_x", null);
    const domains = r.map(x => x.domain).sort();
    // Last writer wins; wildcard must always be present; allowlist matches one of the two inputs.
    expect(domains).toContain("*");
    const nonWildcard = domains.filter(d => d !== "*");
    const acceptable = [
      ["a"],
      ["b", "c"],
    ];
    expect(acceptable).toContainEqual(nonWildcard);
  });
});
