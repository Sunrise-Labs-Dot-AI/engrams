import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export interface EncryptionKeys {
  encryptionKey: Buffer;
  hmacKey: Buffer;
}

/**
 * Derive encryption and HMAC keys from a user passphrase + salt.
 * Salt should be generated once per device and stored in credentials.json.
 */
export function deriveKeys(passphrase: string, salt: Buffer): EncryptionKeys {
  const derived = scryptSync(passphrase, salt, KEY_LENGTH * 2, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024, // 256 MB — N=131072,r=8 needs ~128 MB
  });
  return {
    encryptionKey: derived.subarray(0, KEY_LENGTH),
    hmacKey: derived.subarray(KEY_LENGTH),
  };
}

/**
 * Generate a random salt for key derivation. Store this per-device.
 */
export function generateSalt(): Buffer {
  return randomBytes(32);
}

/**
 * Encrypt plaintext. Returns base64(IV + ciphertext + authTag).
 * Each call uses a fresh random IV — safe for multiple encryptions with same key.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

/**
 * Decrypt base64(IV + ciphertext + authTag) back to plaintext.
 */
export function decrypt(encoded: string, key: Buffer): string {
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/**
 * Encrypt a memory record's sensitive fields for cloud sync.
 * Non-sensitive metadata (id, timestamps, domain, entity_type) stays cleartext.
 */
export function encryptMemory(
  memory: { content: string; detail: string | null; structured_data: string | null },
  key: Buffer,
): { content: string; detail: string | null; structured_data: string | null } {
  return {
    content: encrypt(memory.content, key),
    detail: memory.detail ? encrypt(memory.detail, key) : null,
    structured_data: memory.structured_data ? encrypt(memory.structured_data, key) : null,
  };
}

/**
 * Decrypt a memory record's sensitive fields after sync pull.
 */
export function decryptMemory(
  memory: { content: string; detail: string | null; structured_data: string | null },
  key: Buffer,
): { content: string; detail: string | null; structured_data: string | null } {
  return {
    content: decrypt(memory.content, key),
    detail: memory.detail ? decrypt(memory.detail, key) : null,
    structured_data: memory.structured_data ? decrypt(memory.structured_data, key) : null,
  };
}
