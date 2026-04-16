"use server";

import { createClient } from "@libsql/client";
import { createHash, randomBytes } from "crypto";
import { resolve } from "path";
import { homedir } from "os";

const TOKEN_PREFIX = "lodis_";

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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateId(): string {
  return randomBytes(16).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

export interface TokenInfo {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastIp: string | null;
  createdAt: string;
}

export async function createApiToken(
  userId: string,
  name: string,
  scopes: string = "read,write",
  expiresInDays?: number,
): Promise<{ token: string; id: string } | { error: string }> {
  try {
    const client = getClient();
    const raw = randomBytes(32).toString("hex");
    const token = TOKEN_PREFIX + raw;
    const hash = hashToken(token);
    const prefix = token.slice(0, TOKEN_PREFIX.length + 8);
    const id = generateId();
    const timestamp = now();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;

    await client.execute({
      sql: `INSERT INTO api_tokens (id, user_id, token_hash, token_prefix, name, scopes, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, userId, hash, prefix, name, scopes, expiresAt, timestamp],
    });

    return { token, id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to create token" };
  }
}

export async function listApiTokens(userId: string): Promise<TokenInfo[]> {
  const client = getClient();
  const result = await client.execute({
    sql: `SELECT id, name, token_prefix, scopes, expires_at, last_used_at, last_ip, created_at
          FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
    args: [userId],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    tokenPrefix: r.token_prefix as string,
    scopes: r.scopes as string,
    expiresAt: r.expires_at as string | null,
    lastUsedAt: r.last_used_at as string | null,
    lastIp: r.last_ip as string | null,
    createdAt: r.created_at as string,
  }));
}

export async function revokeApiToken(
  userId: string,
  tokenId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = getClient();
    const result = await client.execute({
      sql: `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      args: [now(), tokenId, userId],
    });
    if (result.rowsAffected === 0) {
      return { success: false, error: "Token not found or already revoked" };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to revoke token" };
  }
}

/**
 * Validate a Bearer token from an MCP request.
 * Returns the user_id and scopes if valid, null otherwise.
 * Also updates last_used_at and last_ip.
 */
export async function validateApiToken(
  token: string,
  ip?: string,
): Promise<{ userId: string; scopes: string[] } | null> {
  const client = getClient();
  const hash = hashToken(token);
  const result = await client.execute({
    sql: `SELECT user_id, scopes, expires_at FROM api_tokens
          WHERE token_hash = ? AND revoked_at IS NULL`,
    args: [hash],
  });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const expiresAt = row.expires_at as string | null;
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return null; // expired
  }

  // Update last used (fire-and-forget)
  client
    .execute({
      sql: `UPDATE api_tokens SET last_used_at = ?, last_ip = ? WHERE token_hash = ?`,
      args: [now(), ip ?? null, hash],
    })
    .catch(() => {}); // non-critical

  return {
    userId: row.user_id as string,
    scopes: (row.scopes as string).split(","),
  };
}
