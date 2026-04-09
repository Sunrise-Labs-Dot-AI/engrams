import { describe, it, expect } from "vitest";
import { detectSensitiveData, redactSensitiveData } from "../pii.js";

describe("detectSensitiveData", () => {
  it("detects email addresses", () => {
    const results = detectSensitiveData("Contact me at alice@example.com for details");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("email");
    expect(results[0].match).toBe("alice@example.com");
  });

  it("detects US phone numbers", () => {
    const results = detectSensitiveData("Call me at (555) 123-4567");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("phone");
    expect(results[0].match).toContain("555");
  });

  it("detects phone numbers with country code", () => {
    const results = detectSensitiveData("Reach me at +1-555-123-4567");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("phone");
  });

  it("detects SSN patterns", () => {
    const results = detectSensitiveData("My SSN is 123-45-6789");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("ssn");
    expect(results[0].match).toBe("123-45-6789");
  });

  it("detects credit card numbers with spaces", () => {
    const results = detectSensitiveData("Card: 4111 1111 1111 1111");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("credit_card");
  });

  it("detects credit card numbers with dashes", () => {
    const results = detectSensitiveData("Card: 4111-1111-1111-1111");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("credit_card");
  });

  it("detects sk- API keys", () => {
    const results = detectSensitiveData("Key: sk-abcdefghij1234567890xy");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects ghp_ GitHub tokens", () => {
    const results = detectSensitiveData("Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects Slack tokens (xoxb-)", () => {
    const results = detectSensitiveData("Bot token: xoxb-123456789-abcdefgh");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects AWS access key IDs (AKIA)", () => {
    const results = detectSensitiveData("AWS key: AKIAIOSFODNN7EXAMPLE");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects Stripe keys (rk_live_, pk_test_)", () => {
    const results = detectSensitiveData("Stripe: rk_live_abc123def456");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");

    const results2 = detectSensitiveData("Stripe: pk_test_xyz789");
    expect(results2).toHaveLength(1);
    expect(results2[0].type).toBe("api_key");
  });

  it("detects IPv4 addresses", () => {
    const results = detectSensitiveData("Server at 192.168.1.100");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("ip_address");
    expect(results[0].match).toBe("192.168.1.100");
  });

  it("rejects invalid IPv4 octets", () => {
    const results = detectSensitiveData("Not an IP: 999.999.999.999");
    expect(results).toHaveLength(0);
  });

  it("returns empty for clean text", () => {
    const results = detectSensitiveData("User prefers dark mode and uses vim");
    expect(results).toHaveLength(0);
  });

  it("detects multiple types in same text", () => {
    const results = detectSensitiveData(
      "Email alice@example.com, SSN 123-45-6789, IP 10.0.0.1",
    );
    expect(results.length).toBeGreaterThanOrEqual(3);
    const types = results.map((r) => r.type);
    expect(types).toContain("email");
    expect(types).toContain("ssn");
    expect(types).toContain("ip_address");
  });

  it("includes correct start/end positions", () => {
    const text = "SSN: 123-45-6789";
    const results = detectSensitiveData(text);
    expect(results).toHaveLength(1);
    expect(text.slice(results[0].start, results[0].end)).toBe("123-45-6789");
  });

  it("does not match short digit sequences as phone numbers", () => {
    const results = detectSensitiveData("I have 42 cats and 7 dogs");
    expect(results).toHaveLength(0);
  });
});

describe("redactSensitiveData", () => {
  it("replaces email with [EMAIL]", () => {
    const { redacted } = redactSensitiveData("Contact alice@example.com please");
    expect(redacted).toBe("Contact [EMAIL] please");
  });

  it("replaces SSN with [SSN]", () => {
    const { redacted } = redactSensitiveData("SSN is 123-45-6789");
    expect(redacted).toBe("SSN is [SSN]");
  });

  it("replaces API keys with [API_KEY]", () => {
    const { redacted } = redactSensitiveData("Key: sk-abcdefghij1234567890xy");
    expect(redacted).toBe("Key: [API_KEY]");
  });

  it("replaces IP addresses with [IP_ADDRESS]", () => {
    const { redacted } = redactSensitiveData("Host: 192.168.1.1");
    expect(redacted).toBe("Host: [IP_ADDRESS]");
  });

  it("replaces multiple PII types", () => {
    const { redacted, matches } = redactSensitiveData(
      "Email alice@example.com, IP 10.0.0.1",
    );
    expect(redacted).toContain("[EMAIL]");
    expect(redacted).toContain("[IP_ADDRESS]");
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("returns unchanged text when no PII found", () => {
    const { redacted, matches } = redactSensitiveData("Nothing sensitive here");
    expect(redacted).toBe("Nothing sensitive here");
    expect(matches).toHaveLength(0);
  });
});
