import { describe, it, expect } from "vitest";
import {
  applyPprPass,
  resolvePprConfig,
  PPR_DEFAULTS,
  PPR_MAX_POOL_SIZE,
  type PprCandidate,
  type PprEdge,
} from "../ppr-rerank.js";

// ---------- Helpers ----------

function cands(scores: number[]): PprCandidate[] {
  return scores.map((s, i) => ({ id: `m${i}`, rerankScore: s }));
}

function edge(s: string, t: string, rel = "related"): PprEdge {
  return { source: s, target: t, relationship: rel };
}

function rankOf(ordered: { id: string }[], id: string): number {
  return ordered.findIndex((o) => o.id === id);
}

describe("applyPprPass — fast paths", () => {
  it("returns input as no-op for empty pool", () => {
    const out = applyPprPass([], []);
    expect(out.ordered).toEqual([]);
    expect(out.meta.candidatePoolSize).toBe(0);
    expect(out.meta.edgeCount).toBe(0);
    expect(out.meta.iterations).toBe(0);
  });

  it("returns input as no-op for empty edges (preserves rerank order)", () => {
    const c = cands([1.0, 0.5, 0.2]);
    const out = applyPprPass(c, []);
    // No edges → adjacency is all-dangling → all columns become p →
    // PPR converges to p in 1 iteration → blend with z(rerank) preserves order
    expect(out.ordered.map((o) => o.id)).toEqual(["m0", "m1", "m2"]);
    expect(out.meta.edgeCount).toBe(0);
  });

  it("skips PPR entirely if pool exceeds PPR_MAX_POOL_SIZE", () => {
    const c = cands(Array.from({ length: PPR_MAX_POOL_SIZE + 1 }, (_, i) => 1 - i * 0.001));
    const out = applyPprPass(c, [edge("m0", "m1")]);
    // No-op: returns input order, no rerank/ppr split
    expect(out.ordered.map((o) => o.id).slice(0, 3)).toEqual(["m0", "m1", "m2"]);
    expect(out.meta.iterations).toBe(0);
    expect(out.meta.edgeCount).toBe(0);
  });
});

