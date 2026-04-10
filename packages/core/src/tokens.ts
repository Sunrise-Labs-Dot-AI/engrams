import { randomBytes, createHash } from "crypto";

const TOKEN_PREFIX = "engrams_";

/** Generate a new API token. Returns { token, hash, prefix }. Token is shown once, hash is stored. */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString("hex");
  const token = TOKEN_PREFIX + raw;
  const hash = hashToken(token);
  const prefix = token.slice(0, TOKEN_PREFIX.length + 8); // "engrams_ab12cd34"
  return { token, hash, prefix };
}

/** Hash a token for storage/lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
