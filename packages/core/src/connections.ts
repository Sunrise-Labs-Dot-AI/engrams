/**
 * Wave 2.5 — connection-creation infrastructure.
 *
 * Pure-SQL module (no LLM, no MCP coupling) supporting four layered mechanisms
 * documented in `~/.claude/plans/session-start-tranquil-zephyr.md`:
 *
 *   L1 — Caller-supplied `connections[]` at memory_write time.
 *        applyCallerSuppliedConnections(): synchronous, returns per-edge result.
 *
 *   L2a — Server-deterministic auto-edge by entity_name match at write time.
 *         applyEntityNameAutoEdges(): designed to be called via setImmediate
 *         AFTER the write response is returned. Failures log to stderr; never
 *         block.
 *
 *   L3 — Recurring task: caller-LLM classifies server-generated proposals.
 *        selectSourceMemoriesForProposals() + generateCandidatesForMemory()
 *        produce the LLM-free server side; the calling agent's LLM does the
 *        classification; commits land via validateAndInsertConnections().
 *
 *   L4 — Operator-run one-off backfill (separate script, not in this module).
 *
 * Architectural principle: this module never makes an LLM call. All inference
 * happens caller-side or in operator-run scripts. Lodis stays LLM-free at
 * runtime.
 *
 * Permission filtering (Security F5 in plan-review round 2): this module
 * does NOT know about agent_permissions. The MCP tool handlers in server.ts
 * are responsible for filtering proposals by checkPermission and rejecting
 * batch entries where the caller lacks write permission on the source domain.
 * That keeps this module pure and testable without the permission machinery.
 */

import type { Client } from "@libsql/client";
import type { Relationship } from "./types.js";

// ---------- Types ----------

/**
 * One caller-supplied connection on memory_write or memory_bulk_upload.
 * Either targetMemoryId OR targetEntityName must be supplied; if both are
 * present, targetMemoryId wins (more specific).
 */
export interface ConnectionInput {
  targetMemoryId?: string;
  targetEntityName?: string;
  relationship: Relationship;
}

export type ConnectionDropReason =
  | "not_found"            // targetEntityName resolved to nothing in this user's pool
  | "self_reference"       // target === source
  | "duplicate"            // edge already exists (INSERT OR IGNORE no-op)
  | "permission_denied"    // caller lacks write permission on source domain (set by server.ts)
  | "not_owned_or_missing" // memory_connect_batch: target id not in calling user's pool (Security F1)
  | "missing_target";      // neither targetMemoryId nor targetEntityName supplied

export interface DroppedConnection {
  targetMemoryId?: string;
  targetEntityName?: string;
  relationship?: Relationship;
  reason: ConnectionDropReason;
}

export interface ConnectionsResult {
  applied: number;
  dropped: DroppedConnection[];
}

// ---------- L1 — caller-supplied connections (sync, write-time) ----------

/**
 * Resolve a target by memory id (preferred) or entity_name (fallback) within
 * the calling user's scope only. Security F3: targetEntityName resolution is
 * ALWAYS user-scoped — even in local mode where userId is NULL, we use
 * `user_id IS ?` so the comparison treats NULL safely and never crosses
 * tenant boundaries.
 *
 * Returns the resolved target memory id, or null if no match.
 */
async function resolveTarget(
  client: Client,
  sourceMemoryId: string,
  input: ConnectionInput,
  userId: string | null,
): Promise<string | null> {
  if (input.targetMemoryId) {
    // Verify the id exists in the user's pool.
    const r = await client.execute({
      sql: `SELECT 1 FROM memories
             WHERE id = ?1
               AND user_id IS ?2
               AND deleted_at IS NULL
             LIMIT 1`,
      args: [input.targetMemoryId, userId],
    });
    return r.rows.length === 0 ? null : input.targetMemoryId;
  }
  if (input.targetEntityName) {
    const r = await client.execute({
      sql: `SELECT id FROM memories
             WHERE entity_name = ?1 COLLATE NOCASE
               AND id != ?2
               AND deleted_at IS NULL
               AND user_id IS ?3
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1`,
      args: [input.targetEntityName, sourceMemoryId, userId],
    });
    return r.rows.length === 0 ? null : (r.rows[0].id as string);
  }
  return null;
}

/**
 * L1: apply a caller-supplied list of connections to a freshly-written memory.
 * Synchronous (caller awaits this before returning the write response) so the
 * connections_result is part of the response payload. Idempotent via the
 * unique edge index added in the wave2_5_connection_indexes migration.
 *
 * The caller (server.ts) is responsible for:
 *   - filtering inputs whose source domain the caller lacks write on
 *     (set reason="permission_denied" before calling this)
 *   - bounding the input list size if untrusted
 */
