import type { Client } from "@libsql/client";
import type { LLMProvider } from "./llm.js";
import { parseLLMJson } from "./llm-utils.js";

export interface EntityProfile {
  id: string;
  entityName: string;
  entityType: string;
  summary: string;
  memoryIds: string[];
  tokenCount: number;
  generatedAt: string;
  userId: string | null;
}

/**
 * Generate or retrieve an entity profile — a pre-computed summary of all
 * memories related to a specific entity.
 */
export async function getOrGenerateProfile(
  client: Client,
  provider: LLMProvider | null,
  entityName: string,
  entityType?: string,
  options?: { regenerate?: boolean; userId?: string },
): Promise<EntityProfile | null> {
  const userId = options?.userId ?? null;

  // Check for existing profile
  if (!options?.regenerate) {
    const existing = await getProfile(client, entityName, entityType, userId);
    if (existing) return existing;
  }

  // Need LLM to generate
  if (!provider) return null;

  // Fetch all memories for this entity
  const typeFilter = entityType
    ? `AND entity_type = ?`
    : ``;
  const args: (string | null)[] = [entityName];
  if (entityType) args.push(entityType);

  const userFilter = userId ? `AND user_id = ?` : `AND (user_id IS NULL OR user_id = '')`;
  if (userId) args.push(userId);

  const result = await client.execute({
    sql: `SELECT id, content, detail, entity_type, confidence, permanence, learned_at
          FROM memories
          WHERE entity_name = ? ${typeFilter} ${userFilter}
            AND deleted_at IS NULL
          ORDER BY confidence DESC, learned_at DESC
          LIMIT 50`,
    args,
  });

  if (result.rows.length === 0) return null;

  const memories = result.rows;
  const memoryIds = memories.map((m) => m.id as string);
  const resolvedEntityType = entityType ?? (memories[0].entity_type as string);

  // Build context for LLM
  const memoryList = memories
    .map((m) => {
      const parts = [`- ${m.content}`];
      if (m.detail) parts[0] += ` — ${(m.detail as string).slice(0, 200)}`;
      if (m.permanence === "canonical") parts[0] += " [canonical]";
      return parts[0];
    })
    .join("\n");

  const prompt = `Summarize everything known about "${entityName}" (${resolvedEntityType}) based on these memories. Write a concise profile paragraph (2-4 sentences) that captures the most important facts, relationships, and context. Focus on actionable information an AI assistant would need.

Memories:
${memoryList}

Respond with JSON only:
{
  "summary": "the profile paragraph"
}`;

  const text = await provider.complete(prompt, { maxTokens: 512, json: true });
  const parsed = parseLLMJson<{ summary: string }>(text);

  const profile: EntityProfile = {
    id: generateHexId(),
    entityName,
    entityType: resolvedEntityType,
    summary: parsed.summary,
    memoryIds,
    tokenCount: Math.ceil(parsed.summary.length / 4),
    generatedAt: new Date().toISOString(),
    userId,
  };

  // Upsert into memory_summaries
  await client.execute({
    sql: `INSERT INTO memory_summaries (id, entity_name, entity_type, summary, memory_ids, token_count, generated_at, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_name, entity_type, user_id) DO UPDATE SET
            summary = excluded.summary,
            memory_ids = excluded.memory_ids,
            token_count = excluded.token_count,
            generated_at = excluded.generated_at`,
    args: [
      profile.id,
      profile.entityName,
      profile.entityType,
      profile.summary,
      JSON.stringify(profile.memoryIds),
      profile.tokenCount,
      profile.generatedAt,
      profile.userId,
    ],
  });

  return profile;
}

/**
 * Retrieve an existing entity profile without generating a new one.
 */
export async function getProfile(
  client: Client,
  entityName: string,
  entityType?: string,
  userId?: string | null,
): Promise<EntityProfile | null> {
  const conditions = [`entity_name = ?`];
  const args: (string | null)[] = [entityName];

  if (entityType) {
    conditions.push(`entity_type = ?`);
    args.push(entityType);
  }

  if (userId) {
    conditions.push(`user_id = ?`);
    args.push(userId);
  } else {
    conditions.push(`(user_id IS NULL OR user_id = '')`);
  }

  const result = await client.execute({
    sql: `SELECT * FROM memory_summaries WHERE ${conditions.join(" AND ")} LIMIT 1`,
    args,
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id as string,
    entityName: row.entity_name as string,
    entityType: row.entity_type as string,
    summary: row.summary as string,
    memoryIds: JSON.parse(row.memory_ids as string) as string[],
    tokenCount: row.token_count as number,
    generatedAt: row.generated_at as string,
    userId: (row.user_id as string | null) ?? null,
  };
}

/**
 * Check if a profile is stale (>24h old) and should be regenerated.
 */
export function isProfileStale(profile: EntityProfile, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  const generatedAt = new Date(profile.generatedAt).getTime();
  return Date.now() - generatedAt > maxAgeMs;
}

/**
 * List all entity profiles, optionally filtered by type.
 */
export async function listProfiles(
  client: Client,
  options?: { entityType?: string; userId?: string | null },
): Promise<EntityProfile[]> {
  const conditions: string[] = [];
  const args: (string | null)[] = [];

  if (options?.entityType) {
    conditions.push(`entity_type = ?`);
    args.push(options.entityType);
  }

  if (options?.userId) {
    conditions.push(`user_id = ?`);
    args.push(options.userId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await client.execute({
    sql: `SELECT * FROM memory_summaries ${where} ORDER BY entity_name ASC`,
    args,
  });

  return result.rows.map((row) => ({
    id: row.id as string,
    entityName: row.entity_name as string,
    entityType: row.entity_type as string,
    summary: row.summary as string,
    memoryIds: JSON.parse(row.memory_ids as string) as string[],
    tokenCount: row.token_count as number,
    generatedAt: row.generated_at as string,
    userId: (row.user_id as string | null) ?? null,
  }));
}

function generateHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
