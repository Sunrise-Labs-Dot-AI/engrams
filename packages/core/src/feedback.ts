import type { Client, InStatement } from "@libsql/client";
import { randomBytes } from "crypto";
import { applyUsed } from "./confidence.js";

function generateId(): string {
  return randomBytes(16).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

export type RateContextStatus = "rated" | "already_rated_same" | "already_rated_different" | "not_found";

export interface RateContextResult {
  status: RateContextStatus;
  retrievalId: string;
  referenced: string[];
  noise: string[];
  droppedUnknownIds: string[];
  /** On already_rated_different, the original rating. */
  original?: {
    referenced: string[];
    noise: string[];
    notes: string | null;
    ratedAt: string;
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * Apply an agent's rating to a prior memory_context retrieval.
 *
 * Validation ladder (in order):
 *   1. Row lookup scoped to (retrievalId, userId) — generic not-found on miss.
 *   2. Optional agent ownership check — the original retrieval's agent must match if set.
 *   3. referenced/noise must be subsets of returned_memory_ids_json (unknowns silently dropped).
 *   4. referenced ∩ noise must be empty.
 *   5. Every surviving id must belong to a memories row owned by userId.
 *
 * Idempotency:
 *   - First successful call writes rated_at + counters + applyUsed() bumps.
 *   - Second call with identical args: no-op success (status: already_rated_same).
 *   - Second call with different args: status: already_rated_different, no mutations.
 */
export async function rateContext(
  client: Client,
  input: {
    userId: string | null;
    agentId?: string | null;
    retrievalId: string;
    referenced: string[];
    noise?: string[];
    notes?: string | null;
  },
): Promise<RateContextResult> {
  const { userId, agentId, retrievalId } = input;
  const referenced = Array.from(new Set(input.referenced ?? []));
  const noise = Array.from(new Set(input.noise ?? []));
  const notes = input.notes ?? null;

  // Step 1: scoped lookup
  const rowRes = await client.execute({
    sql: `SELECT id, user_id, agent_id, returned_memory_ids_json, rated_at,
                 referenced_memory_ids_json, noise_memory_ids_json, notes
          FROM context_retrievals
          WHERE id = ? AND (user_id IS ? OR user_id = ?)
          LIMIT 1`,
    args: [retrievalId, userId, userId],
  });
  if (rowRes.rows.length === 0) {
    return { status: "not_found", retrievalId, referenced, noise, droppedUnknownIds: [] };
  }
  const row = rowRes.rows[0] as unknown as {
    id: string;
    user_id: string | null;
    agent_id: string | null;
    returned_memory_ids_json: string;
    rated_at: string | null;
    referenced_memory_ids_json: string | null;
    noise_memory_ids_json: string | null;
    notes: string | null;
  };

  // Step 2: agent ownership
  if (row.agent_id && agentId && row.agent_id !== agentId) {
    return { status: "not_found", retrievalId, referenced, noise, droppedUnknownIds: [] };
  }

  // Step 3: subset validation
  const returnedSet = new Set<string>(JSON.parse(row.returned_memory_ids_json) as string[]);
  const droppedUnknownIds: string[] = [];
  const refFiltered = referenced.filter((id) => {
    if (returnedSet.has(id)) return true;
    droppedUnknownIds.push(id);
    return false;
  });
  const noiseFiltered = noise.filter((id) => {
    if (returnedSet.has(id)) return true;
    droppedUnknownIds.push(id);
    return false;
  });

  // Step 4: disjoint
  const refSet = new Set(refFiltered);
  for (const id of noiseFiltered) {
    if (refSet.has(id)) {
      throw new Error(`Memory id ${id} cannot be in both referenced and noise`);
    }
  }

  // Idempotency check against prior rating
  if (row.rated_at) {
    const origRef: string[] = JSON.parse(row.referenced_memory_ids_json ?? "[]");
    const origNoise: string[] = JSON.parse(row.noise_memory_ids_json ?? "[]");
    const origNotes = row.notes;
    const same = sameSet(origRef, refFiltered) && sameSet(origNoise, noiseFiltered) && origNotes === notes;
    if (same) {
      return {
        status: "already_rated_same",
        retrievalId,
        referenced: origRef,
        noise: origNoise,
        droppedUnknownIds,
      };
    }
    return {
      status: "already_rated_different",
      retrievalId,
      referenced: refFiltered,
      noise: noiseFiltered,
      droppedUnknownIds,
      original: { referenced: origRef, noise: origNoise, notes: origNotes, ratedAt: row.rated_at },
    };
  }

  // Step 5: verify user_id ownership on each memory (or tolerate soft-deleted tombstones)
  const validRefs: string[] = [];
  const validNoise: string[] = [];
  for (const id of refFiltered) {
    const r = await client.execute({
      sql: `SELECT user_id, confidence FROM memories WHERE id = ? LIMIT 1`,
      args: [id],
    });
    if (r.rows.length === 0) continue;
    const m = r.rows[0] as unknown as { user_id: string | null; confidence: number };
    if ((m.user_id ?? null) !== (userId ?? null)) continue;
    validRefs.push(id);
  }
  for (const id of noiseFiltered) {
    const r = await client.execute({
      sql: `SELECT user_id FROM memories WHERE id = ? LIMIT 1`,
      args: [id],
    });
    if (r.rows.length === 0) continue;
    const m = r.rows[0] as unknown as { user_id: string | null };
    if ((m.user_id ?? null) !== (userId ?? null)) continue;
    validNoise.push(id);
  }

  // Build one batch
  const timestamp = now();
  const stmts: InStatement[] = [
    {
      sql: `UPDATE context_retrievals
            SET rated_at = ?, referenced_memory_ids_json = ?, noise_memory_ids_json = ?, notes = ?
            WHERE id = ?`,
      args: [timestamp, JSON.stringify(validRefs), JSON.stringify(validNoise), notes, retrievalId],
    },
  ];

  for (const id of validRefs) {
    // Read current confidence then apply applyUsed bump
    const r = await client.execute({
      sql: `SELECT confidence FROM memories WHERE id = ? LIMIT 1`,
      args: [id],
    });
    if (r.rows.length === 0) continue;
    const currentConf = (r.rows[0] as unknown as { confidence: number }).confidence;
    const newConf = applyUsed(currentConf);
    stmts.push({
      sql: `UPDATE memories
            SET referenced_count = referenced_count + 1,
                last_referenced_at = ?,
                confidence = ?
            WHERE id = ?`,
      args: [timestamp, newConf, id],
    });
    stmts.push({
      sql: `INSERT INTO memory_events (id, memory_id, event_type, agent_id, old_value, new_value, timestamp, user_id)
            VALUES (?, ?, 'referenced', ?, ?, ?, ?, ?)`,
      args: [generateId(), id, agentId ?? null, String(currentConf), String(newConf), timestamp, userId ?? null],
    });
  }

  for (const id of validNoise) {
    stmts.push({
      sql: `UPDATE memories SET noise_count = noise_count + 1 WHERE id = ?`,
      args: [id],
    });
    stmts.push({
      sql: `INSERT INTO memory_events (id, memory_id, event_type, agent_id, timestamp, user_id)
            VALUES (?, ?, 'noise_flagged', ?, ?, ?)`,
      args: [generateId(), id, agentId ?? null, timestamp, userId ?? null],
    });
  }

  await client.batch(stmts, "write");

  return {
    status: "rated",
    retrievalId,
    referenced: validRefs,
    noise: validNoise,
    droppedUnknownIds,
  };
}
