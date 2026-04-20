"use server";

import { revalidatePath } from "next/cache";
import { createClient, type Client } from "@libsql/client";
import { resolve } from "path";
import { homedir } from "os";
import { getUserId } from "@/lib/auth";

function getClient() {
  if (process.env.TURSO_DATABASE_URL) {
    return createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return createClient({
    url: "file:" + resolve(homedir(), ".lodis", "lodis.db"),
  });
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
// domain: 1-128 chars, no wildcard, no quotes/parens (FTS5-significant).
// The literal '*' wildcard is written internally by setAgentMode/applyPreset
// only — never accepted from user input through this function.
const DOMAIN_RE = /^[^*"()]{1,128}$/;

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
 * Set an agent to "Open" (no wildcard deny row — any rule is additive) or
 * "Isolated" (wildcard deny row; only explicit allow rows pass). Preserves
 * any existing non-wildcard rules; for full resets use applyPreset.
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
    const existing = await client.execute({
      sql: `SELECT 1 FROM agent_permissions
              WHERE agent_id = ? AND domain = '*'${uf.clause}`,
      args: [agentId, ...uf.args],
    });
    if (existing.rows.length === 0) {
      await client.execute({
        sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
              VALUES (?, '*', 0, 0, ?)`,
        args: [agentId, userId],
      });
    } else {
      await client.execute({
        sql: `UPDATE agent_permissions SET can_read = 0, can_write = 0
                WHERE agent_id = ? AND domain = '*'${uf.clause}`,
        args: [agentId, ...uf.args],
      });
    }
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
  const uf = userFilter(userId);

  const existing = await client.execute({
    sql: `SELECT 1 FROM agent_permissions
            WHERE agent_id = ? AND domain = ?${uf.clause}`,
    args: [agentId, domain, ...uf.args],
  });
  if (existing.rows.length > 0) {
    await client.execute({
      sql: `UPDATE agent_permissions SET can_read = 0, can_write = 0
              WHERE agent_id = ? AND domain = ?${uf.clause}`,
      args: [agentId, domain, ...uf.args],
    });
  } else {
    await client.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
            VALUES (?, ?, 0, 0, ?)`,
      args: [agentId, domain, userId],
    });
  }

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

  const existing = await client.execute({
    sql: `SELECT 1 FROM agent_permissions
            WHERE agent_id = ? AND domain = ?${uf.clause}`,
    args: [agentId, domain, ...uf.args],
  });
  if (existing.rows.length > 0) {
    await client.execute({
      sql: `UPDATE agent_permissions SET can_read = 1, can_write = 1
              WHERE agent_id = ? AND domain = ?${uf.clause}`,
      args: [agentId, domain, ...uf.args],
    });
  } else {
    await client.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write, user_id)
            VALUES (?, ?, 1, 1, ?)`,
      args: [agentId, domain, userId],
    });
  }

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
 * Atomically replace all permission rows for an agent with an Isolated +
 * allowlist configuration. `domains` is the allowlist (empty for Lockdown).
 * Runs as a single libsql transaction; on failure, prior rules are unchanged.
 */
export async function applyPreset(
  agentId: string,
  preset: Preset,
  domains: string[],
): Promise<void> {
  validateAgentId(agentId);
  if (preset !== "work" && preset !== "personal" && preset !== "lockdown") {
    throw new Error(`Invalid preset: ${preset}`);
  }
  const allowlist = preset === "lockdown" ? [] : domains;
  for (const d of allowlist) validateDomain(d);

  const client = getClient();
  const userId = await getUserId();
  await assertAgentOwnership(client, userId, agentId);
  const uf = userFilter(userId);

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
    // Upsert — unique index enforces (user_id, domain) uniqueness.
    const existing = await client.execute({
      sql: `SELECT 1 FROM sensitive_domains
              WHERE domain = ?${uf.clause}`,
      args: [domain, ...uf.args],
    });
    if (existing.rows.length === 0) {
      await client.execute({
        sql: `INSERT INTO sensitive_domains (user_id, domain, marked_at) VALUES (?, ?, ?)`,
        args: [userId, domain, nowIso()],
      });
    }
  } else {
    await client.execute({
      sql: `DELETE FROM sensitive_domains
              WHERE domain = ?${uf.clause}`,
      args: [domain, ...uf.args],
    });
  }

  revalidatePath("/agents");
  revalidatePath(`/agents/domains/${domain}`);
}