describe("applyPprPass — invariants", () => {
  it("output length equals input length", () => {
    const c = cands([0.9, 0.4, 0.7, 0.1, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m2"), edge("m1", "m4")]);
    expect(out.ordered.length).toBe(c.length);
  });

  it("preserves the same set of IDs (no duplicates, no drops)", () => {
    const c = cands([0.9, 0.4, 0.7, 0.1, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m2"), edge("m1", "m4")]);
    const inIds = new Set(c.map((x) => x.id));
    const outIds = new Set(out.ordered.map((x) => x.id));
    expect(outIds).toEqual(inIds);
  });

  it("is deterministic across runs (stable secondary sort by id)", () => {
    // All-equal rerank scores + edges → blended scores will tie; stable
    // tie-break must produce same ordering across runs.
    const c = cands([0.5, 0.5, 0.5, 0.5]);
    const edges = [edge("m0", "m1"), edge("m2", "m3")];
    const a = applyPprPass(c, edges);
    const b = applyPprPass(c, edges);
    expect(a.ordered.map((o) => o.id)).toEqual(b.ordered.map((o) => o.id));
  });
});

describe("applyPprPass — graph propagation", () => {
  it("promotes a low-rerank candidate that is graph-connected to a high-rerank winner", () => {
    // m0 = high rerank, m1 = low rerank but connected to m0; m2/m3 = low rerank, isolated.
    // Expectation: m1 should rank ABOVE m2 and m3 because PPR carries mass from m0.
    const c = cands([5.0, -2.0, -2.0, -2.0]);
    const edges = [edge("m0", "m1")];
    const out = applyPprPass(c, edges);
    expect(rankOf(out.ordered, "m0")).toBe(0); // m0 stays on top
    expect(rankOf(out.ordered, "m1")).toBeLessThan(rankOf(out.ordered, "m2"));
    expect(rankOf(out.ordered, "m1")).toBeLessThan(rankOf(out.ordered, "m3"));
    expect(out.meta.edgeCount).toBe(1);
  });

  it("isolated low-rerank candidate stays low even with high-rerank neighbors elsewhere", () => {
    // m0 high, m1 medium connected to m0; m2 low, isolated; m3 low, isolated.
    // m1 should beat m2 and m3 (graph lift); m2/m3 ordering reflects rerank only.
    const c = cands([5.0, 0.0, -1.0, -2.0]);
    const out = applyPprPass(c, [edge("m0", "m1")]);
    expect(rankOf(out.ordered, "m1")).toBeLessThan(rankOf(out.ordered, "m2"));
    expect(rankOf(out.ordered, "m2")).toBeLessThan(rankOf(out.ordered, "m3"));
  });

  it("undirected edge is symmetric: high-rerank node also boosts a low-rerank neighbor regardless of edge direction", () => {
    // Same shape as above but edge written target→source. Result must be identical.
    const c = cands([5.0, -2.0, -2.0, -2.0]);
    const aOut = applyPprPass(c, [edge("m0", "m1")]);
    const bOut = applyPprPass(c, [edge("m1", "m0")]);
    expect(aOut.ordered.map((o) => o.id)).toEqual(bOut.ordered.map((o) => o.id));
  });
});

describe("applyPprPass — blend weight extremes", () => {
  it("rerankBlendWeight = 1 collapses to (z-score of) rerank order", () => {
    // Pure rerank: ordering matches descending rerank scores.
    const c = cands([0.1, 0.9, 0.5, 0.3]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m2", "m3")], { rerankBlendWeight: 1 });
    expect(out.ordered.map((o) => o.id)).toEqual(["m1", "m2", "m3", "m0"]);
  });

  it("rerankBlendWeight = 0 collapses to pure PPR", () => {
    // All four candidates are in the graph (no danglers — danglers retain their
    // personalization mass by the standard PPR convention, which would skew the
    // pure-PPR ordering toward high-rerank danglers, defeating the test).
    // m1 is a hub connected to m0, m2, m3; m0/m2/m3 are leaves connected only
    // to m1. m0 has the highest rerank; m1 has the lowest.
    // Pure-PPR (blend=0): m1 should outrank m0 because ALL of m0/m2/m3 push
    // mass into the m1 hub on each iteration.
    const c = cands([5.0, 0.0, 1.0, 1.0]);
    const edges = [edge("m0", "m1"), edge("m1", "m2"), edge("m1", "m3")];
    const out = applyPprPass(c, edges, { rerankBlendWeight: 0 });
    expect(rankOf(out.ordered, "m1")).toBeLessThan(rankOf(out.ordered, "m0"));
  });
});

describe("applyPprPass — convergence + telemetry", () => {
  it("converges within maxIterations on a well-connected (clique-like) graph", () => {
    // Path graphs converge slowly because the second-largest eigenvalue of A_col
    // is cos(π/N) ≈ 0.7 — combined with damping 0.85, contraction is ~0.6 per
    // iter, needing ~18 iters to hit residual 1e-4 from a fresh start.
    // Well-connected small graphs (cliques, near-cliques) converge much faster.
    // 4-clique: contraction is ~0.85 · 1/3 ≈ 0.28, hits 1e-4 in <10 iters.
    const c = cands([1.0, 0.5, 0.2, 0.1]);
    const edges = [
      edge("m0", "m1"), edge("m0", "m2"), edge("m0", "m3"),
      edge("m1", "m2"), edge("m1", "m3"), edge("m2", "m3"),
    ];
    const out = applyPprPass(c, edges);
    expect(out.meta.converged).toBe(true);
    expect(out.meta.iterations).toBeLessThanOrEqual(PPR_DEFAULTS.maxIterations);
    expect(out.meta.iterations).toBeGreaterThan(0);
  });

  it("reports converged=false on a slow-mixing path graph at default maxIter (advisory telemetry)", () => {
    // Documents the converse of the clique test: a path graph + default
    // maxIter=10 is INSUFFICIENT to reach residual 1e-4. This is expected
    // and surfaced via pprPass.converged=false telemetry — not a bug.
    // A follow-up may raise maxIter if production telemetry shows non-trivial
    // converged=false rate (see plan §Risks #2).
    const c = cands([1.0, 0.5, 0.2, 0.1]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m1", "m2"), edge("m2", "m3")]);
    expect(out.meta.iterations).toBe(PPR_DEFAULTS.maxIterations);
    expect(out.meta.converged).toBe(false);
    // Despite not converging to 1e-4, the ordering is still well-defined and finite.
    for (const o of out.ordered) expect(Number.isFinite(o.finalScore)).toBe(true);
  });

  it("respects maxIterations override and reports converged=false on hard cap", () => {
    const c = cands([1.0, 0.5, 0.2, 0.1]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m1", "m2"), edge("m2", "m3")], {
      maxIterations: 1,
      residualEps: 0, // never satisfies → hits cap
    });
    expect(out.meta.iterations).toBe(1);
    expect(out.meta.converged).toBe(false);
  });

  it("reports candidatePoolSize + edgeCount", () => {
    const c = cands([1.0, 0.5, 0.2]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m1", "m2")]);
    expect(out.meta.candidatePoolSize).toBe(3);
    expect(out.meta.edgeCount).toBe(2);
  });

  it("dedupes parallel edges (m0↔m1 inserted twice = one edge)", () => {
    const c = cands([1.0, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m1", "m0")]);
    expect(out.meta.edgeCount).toBe(1);
  });

  it("drops edges referencing IDs outside the candidate pool (closed subgraph)", () => {
    const c = cands([1.0, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m1"), edge("m0", "out-of-pool"), edge("foo", "bar")]);
    expect(out.meta.edgeCount).toBe(1);
  });

  it("skips self-loops", () => {
    const c = cands([1.0, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m0"), edge("m0", "m1")]);
    expect(out.meta.edgeCount).toBe(1);
  });
});

describe("applyPprPass — NaN and degenerate inputs", () => {
  it("throws on NaN rerank score (caller catches → ppr_nan_guard)", () => {
    const c = [
      { id: "m0", rerankScore: 1.0 },
      { id: "m1", rerankScore: NaN },
    ];
    expect(() => applyPprPass(c, [])).toThrow(/non-finite/);
  });

  it("throws on Infinity rerank score", () => {
    const c = [
      { id: "m0", rerankScore: 1.0 },
      { id: "m1", rerankScore: Infinity },
    ];
    expect(() => applyPprPass(c, [])).toThrow(/non-finite/);
  });

  it("survives uniform rerank scores (NaN-guard: sum-shifted = 0 → uniform p)", () => {
    const c = cands([0.5, 0.5, 0.5, 0.5]);
    const out = applyPprPass(c, [edge("m0", "m1")]);
    // Should not throw, should produce a valid ordering of all 4.
    expect(out.ordered.length).toBe(4);
    for (const o of out.ordered) {
      expect(Number.isFinite(o.finalScore)).toBe(true);
    }
  });

  it("survives single-candidate pool (degenerate but legal)", () => {
    const c = cands([0.7]);
    const out = applyPprPass(c, []);
    expect(out.ordered.length).toBe(1);
    expect(out.ordered[0].id).toBe("m0");
    expect(Number.isFinite(out.ordered[0].finalScore)).toBe(true);
  });

  it("clamps out-of-range teleportProbability and rerankBlendWeight to [0,1]", () => {
    const c = cands([1.0, 0.5, 0.2]);
    // -5, 99 should be clamped without throwing.
    const out = applyPprPass(c, [edge("m0", "m1")], {
      teleportProbability: -5,
      rerankBlendWeight: 99,
    });
    expect(out.ordered.length).toBe(3);
    for (const o of out.ordered) expect(Number.isFinite(o.finalScore)).toBe(true);
  });
});

describe("resolvePprConfig", () => {
  it("defaults to disabled when no env flags set", () => {
    const c = resolvePprConfig({});
    expect(c.enabled).toBe(false);
    expect(c.timeoutMs).toBe(200);
  });

  it("LODIS_PPR_RERANK_ENABLED=1 enables", () => {
    const c = resolvePprConfig({ LODIS_PPR_RERANK_ENABLED: "1" });
    expect(c.enabled).toBe(true);
  });

  it("LODIS_PPR_RERANK_DISABLED=1 wins over ENABLED (kill switch)", () => {
    const c = resolvePprConfig({
      LODIS_PPR_RERANK_DISABLED: "1",
      LODIS_PPR_RERANK_ENABLED: "1",
    });
    expect(c.enabled).toBe(false);
  });

  it("LODIS_PPR_TIMEOUT_MS overrides default", () => {
    const c = resolvePprConfig({ LODIS_PPR_TIMEOUT_MS: "500" });
    expect(c.timeoutMs).toBe(500);
  });

  it("falls back to default timeout on garbage input", () => {
    expect(resolvePprConfig({ LODIS_PPR_TIMEOUT_MS: "garbage" }).timeoutMs).toBe(200);
    expect(resolvePprConfig({ LODIS_PPR_TIMEOUT_MS: "-1" }).timeoutMs).toBe(200);
    expect(resolvePprConfig({ LODIS_PPR_TIMEOUT_MS: "" }).timeoutMs).toBe(200);
  });
});
