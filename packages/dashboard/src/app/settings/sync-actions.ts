"use server";

import { loadCredentials, saveCredentials, initCredentials, deriveKeys, sync } from "@engrams/core";
import { scryptSync } from "crypto";

export async function setupPassphrase(passphrase: string): Promise<{ success: boolean; error?: string }> {
  try {
    const creds = initCredentials();
    const salt = Buffer.from(creds.salt, "base64");

    // Store a hash of the passphrase for verification (NOT the key)
    const hash = scryptSync(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("base64");
    creds.passphraseHash = hash;
    saveCredentials(creds);

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to set passphrase" };
  }
}

export async function saveTursoConfig(url: string, token: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Test connection
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url, authToken: token });
    await client.execute("SELECT 1");
    client.close();

    const creds = initCredentials();
    creds.tursoUrl = url;
    creds.tursoAuthToken = token;
    saveCredentials(creds);

    return { success: true };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err instanceof Error ? err.message : "Unknown error"}` };
  }
}

export async function triggerSync(passphrase: string): Promise<{ success: boolean; pushed?: number; pulled?: number; error?: string }> {
  const creds = loadCredentials();
  if (!creds?.tursoUrl || !creds?.tursoAuthToken) {
    return { success: false, error: "Cloud sync not configured" };
  }

  const salt = Buffer.from(creds.salt, "base64");
  const keys = deriveKeys(passphrase, salt);

  // Get a writable SQLite handle for sync
  const Database = (await import("better-sqlite3")).default;
  const { resolve } = await import("path");
  const { homedir } = await import("os");
  const sqlite = new Database(resolve(homedir(), ".engrams", "engrams.db"));
  sqlite.pragma("journal_mode = WAL");

  try {
    const result = await sync(sqlite, {
      tursoUrl: creds.tursoUrl,
      tursoAuthToken: creds.tursoAuthToken,
      keys,
    }, creds.deviceId);
    return { success: true, pushed: result.pushed, pulled: result.pulled };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Sync failed" };
  } finally {
    sqlite.close();
  }
}

export async function getSyncStatus(): Promise<{
  hasPassphrase: boolean;
  hasTursoConfig: boolean;
  deviceId: string | null;
}> {
  const creds = loadCredentials();
  return {
    hasPassphrase: !!creds?.passphraseHash,
    hasTursoConfig: !!creds?.tursoUrl && !!creds?.tursoAuthToken,
    deviceId: creds?.deviceId ?? null,
  };
}