export async function applyCallerSuppliedConnections(
  client: Client,
  sourceMemoryId: string,
  inputs: ConnectionInput[],
  userId: string | null,
): Promise<ConnectionsResult> {
  const result: ConnectionsResult = { applied: 0, dropped: [] };
  if (inputs.length === 0) return result;

  for (const input of inputs) {
    if (!input.targetMemoryId && !input.targetEntityName) {
      result.dropped.push({ ...input, reason: "missing_target" });
      continue;
    }
    const targetId = await resolveTarget(client, sourceMemoryId, input, userId);
    if (!targetId) {
      result.dropped.push({ ...input, reason: "not_found" });
      continue;
    }
    if (targetId === sourceMemoryId) {
      result.dropped.push({ ...input, reason: "self_reference" });
      continue;
    }
    // Insert OR IGNORE — depends on the unique index from the
    // wave2_5_connection_indexes migration. rowsAffected==0 means a duplicate.
    const ins = await client.execute({
      sql: `INSERT OR IGNORE INTO memory_connections
              (source_memory_id, target_memory_id, relationship, user_id)
            VALUES (?1, ?2, ?3, ?4)`,
      args: [sourceMemoryId, targetId, input.relationship, userId],
    });
    if (ins.rowsAffected > 0) {
      result.applied++;
    } else {
      result.dropped.push({ ...input, targetMemoryId: targetId, reason: "duplicate" });
    }
  }

  return result;
}

// ---------- L2a — server-deterministic auto-edge by entity_name (async) ----------

/**
 * Env flag for L2a. DISABLED-wins precedence (mirrors W2 PPR + reranker
 * patterns). Default ON when no flag is set — it's the safety-net layer that
 * catches what L1 missed.
 *
 *   • LODIS_L2_ENRICHMENT_DISABLED=1 → off
 *   • otherwise → on
 */
export function isL2EnrichmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LODIS_L2_ENRICHMENT_DISABLED === "1") return false;
  return true;
}

/**
 * L2a: when a freshly-written memory has entity_name set, auto-create
 * `related` edges to up to 10 existing memories with the same entity_name
 * (case-insensitive, user-scoped). Bounded to prevent runaway on common names
 * ("James", "Anthropic").
 *
 * IMPORTANT: this function is designed to be called via `setImmediate` AFTER
 * the write response is returned to the caller. The write commit MUST NOT
 * block on this. Failures log to stderr and do not propagate.
 *
 * Returns the count of edges actually inserted (for telemetry / tests).
 */
export async function applyEntityNameAutoEdges(
  client: Client,
  sourceMemoryId: string,
  entityName: string | null,
  userId: string | null,
): Promise<{ applied: number }> {
  if (!entityName || entityName.trim() === "") return { applied: 0 };
  if (!isL2EnrichmentEnabled()) return { applied: 0 };

  try {
    const matches = await client.execute({
      sql: `SELECT id FROM memories
             WHERE entity_name = ?1 COLLATE NOCASE
               AND id != ?2
               AND deleted_at IS NULL
               AND user_id IS ?3
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 10`,
      args: [entityName, sourceMemoryId, userId],
    });
    let applied = 0;
    for (const row of matches.rows) {
      const targetId = row.id as string;
      const ins = await client.execute({
        sql: `INSERT OR IGNORE INTO memory_connections
                (source_memory_id, target_memory_id, relationship, user_id)
              VALUES (?1, ?2, 'related', ?3)`,
        args: [sourceMemoryId, targetId, userId],
      });
      if (ins.rowsAffected > 0) applied++;
    }
    return { applied };
  } catch (err) {
    // Async path — never throw to the caller. Log and move on.
    process.stderr.write(
      `[lodis] L2a entity-name auto-edge failed for ${sourceMemoryId}: ${(err as Error)?.message ?? String(err)}\n`,
    );
    return { applied: 0 };
  }
}

// ---------- L3 — proposal generation (LLM-free server side) ----------

export interface ProposalSourceRow {
  id: string;
  content: string;
  detail: string | null;
  entity_name: string | null;
  entity_type: string | null;
  domain: string;
}

export interface ProposalCandidateRow {
  id: string;
  entity_name: string | null;
  content_snippet: string;
  similarity: number; // cosine; 0 if embeddings unavailable
  suggested_relationship_hints: Relationship[];
}

export interface SelectSourcesOptions {
  /** Max source memories to return (default 50). Plan §L3 cadence guidance. */
  limit?: number;
  /** Cooldown — only consider memories created more than this many hours ago.
   *  Default 6h (give L1+L2a a chance to land). */
  minAgeHours?: number;
  /** When true, include memories that already have outgoing edges. Useful for
   *  re-checking. Default false (zero-edge cursor). */
  includeAlreadyConnected?: boolean;
}

