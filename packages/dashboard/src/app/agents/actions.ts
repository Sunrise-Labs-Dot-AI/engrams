"use server";

import { revalidatePath } from "next/cache";
import { createClient, type Client } from "@libsql/client";
import { resolve } from "path";
import { homedir } from "os";
import { getUserId } from "@/lib/auth";

// Module-level memoization mirrors the pattern in `@/lib/db.ts`:
// Next "use server" actions instantiate fresh per request handler, but
// libsql's `createClient` opens a real sqlite handle (or holds a Turso
// HTTP client). Re-creating it per action call burns file handles in
// local mode and skips connection reuse in hosted mode. The schema
// migrations live in `lib/db.ts:ensureSchema`; that file is already
// awaited on every dashboard read, so by the time any action fires
// the schema is in place.
let _client: Client | null = null;
function getClient(): Client {
  if (_client) return _client;
  if (process.env.TURSO_DATABASE_URL) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } else {
    _client = createClient({
      url: "file:" + resolve(homedir(), ".lodis", "lodis.db"),
    });
  }
  return _client;
}

function userFilter(userId: string | null): { clause: string; args: (string | null)[] } {
  if (!userId) return { clause: "", args: [] };
  return { clause: " AND user_id = ?", args: [userId] };
}

// --- Validation ---
// agentId: 1-64 chars, alphanumerics plus . _ -. Prevents path traversal and
// control characters from leaking into WHERE-clause values that get echoed to
// UI or event logs.
const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
// domain: 1-128 chars, alphanumerics plus . _ - : (covers every domain
// currently in use in memories and the `general` default). Explicitly
// forbids whitespace, control characters, quotes, parens, `*` wildcard,
// and slashes — all of which either break URL paths (revalidatePath),
// enable log injection, or produce rendering glitches in UI chips.
// First character must be alphanumeric so " work" / "work " can't
// masquerade as a different bucket from "work".
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function validateAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agent id: must match ${AGENT_ID_RE}`);
  }
}

function validateDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid domain: must be 1-128 chars, no * " ( )`);
  }
}

// Ownership check: an agent is "owned" by a user if that user has ever seen
// a memory written by that agent_id. This prevents cross-tenant writes by
// agent id guess in hosted mode.
async function assertAgentOwnership(
  client: Client,
  userId: string | null,
  agentId: string,
): Promise<void> {
  const uf = userFilter(userId);
  const row = await client.execute({
    sql: `SELECT 1 FROM memories
            WHERE source_agent_id = ?${uf.clause}
            LIMIT 1`,
    args: [agentId, ...uf.args],
  });
  if (row.rows.length === 0) {
    throw new Error(`Agent not found: ${agentId}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Permission actions ---

export type AgentMode = "open" | "isolated";

function revalidateAgent(agentId: string) {
  revalidatePath("/agents", "layout");
  revalidatePath(`/agents/${agentId}`);
}

/**
 * Toggle the wildcard `(*, 0, 0)` row for an agent.
 *
 * `mode === "isolated"` upserts the wildcard-deny row; `mode === "open"`
 * deletes it. **Existing non-wildcard rules are preserved** — they
 * remain in `agent_permissions` and continue to apply. Result of
 * `deriveAgentMode` after this call therefore depends on what
 * non-wildcard rows already existed:
 *
 *   prior rules \ mode   |  open                  isolated
 *   ────────────────────────────────────────────────────────
 *   none                 |  open                  isolated
 *   one (d, 0, 0) row    |  open_blocklist        mixed *
 *   one (d, 1, 1) row    |  open †                isolated_allowlist
 *   any (d, 1, 0) etc.   |  mixed                 mixed
 *
 *   * because wildcard-deny + explicit (d, 0, 0) is a redundant block.
 *   † because allow rows under Open mode are no-ops.
 *
 * Use `applyPreset` for a full atomic reset to a clean Open or
 * Isolated+allowlist state.
 */
export async function setAgentMode(agentId: string, mode: AgentMode): Promise<void> {
  validateAgentId(agentId);
  if (mode !== "open" && mode !== "isolated") {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

  if (mode === "isolated") {
    // Atomic upsert — the idx_agent_permissions_unique index on
    // (agent_id, domain, IFNULL(user_id, '')) makes concurrent
    // "Isolated" clicks converge to a single wildcard row instead of
    // racing past a SELECT-then-INSERT window.
    await client.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
            VALUES (?, '*', 0, 0, ?)
            ON CONFLICT DO UPDATE SET can_read = 0, can_write = 0`,
      args: [agentId, userId],
    });
  } else {
    await client.execute({
      sql: `DELETE FROM agent_permissions
              WHERE agent_id = ? AND domain = '*'${uf.clause}`,
      args: [agentId, ...uf.args],
    });
  }

  revalidateAgent(agentId);
}

