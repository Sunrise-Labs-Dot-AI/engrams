import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hybridSearch } from "../search.js";
import { openRealDb } from "./helpers.js";
import { precisionAtK, mrr, recallAtK, formatMetrics } from "./metrics.js";
import {
  SEARCH_EXACT_CASES,
  SEARCH_SEMANTIC_CASES,
  SEARCH_DOMAIN_FILTER_CASES,
  SEARCH_ENTITY_FILTER_CASES,
  SEARCH_EDGE_CASES,
  type SearchGroundTruth,
} from "./ground-truth.js";
import type { Client } from "@libsql/client";

let client: Client;
let cleanup: () => void;
let available = false;

beforeAll(async () => {
  const result = await openRealDb();
  if (!result) return;
  client = result.client;
  cleanup = result.cleanup;
  available = true;
});

afterAll(() => {
  if (cleanup) cleanup();
});

async function runSearchEval(testCase: SearchGroundTruth) {
  const { results } = await hybridSearch(client, testCase.query, {
    domain: testCase.filters?.domain,
    entityType: testCase.filters?.entityType,
    minConfidence: testCase.filters?.minConfidence,
    limit: 10,
    expand: false,
  });

  const retrievedIds = results.map((r) => r.id);

  const p5 = precisionAtK(retrievedIds, testCase.expectedIds, 5);
  const r5 = recallAtK(retrievedIds, testCase.expectedIds, 5);
  const mrrScore = mrr(retrievedIds, testCase.expectedIds);

  console.log(formatMetrics(testCase.name, { "p@5": p5, "r@5": r5, mrr: mrrScore }));

  return { retrievedIds, p5, r5, mrrScore };
}

describe("search evals", () => {
  describe("exact match queries", () => {
    for (const testCase of SEARCH_EXACT_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return; // skip if no real DB

        const { p5, mrrScore } = await runSearchEval(testCase);

        if (testCase.minPrecisionAt5 !== undefined) {
          expect(p5, `precision@5 should be >= ${testCase.minPrecisionAt5}`).toBeGreaterThanOrEqual(
            testCase.minPrecisionAt5,
          );
        }
        if (testCase.minMRR !== undefined) {
          expect(mrrScore, `MRR should be >= ${testCase.minMRR}`).toBeGreaterThanOrEqual(testCase.minMRR);
        }
      });
    }
  });

  describe("semantic match queries", () => {
    for (const testCase of SEARCH_SEMANTIC_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const { p5, mrrScore } = await runSearchEval(testCase);

        if (testCase.minPrecisionAt5 !== undefined) {
          expect(p5, `precision@5 should be >= ${testCase.minPrecisionAt5}`).toBeGreaterThanOrEqual(
            testCase.minPrecisionAt5,
          );
        }
        if (testCase.minMRR !== undefined) {
          expect(mrrScore, `MRR should be >= ${testCase.minMRR}`).toBeGreaterThanOrEqual(testCase.minMRR);
        }
      });
    }
  });

  describe("domain filter queries", () => {
    for (const testCase of SEARCH_DOMAIN_FILTER_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const { results } = await hybridSearch(client, testCase.query, {
          domain: testCase.filters?.domain,
          limit: 10,
          expand: false,
        });

        const retrievedIds = results.map((r) => r.id);

        // When a domain filter is applied, ALL results must be from that domain
        if (testCase.filters?.domain) {
          for (const result of results) {
            expect(result.memory.domain).toBe(testCase.filters.domain);
          }
        }

        const { p5, mrrScore } = await runSearchEval(testCase);

        if (testCase.minPrecisionAt5 !== undefined) {
          expect(p5).toBeGreaterThanOrEqual(testCase.minPrecisionAt5);
        }
        if (testCase.minMRR !== undefined) {
          expect(mrrScore).toBeGreaterThanOrEqual(testCase.minMRR);
        }
      });
    }
  });

  describe("entity type filter queries", () => {
    for (const testCase of SEARCH_ENTITY_FILTER_CASES) {
      it(`${testCase.name} (${testCase.id})`, async () => {
        if (!available) return;

        const { results } = await hybridSearch(client, testCase.query, {
          entityType: testCase.filters?.entityType,
          limit: 10,
          expand: false,
        });

        // All results must match the entity type filter
        if (testCase.filters?.entityType) {
          for (const result of results) {
            expect(result.memory.entity_type).toBe(testCase.filters.entityType);
          }
        }

        const retrievedIds = results.map((r) => r.id);
        const p5 = precisionAtK(retrievedIds, testCase.expectedIds, 5);
        const mrrScore = mrr(retrievedIds, testCase.expectedIds);

        console.log(formatMetrics(testCase.name, { "p@5": p5, mrr: mrrScore }));

        if (testCase.minPrecisionAt5 !== undefined) {
          expect(p5).toBeGreaterThanOrEqual(testCase.minPrecisionAt5);
        }
        if (testCase.minMRR !== undefined) {
          expect(mrrScore).toBeGreaterThanOrEqual(testCase.minMRR);
        }
      });
    }
  });

  describe("edge cases", () => {
    it("unrelated query returns low-relevance results (edge-1)", async () => {
      if (!available) return;

      const { results } = await hybridSearch(client, "quantum physics recipes for sourdough bread", {
        limit: 5,
        expand: false,
      });

      // Either no results, or all scores are very low
      for (const r of results) {
        // RRF scores for irrelevant content should be low
        expect(r.score).toBeLessThan(0.05);
      }
    });

    it("single word query returns relevant results (edge-2)", async () => {
      if (!available) return;

      const testCase = SEARCH_EDGE_CASES[1];
      const { p5, mrrScore } = await runSearchEval(testCase);

      if (testCase.minPrecisionAt5 !== undefined) {
        expect(p5).toBeGreaterThanOrEqual(testCase.minPrecisionAt5);
      }
    });

    it("high confidence filter excludes low-confidence results (edge-3)", async () => {
      if (!available) return;

      const { results } = await hybridSearch(client, "James", {
        minConfidence: 0.95,
        limit: 10,
        expand: false,
      });

      for (const r of results) {
        expect(r.memory.confidence as number).toBeGreaterThanOrEqual(0.95);
      }
    });
  });
});