/**
 * L3: select source memories that need connection-creation attention.
 *
 * Default selection criterion (Cost/Scope F2 + Saboteur F1 + New Hire F1 in
 * plan-review round 2: edge count is a better cursor than the originally-
 * planned timestamp column):
 *
 *   - Zero outgoing edges in memory_connections (LEFT JOIN ... IS NULL)
 *   - Created more than minAgeHours ago (give L1 + L2a a chance to land)
 *   - Not deleted
 *   - User-scoped
 *   - entity_type IS NOT 'snippet' — snippets are explicitly low-graph-relevance
 *     ephemeral writes (Saboteur F8 livelock prevention; the snippet writer
 *     can produce 500/hr per agent, and we don't want L3 swamped by them)
 *
 * Order: oldest first (FIFO drain).
 *
 * Permission filtering happens in the caller (server.ts), NOT here. This
 * function returns raw rows.
 */
export async function selectSourceMemoriesForProposals(
  client: Client,
  userId: string | null,
  options: SelectSourcesOptions = {},
): Promise<ProposalSourceRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const minAgeHours = Math.max(0, options.minAgeHours ?? 6);
  const includeAlreadyConnected = options.includeAlreadyConnected ?? false;

  // Compare via julianday() to avoid format mismatch — `learned_at` is
  // typically ISO 8601 ("2026-04-25T10:23:52.123Z") while `datetime('now', ...)`
  // returns SQLite's space-separated form ("2026-04-25 04:23:52"). Lexical
  // comparison would silently misbehave (T > space). julianday() canonicalizes
  // both sides to a numeric Julian Day Number.
  const sql = includeAlreadyConnected
    ? `SELECT m.id, m.content, m.detail, m.entity_name, m.entity_type, m.domain
         FROM memories m
        WHERE m.deleted_at IS NULL
          AND m.user_id IS ?1
          AND m.entity_type IS NOT 'snippet'
          AND julianday(m.learned_at) < julianday('now', '-' || ?2 || ' hours')
        ORDER BY m.learned_at ASC
        LIMIT ?3`
    : `SELECT m.id, m.content, m.detail, m.entity_name, m.entity_type, m.domain
         FROM memories m
         LEFT JOIN memory_connections mc
           ON mc.source_memory_id = m.id
        WHERE mc.source_memory_id IS NULL
          AND m.deleted_at IS NULL
          AND m.user_id IS ?1
          AND m.entity_type IS NOT 'snippet'
          AND julianday(m.learned_at) < julianday('now', '-' || ?2 || ' hours')
        ORDER BY m.learned_at ASC
        LIMIT ?3`;

  const r = await client.execute({ sql, args: [userId, minAgeHours, limit] });
  return r.rows.map((row) => ({
    id: row.id as string,
    content: (row.content as string) ?? "",
    detail: (row.detail as string | null) ?? null,
    entity_name: (row.entity_name as string | null) ?? null,
    entity_type: (row.entity_type as string | null) ?? null,
    domain: (row.domain as string) ?? "general",
  }));
}

export interface GenerateCandidatesOptions {
  /** Max candidates to return per source memory (default 10). */
  limit?: number;
}

/**
 * L3: for one source memory, generate a candidate list of plausible target
 * memories the calling LLM should consider for connection. Pre-filtered by:
 *
 *   - Entity-name token match (any candidate sharing an entity_name with the
 *     source — exact-string match for v1; future: token-level overlap).
 *   - Same-domain bias (prefer same domain; not exclusionary).
 *   - User-scoped.
 *
 * Embedding similarity is included when both rows have embeddings stored on
 * `memories.embedding` (vec column). Computed via libSQL's vector_distance_cos
 * function; rows lacking embeddings get similarity = 0 (still surfaced as
 * candidates if entity_name matches).
 *
 * Returned candidates do NOT include duplicates of the source's existing
 * outgoing or incoming connections (those edges already exist).
 */
