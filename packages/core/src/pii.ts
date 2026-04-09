export interface PiiMatch {
  type: string;
  match: string;
  start: number;
  end: number;
}

const PII_PATTERNS: { type: string; pattern: RegExp; redactToken: string }[] = [
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    redactToken: "[SSN]",
  },
  {
    type: "credit_card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    redactToken: "[CREDIT_CARD]",
  },
  {
    type: "api_key",
    pattern: /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+|AKIA[A-Z0-9]{16}|rk_live_[a-zA-Z0-9]+|rk_test_[a-zA-Z0-9]+|pk_live_[a-zA-Z0-9]+|pk_test_[a-zA-Z0-9]+)\b/g,
    redactToken: "[API_KEY]",
  },
  {
    type: "email",
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    redactToken: "[EMAIL]",
  },
  {
    type: "phone",
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    redactToken: "[PHONE]",
  },
  {
    type: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    redactToken: "[IP_ADDRESS]",
  },
];

// Credit card numbers need extra validation — must have at least 13 actual digits
function isValidCreditCard(match: string): boolean {
  const digits = match.replace(/[^0-9]/g, "");
  return digits.length >= 13 && digits.length <= 19;
}

// SSN-like patterns that overlap with credit cards need disambiguation
function isLikelySSN(match: string): boolean {
  return /^\d{3}-\d{2}-\d{4}$/.test(match);
}

export function detectSensitiveData(text: string): PiiMatch[] {
  const results: PiiMatch[] = [];
  const coveredRanges: { start: number; end: number }[] = [];

  for (const { type, pattern } of PII_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;

      // Skip if this range is already covered by a higher-priority match
      const overlaps = coveredRanges.some(
        (r) => start < r.end && end > r.start,
      );
      if (overlaps) continue;

      // Type-specific validation
      if (type === "credit_card" && !isValidCreditCard(m[0])) continue;
      if (type === "phone") {
        // Avoid matching plain numbers that are too short
        const digits = m[0].replace(/[^0-9]/g, "");
        if (digits.length < 10) continue;
      }

      results.push({ type, match: m[0], start, end });
      coveredRanges.push({ start, end });
    }
  }

  // Sort by position
  results.sort((a, b) => a.start - b.start);
  return results;
}

export function redactSensitiveData(text: string): { redacted: string; matches: PiiMatch[] } {
  const matches = detectSensitiveData(text);
  if (matches.length === 0) return { redacted: text, matches };

  const tokenMap = new Map(PII_PATTERNS.map((p) => [p.type, p.redactToken]));

  // Replace from end to start to preserve positions
  let redacted = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const token = tokenMap.get(m.type) ?? `[${m.type.toUpperCase()}]`;
    redacted = redacted.slice(0, m.start) + token + redacted.slice(m.end);
  }

  return { redacted, matches };
}
