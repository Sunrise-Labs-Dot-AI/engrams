import { describe, it, expect, beforeAll } from "vitest";
import { extractEntity } from "../entity-extraction.js";
import { createLLMProvider, type LLMConfig } from "../llm.js";
import type { LLMProvider } from "../llm.js";
import { ENTITY_EXTRACTION_CASES } from "./ground-truth.js";

let provider: LLMProvider | null = null;

function getProviderConfig(): LLMConfig | null {
  // Try Anthropic first, then OpenAI
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY };
  }
  return null;
}

beforeAll(() => {
  const config = getProviderConfig();
  if (config) {
    provider = createLLMProvider(config, "extraction");
  }
});

describe("entity extraction evals", () => {
  it("person with role and org (entity-extract-1)", async () => {
    if (!provider) {
      console.warn("[entity-eval] No LLM provider configured, skipping");
      return;
    }

    const testCase = ENTITY_EXTRACTION_CASES[0];
    const result = await extractEntity(provider, testCase.content, testCase.detail);

    console.log(`[entity-eval] ${testCase.name}: type=${result.entity_type} name=${result.entity_name}`);

    expect(result.entity_type).toBe(testCase.expectedType);
    if (testCase.expectedName) {
      expect(result.entity_name?.toLowerCase()).toContain(testCase.expectedName.toLowerCase());
    }
    for (const key of testCase.expectedStructuredKeys) {
      expect(result.structured_data).toHaveProperty(key);
    }
  });

  it("coding preference (entity-extract-2)", async () => {
    if (!provider) return;

    const testCase = ENTITY_EXTRACTION_CASES[1];
    const result = await extractEntity(provider, testCase.content, testCase.detail);

    console.log(`[entity-eval] ${testCase.name}: type=${result.entity_type} name=${result.entity_name}`);

    expect(result.entity_type).toBe(testCase.expectedType);
    for (const key of testCase.expectedStructuredKeys) {
      expect(result.structured_data).toHaveProperty(key);
    }
  });

  it("project with tech stack (entity-extract-3)", async () => {
    if (!provider) return;

    const testCase = ENTITY_EXTRACTION_CASES[2];
    const result = await extractEntity(provider, testCase.content, testCase.detail);

    console.log(`[entity-eval] ${testCase.name}: type=${result.entity_type} name=${result.entity_name}`);

    expect(result.entity_type).toBe(testCase.expectedType);
    if (testCase.expectedName) {
      expect(result.entity_name?.toLowerCase()).toContain(testCase.expectedName.toLowerCase());
    }
    for (const key of testCase.expectedStructuredKeys) {
      expect(result.structured_data).toHaveProperty(key);
    }
  });

  it("ambiguous input does not crash (entity-extract-4)", async () => {
    if (!provider) return;

    const testCase = ENTITY_EXTRACTION_CASES[3];
    const result = await extractEntity(provider, testCase.content, testCase.detail);

    console.log(`[entity-eval] ${testCase.name}: type=${result.entity_type} name=${result.entity_name}`);

    // Should return a valid entity type (event or fact are both acceptable)
    const validTypes = ["person", "organization", "place", "project", "preference", "event", "goal", "fact"];
    expect(validTypes).toContain(result.entity_type);

    // Should not crash — structured_data should be an object
    expect(typeof result.structured_data).toBe("object");
  });
});