/**
 * Block an agent from a domain under Open mode: upsert (domain, 0, 0).
 */
export async function blockDomain(agentId: string, domain: string): Promise<void> {
  validateAgentId(agentId);
  validateDomain(domain);
  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);

  await client.execute({
    sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
          VALUES (?, ?, 0, 0, ?)
          ON CONFLICT DO UPDATE SET can_read = 0, can_write = 0`,
    args: [agentId, domain, userId],
  });

  revalidateAgent(agentId);
}

/**
 * Allow an agent on a domain under Isolated mode: upsert (domain, 1, 1).
 * If the target domain is marked sensitive, caller must pass confirmed=true
 * or this throws.
 */
export async function allowDomain(
  agentId: string,
  domain: string,
  confirmed = false,
): Promise<void> {
  validateAgentId(agentId);
  validateDomain(domain);
  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

  const sensitiveRow = await client.execute({
    sql: `SELECT 1 FROM sensitive_domains
            WHERE domain = ?${uf.clause}`,
    args: [domain, ...uf.args],
  });
  if (sensitiveRow.rows.length > 0 && !confirmed) {
    throw new Error(`Domain "${domain}" is marked sensitive — confirmation required`);
  }

  await client.execute({
    sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
          VALUES (?, ?, 1, 1, ?)
          ON CONFLICT DO UPDATE SET can_read = 1, can_write = 1`,
    args: [agentId, domain, userId],
  });

  revalidateAgent(agentId);
}

/**
 * Remove a specific domain rule for an agent. Does not touch the wildcard.
 */
export async function removeRule(agentId: string, domain: string): Promise<void> {
  validateAgentId(agentId);
  validateDomain(domain);
  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

  await client.execute({
    sql: `DELETE FROM agent_permissions
            WHERE agent_id = ? AND domain = ?${uf.clause}`,
    args: [agentId, domain, ...uf.args],
  });

  revalidateAgent(agentId);
}

/**
 * Delete every permission row for an agent, returning it to the implicit
 * "Open (no rules)" state. Used by the advanced editor as an escape hatch
 * when an agent's rules can't be expressed in the simplified UI.
 */
export async function resetAgentRules(agentId: string): Promise<void> {
  validateAgentId(agentId);
  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

  await client.execute({
    sql: `DELETE FROM agent_permissions
            WHERE agent_id = ?${uf.clause}`,
    args: [agentId, ...uf.args],
  });

  revalidateAgent(agentId);
}

export type Preset = "work" | "personal" | "lockdown";

/**
 * Atomically replace all permission rows for an agent with an Isolated
 * + allowlist configuration. `domains` is the allowlist (empty / ignored
 * for Lockdown).
 *
 * Server-side behavior:
 * - Validates `agentId` and every domain via DOMAIN_RE.
 * - Verifies the caller owns `agentId` via `assertAgentOwnership`.
 * - Rejects `preset === "lockdown"` with a non-empty `domains`
 *   argument to keep the semantics unambiguous (Lockdown = nothing).
 * - Cross-references the allowlist with `sensitive_domains` and
 *   requires every sensitive domain to appear in
 *   `confirmedSensitiveDomains`, mirroring the confirmation the
 *   `allowDomain` chip flow enforces. The UI layer captures this in
 *   the preset modal (see `preset-modal.tsx`).
 * - Runs DELETE + INSERT(wildcard) + INSERT(...allowlist) inside a
 *   single `client.batch(..., "write")` so prior rules survive on
 *   failure.
 * - Revalidates `/agents` (layout) and `/agents/{agentId}`.
 *
 * The plan's fail-closed posture: we write the wildcard-deny row
 * BEFORE the allowlist inserts so a reader that observes the
 * mid-transaction state sees "Isolated, no allowlist" (agent sees
 * nothing) rather than the opposite.
 */
