"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@libsql/client";
import { resolve } from "path";
import { homedir } from "os";

function getClient() {
  if (process.env.TURSO_DATABASE_URL) {
    return createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return createClient({
    url: "file:" + resolve(homedir(), ".engrams", "engrams.db"),
  });
}

export async function upsertPermission(
  agentId: string,
  domain: string,
  canRead: boolean,
  canWrite: boolean,
) {
  const client = getClient();
  const existing = await client.execute({
    sql: `SELECT 1 FROM agent_permissions WHERE agent_id = ? AND domain = ?`,
    args: [agentId, domain],
  });

  if (existing.rows.length > 0) {
    await client.execute({
      sql: `UPDATE agent_permissions SET can_read = ?, can_write = ? WHERE agent_id = ? AND domain = ?`,
      args: [canRead ? 1 : 0, canWrite ? 1 : 0, agentId, domain],
    });
  } else {
    await client.execute({
      sql: `INSERT INTO agent_permissions (agent_id, domain, can_read, can_write) VALUES (?, ?, ?, ?)`,
      args: [agentId, domain, canRead ? 1 : 0, canWrite ? 1 : 0],
    });
  }

  revalidatePath("/agents");
}

export async function removePermission(agentId: string, domain: string) {
  const client = getClient();
  await client.execute({
    sql: `DELETE FROM agent_permissions WHERE agent_id = ? AND domain = ?`,
    args: [agentId, domain],
  });

  revalidatePath("/agents");
}

export async function togglePermission(
  agentId: string,
  domain: string,
  field: "read" | "write",
  currentValue: boolean,
) {
  const client = getClient();
  const col = field === "read" ? "can_read" : "can_write";
  await client.execute({
    sql: `UPDATE agent_permissions SET ${col} = ? WHERE agent_id = ? AND domain = ?`,
    args: [currentValue ? 0 : 1, agentId, domain],
  });

  revalidatePath("/agents");
}