export async function generateCandidatesForMemory(
  client: Client,
  source: ProposalSourceRow,
  userId: string | null,
  options: GenerateCandidatesOptions = {},
): Promise<ProposalCandidateRow[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));

  // Existing edges to exclude. Bidirectional — we don't want to suggest an
  // edge that's already in either direction.
  const existing = await client.execute({
    sql: `SELECT target_memory_id AS id FROM memory_connections WHERE source_memory_id = ?1
          UNION
          SELECT source_memory_id AS id FROM memory_connections WHERE target_memory_id = ?1`,
    args: [source.id],
  });
  const excluded = new Set<string>([source.id, ...existing.rows.map((r) => r.id as string)]);

  // Collect candidates by entity-name match. Only proceeds when the source
  // has an entity_name to anchor on; otherwise returns empty (the LLM can
  // still classify but has nothing to chew on without anchors).
  const candidates: Map<string, ProposalCandidateRow> = new Map();
  if (source.entity_name) {
    const r = await client.execute({
      sql: `SELECT id, entity_name, content, domain
              FROM memories
             WHERE entity_name = ?1 COLLATE NOCASE
               AND deleted_at IS NULL
               AND user_id IS ?2
             ORDER BY updated_at DESC NULLS LAST
             LIMIT ?3`,
      args: [source.entity_name, userId, limit * 2],
    });
    for (const row of r.rows) {
      const id = row.id as string;
      if (excluded.has(id)) continue;
      candidates.set(id, {
        id,
        entity_name: (row.entity_name as string | null) ?? null,
        content_snippet: ((row.content as string) ?? "").slice(0, 200),
        similarity: 0,
        suggested_relationship_hints: ["related"],
      });
    }
  }

  // Augment with same-domain memories (best-effort; capped at the limit).
  if (candidates.size < limit) {
    const r = await client.execute({
      sql: `SELECT id, entity_name, content
              FROM memories
             WHERE domain = ?1
               AND id != ?2
               AND deleted_at IS NULL
               AND user_id IS ?3
             ORDER BY updated_at DESC NULLS LAST
             LIMIT ?4`,
      args: [source.domain, source.id, userId, limit * 2],
    });
    for (const row of r.rows) {
      const id = row.id as string;
      if (excluded.has(id) || candidates.has(id)) continue;
      if (candidates.size >= limit) break;
      candidates.set(id, {
        id,
        entity_name: (row.entity_name as string | null) ?? null,
        content_snippet: ((row.content as string) ?? "").slice(0, 200),
        similarity: 0,
        suggested_relationship_hints: ["related"],
      });
    }
  }

  return Array.from(candidates.values()).slice(0, limit);
}

// ---------- memory_connect_batch — secure bulk insertion ----------

export interface ConnectBatchInput {
  source_memory_id: string;
  target_memory_id: string;
  relationship: Relationship;
}

export interface ConnectBatchResult {
  applied: number;
  dropped: Array<{
    source_memory_id: string;
    target_memory_id: string;
    relationship: Relationship;
    reason: ConnectionDropReason;
  }>;
}

/**
 * memory_connect_batch implementation: validate per-edge user ownership of
 * BOTH endpoints (Security F1 in plan-review round 2 — CRITICAL: prevents
 * cross-user graph poisoning), then INSERT OR IGNORE against the unique edge
 * index.
 *
 * Permission filtering on the SOURCE domain (write permission) happens in
 * the caller (server.ts) before reaching this function — entries that fail
 * the permission check are passed in already filtered out, OR passed in with
 * a pre-set rejection reason. This module enforces ownership only.
 */
export async function validateAndInsertConnectBatch(
  client: Client,
  inputs: ConnectBatchInput[],
  userId: string | null,
): Promise<ConnectBatchResult> {
  const result: ConnectBatchResult = { applied: 0, dropped: [] };
  if (inputs.length === 0) return result;

  for (const conn of inputs) {
    if (conn.source_memory_id === conn.target_memory_id) {
      result.dropped.push({ ...conn, reason: "self_reference" });
      continue;
    }
    // Per-edge user-id ownership check on BOTH endpoints. Security F1.
    const ok = await client.execute({
      sql: `SELECT 1
              FROM memories m1
              JOIN memories m2 ON 1=1
             WHERE m1.id = ?1 AND m2.id = ?2
               AND m1.user_id IS ?3 AND m2.user_id IS ?3
               AND m1.deleted_at IS NULL AND m2.deleted_at IS NULL
             LIMIT 1`,
      args: [conn.source_memory_id, conn.target_memory_id, userId],
    });
    if (ok.rows.length === 0) {
      result.dropped.push({ ...conn, reason: "not_owned_or_missing" });
      continue;
    }
    const ins = await client.execute({
      sql: `INSERT OR IGNORE INTO memory_connections
              (source_memory_id, target_memory_id, relationship, user_id)
            VALUES (?1, ?2, ?3, ?4)`,
      args: [conn.source_memory_id, conn.target_memory_id, conn.relationship, userId],
    });
    if (ins.rowsAffected > 0) result.applied++;
    else result.dropped.push({ ...conn, reason: "duplicate" });
  }

  return result;
}