export async function applyPreset(
  agentId: string,
  preset: Preset,
  domains: string[],
  confirmedSensitiveDomains: string[] = [],
): Promise<void> {
  validateAgentId(agentId);
  if (preset !== "work" && preset !== "personal" && preset !== "lockdown") {
    throw new Error(`Invalid preset: ${preset}`);
  }
  // Lockdown = isolate with zero allowlist. Reject any stray domains
  // argument so callers can't accidentally ship an allowlist under the
  // Lockdown label; the caller should have routed to Work/Personal.
  if (preset === "lockdown" && domains.length > 0) {
    throw new Error("Lockdown preset takes no allowlist domains");
  }
  const allowlist = preset === "lockdown" ? [] : domains;
  for (const d of allowlist) validateDomain(d);

  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

  // Sensitive-domain confirmation gate (parity with allowDomain).
  // Any allowlist entry that is marked sensitive for this user must
  // appear in `confirmedSensitiveDomains`, otherwise throw.
  if (allowlist.length > 0) {
    const placeholders = allowlist.map(() => "?").join(",");
    const sensitiveHits = await client.execute({
      sql: `SELECT domain FROM sensitive_domains
              WHERE domain IN (${placeholders})${uf.clause}`,
      args: [...allowlist, ...uf.args],
    });
    const sensitiveSet = new Set(sensitiveHits.rows.map(r => r.domain as string));
    const confirmed = new Set(confirmedSensitiveDomains);
    const missing = [...sensitiveSet].filter(d => !confirmed.has(d));
    if (missing.length > 0) {
      throw new Error(
        `Sensitive domain${missing.length === 1 ? "" : "s"} require confirmation: ${missing.join(", ")}`,
      );
    }
  }

  const stmts = [
    {
      sql: `DELETE FROM agent_permissions
              WHERE agent_id = ?${uf.clause}`,
      args: [agentId, ...uf.args] as (string | null)[],
    },
    {
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
            VALUES (?, '*', 0, 0, ?)`,
      args: [agentId, userId] as (string | null)[],
    },
    ...allowlist.map(d => ({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
            VALUES (?, ?, 1, 1, ?)`,
      args: [agentId, d, userId] as (string | null)[],
    })),
  ];

  await client.batch(stmts, "write");

  revalidateAgent(agentId);
}

/**
 * Mark (or unmark) a domain as sensitive for the current user. Purely a
 * flag on the sensitive_domains table; enforcement lives in allowDomain,
 * memory_write (MCP, wired in slice 3), and UI rendering.
 */
export async function markDomainSensitive(
  domain: string,
  sensitive: boolean,
): Promise<void> {
  validateDomain(domain);
  const client = getClient();
  const userId = await getUserId();
  const uf = userFilter(userId);

  if (sensitive) {
    // Atomic upsert against idx_sensitive_domains_user_domain
    // (IFNULL(user_id, ''), domain). Idempotent under concurrent clicks.
    await client.execute({
      sql: `INSERT INTO sensitive_domains (user_id, domain, marked_at) VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [userId, domain, nowIso()],
    });
  } else {
    await client.execute({
      sql: `DELETE FROM sensitive_domains
              WHERE domain = ?${uf.clause}`,
      args: [domain, ...uf.args],
    });
  }

  revalidatePath("/agents");
  // The Link in the sensitive panel / top-domain list url-encodes the
  // domain; if we revalidate the raw form, Next won't match the cache
  // key for any domain containing a space or slash and the "sensitive"
  // state will stay stale until the RSC cache ages out.
  revalidatePath(`/agents/domains/${encodeURIComponent(domain)}`);
}

