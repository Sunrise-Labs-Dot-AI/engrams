import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  deriveKeys,
  generateSalt,
  encryptMemory,
  decryptMemory,
} from "../crypto.js";

describe("crypto", () => {
  const testKey = Buffer.alloc(32, "a");

  it("encrypt/decrypt roundtrip", () => {
    const plaintext = "Hello, Engrams!";
    const encrypted = encrypt(plaintext, testKey);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted, testKey)).toBe(plaintext);
  });

  it("different IVs produce different ciphertexts for same plaintext", () => {
    const plaintext = "same text";
    const a = encrypt(plaintext, testKey);
    const b = encrypt(plaintext, testKey);
    expect(a).not.toBe(b);
    expect(decrypt(a, testKey)).toBe(plaintext);
    expect(decrypt(b, testKey)).toBe(plaintext);
  });

  it("wrong key fails to decrypt", () => {
    const encrypted = encrypt("secret", testKey);
    const wrongKey = Buffer.alloc(32, "b");
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("deriveKeys produces consistent output for same passphrase+salt", () => {
    const salt = Buffer.from("test-salt-value-1234567890abcdef");
    const keys1 = deriveKeys("my-passphrase", salt);
    const keys2 = deriveKeys("my-passphrase", salt);
    expect(keys1.encryptionKey.equals(keys2.encryptionKey)).toBe(true);
    expect(keys1.hmacKey.equals(keys2.hmacKey)).toBe(true);
  });

  it("deriveKeys produces different output for different passphrases", () => {
    const salt = Buffer.from("test-salt-value-1234567890abcdef");
    const keys1 = deriveKeys("passphrase-one", salt);
    const keys2 = deriveKeys("passphrase-two", salt);
    expect(keys1.encryptionKey.equals(keys2.encryptionKey)).toBe(false);
  });

  it("encryptMemory/decryptMemory roundtrip with null fields", () => {
    const memory = {
      content: "Sarah Chen is my manager",
      detail: null,
      structured_data: null,
    };
    const encrypted = encryptMemory(memory, testKey);
    expect(encrypted.content).not.toBe(memory.content);
    expect(encrypted.detail).toBeNull();
    expect(encrypted.structured_data).toBeNull();

    const decrypted = decryptMemory(encrypted, testKey);
    expect(decrypted).toEqual(memory);
  });

  it("encryptMemory/decryptMemory roundtrip with all fields", () => {
    const memory = {
      content: "Acme Corp is a SaaS company",
      detail: "B2B focused, 500 employees",
      structured_data: JSON.stringify({ type: "organization", name: "Acme Corp" }),
    };
    const encrypted = encryptMemory(memory, testKey);
    expect(encrypted.content).not.toBe(memory.content);
    expect(encrypted.detail).not.toBe(memory.detail);
    expect(encrypted.structured_data).not.toBe(memory.structured_data);

    const decrypted = decryptMemory(encrypted, testKey);
    expect(decrypted).toEqual(memory);
  });

  it("generateSalt produces 32 bytes", () => {
    const salt = generateSalt();
    expect(salt.length).toBe(32);
    // Two salts should be different
    const salt2 = generateSalt();
    expect(salt.equals(salt2)).toBe(false);
  });
});
