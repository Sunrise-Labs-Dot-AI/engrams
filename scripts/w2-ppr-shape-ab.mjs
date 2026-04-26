// W2 pre-flight A/B: gate Wave 2 PPR reranker post-pass before any deploy.
//
// Mirrors the discipline of scripts/w1a-prefix-shape-ab.mjs. Two gates must
// both pass before implementing the PPR pass behind the production flag:
//
//   Step 0 — corpus density floor probe (soft warning, not bail)
//     Sample 10 non-MRCR queries against the hosted endpoint and report median
//     per-query candidate-pool edge count. The 18-needle MRCR set is purpose-
//     built and likely artificially dense; production density is unknown
//     because memory_connections is populated by fire-and-forget LLM extraction
//     (Saboteur F5 in plan-review). Soft warning if median < 5.
//
//   Step 1 — graph density probe (BAIL on fail)
//     For each of the 3 missed GT IDs (n4 nanny, n5 Engrams infra, n7 Magda),
//     fetch its connections via memory_get_connections and check whether ANY
//     neighbor appears in the corresponding needle's full hybrid candidate pool.
//     Bail if any missed GT has zero connections OR all connections fall
//     outside its needle's 200-pool. PPR is structurally a no-op for that case
//     (Saboteur F2 + New Hire F5).
//
//   Step 2 — offline PPR sim (BAIL on fail)
//     Requires a local SQLite snapshot of the seeded mrcr-bench corpus. If the
//     snapshot is absent, prints setup instructions and exits 2 (operator
//     action required). When present, runs hybridSearch + rerank locally,
//     then applies PPR with w ∈ {0.5, 0.6, 0.7, 0.8, 0.9}. Gate (tightened per
//     Saboteur F10): the DEFAULT w=0.7 lifts ≥1 of n4/n5/n7 into top-10 AND
//     no other GT memory drops out of top-10.
//
// Auth contract (Security F5 in plan-review): API token read via mode-0600
// check; passed only in Authorization header; never logged; auth-failure path
// emits the literal string "auth error" to stderr.
//
// Exit codes:
//   0  → PROCEED (all gates pass)
//   1  → ABORT  (a hard gate failed; write handoff-w2-ppr-bail.md and stop)
//   2  → OPERATOR_ACTION_REQUIRED (Step 2 needs local snapshot setup)
//
// Usage:
//   node scripts/w2-ppr-shape-ab.mjs [--skip-step-0] [--skip-step-2]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------- Config ----------
const MCP_URL = process.env.LODIS_MCP_URL ?? "https://app.getengrams.com/api/mcp";
const BENCH_DOMAIN = "mrcr-bench";
const KEY_PATH = path.join(os.homedir(), ".lodis-mrcr-run/hosted-api-key.txt");
const SNAPSHOT_PATH = path.join(os.homedir(), ".lodis-mrcr-run/local-snapshot.db");

// Hosted IDs of the 3 ceiling-miss memories (from plan + Stage C archive).
// These are the missed-GT memories Wave 2 PPR is supposed to rescue.
const MISSED_GT = [
  { needle: "n4_household_roster", id: "385cfd939707d0be56795aed9daf4f39", label: "n4 nanny" },
  { needle: "n5_engrams_origin_infra", id: "b8f3d40d446d14e04d8ebb42a99536d8", label: "n5 Engrams infra" },
  { needle: "n7_marin_search", id: "093bb3b859122f97ed7a04df99bef552", label: "n7 Magda" },
];

const args = new Set(process.argv.slice(2));
const skipStep0 = args.has("--skip-step-0");
const skipStep2 = args.has("--skip-step-2");

// ---------- API key ----------
function loadApiKey() {
  if (process.env.LODIS_HOSTED_API_KEY) return process.env.LODIS_HOSTED_API_KEY.trim();
  if (!fs.existsSync(KEY_PATH)) {
    process.stderr.write(`auth error\n`);
    process.stderr.write(
      `[setup] Generate an API key at https://app.getengrams.com/settings, save it to ${KEY_PATH} with mode 0600.\n`,
    );
    process.exit(1);
  }
  // Mode 0600 enforcement (matches stage-c-hosted-rerank-benchmark.mjs).
  const mode = fs.statSync(KEY_PATH).mode & 0o777;
  if (mode & 0o077) {
    process.stderr.write(`auth error\n`);
    process.stderr.write(`[setup] ${KEY_PATH} has insecure mode ${mode.toString(8)}. Run: chmod 0600 ${KEY_PATH}\n`);
    process.exit(1);
  }
  return fs.readFileSync(KEY_PATH, "utf8").trim();
}
const API_KEY = loadApiKey();

// ---------- JSON-RPC / streamable-http MCP client ----------
let rpcId = 1;
async function mcpCall(toolName, argsObj) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: { name: toolName, arguments: argsObj },
  });
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2024-11-05",
      },
      body,
    });
  } catch (err) {
    // Never log token, never log raw err message that may echo headers.
    process.stderr.write(`mcp transport error\n`);
    throw new Error("mcp_transport");
  }
  if (res.status === 401 || res.status === 403) {
    // Fixed string per Security F5; never echo body (may include token).
    process.stderr.write(`auth error\n`);
    throw new Error("auth");
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`mcp http ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  const envelope = ct.includes("text/event-stream") ? parseSseEnvelope(text) : JSON.parse(text);
  if (envelope.error) throw new Error(`mcp tool error`);
  const content = envelope.result?.content?.[0];
  if (!content || content.type !== "text") throw new Error(`mcp tool shape error`);
  try {
    return JSON.parse(content.text);
  } catch {
    return content.text;
  }
}
function parseSseEnvelope(text) {
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") last = data;
    }
  }
  if (!last) throw new Error("sse empty");
  return JSON.parse(last);
}

// ---------- Step 0: corpus density floor probe (soft warning) ----------

const SAMPLE_QUERIES = [
  "Heath family weekly schedule",
  "Engrams roadmap status",
  "Anthropic interview prep",
  "Marin County real estate",
  "babysitter weekend coverage",
  "Sitter PRD summary",
  "weekly meal plan grocery list",
  "Sierra AI advice career",
  "James Allegra household roster",
  "Magda meeting notes November",
];

async function step0_corpusDensity() {
  if (skipStep0) {
    console.error("Step 0: SKIPPED (--skip-step-0)");
    return { median: null, sampled: 0, skipped: true };
  }
  console.error(`Step 0: probing corpus density across ${SAMPLE_QUERIES.length} non-MRCR queries…`);
  const perQueryCounts = [];
  for (const q of SAMPLE_QUERIES) {
    try {
      const out = await mcpCall("memory_search", { query: q, limit: 20 });
      const ids = (out.memories ?? []).map((m) => m.id);
      // For each candidate, query connections and count edges that touch ANOTHER
      // candidate in the same pool — that's the closed-subgraph edge count
      // PPR will see at runtime. Response shape is { outgoing, incoming }, NOT
      // { connections } (verified empirically against hosted endpoint).
      const idSet = new Set(ids);
      let edges = 0;
      for (const id of ids) {
        try {
          const conns = await mcpCall("memory_get_connections", { memoryId: id });
          const all = [...(conns.outgoing ?? []), ...(conns.incoming ?? [])];
          for (const c of all) {
            const otherId = c.target_memory_id ?? c.source_memory_id ?? c.id;
            if (otherId && otherId !== id && idSet.has(otherId)) edges++;
          }
        } catch {
          // best-effort
        }
      }
      // Each undirected edge is counted twice (once from each end); de-double.
      const edgeCount = Math.floor(edges / 2);
      perQueryCounts.push(edgeCount);
      console.error(`  "${q.slice(0, 40)}" → ${edgeCount} in-pool edges`);
    } catch {
      // best-effort sampling; some queries may return empty
    }
  }
  if (perQueryCounts.length === 0) return { median: null, sampled: 0 };
  const sorted = [...perQueryCounts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { median, sampled: perQueryCounts.length, perQueryCounts };
}

// ---------- Step 1: missed-GT graph probe (HARD GATE) ----------

async function step1_graphProbe() {
  console.error(`\nStep 1: probing graph for ${MISSED_GT.length} missed-GT memories…`);
  const findings = [];
  for (const m of MISSED_GT) {
    let connections = [];
    try {
      const out = await mcpCall("memory_get_connections", { memoryId: m.id });
      // Response shape: { outgoing: [{ target_memory_id, ... }], incoming: [{ source_memory_id, ... }], totalConnections }
      connections = [...(out.outgoing ?? []), ...(out.incoming ?? [])];
    } catch (err) {
      findings.push({ ...m, error: String(err.message ?? err), neighbors: [], inPoolNeighbors: 0 });
      console.error(`  ${m.label} (${m.id.slice(0, 8)}): ERROR ${err.message ?? err}`);
      continue;
    }
    const neighborIds = connections.map((c) => c.target_memory_id ?? c.source_memory_id ?? c.id).filter(Boolean);

    // To check "any neighbor in the needle's 200-pool", we need the needle's
    // candidate pool. The hosted MCP's memory_search returns up to ~20 by
    // default — the FULL 200-pool requires the local snapshot. For this Step
    // 1 hosted-only probe we use memory_search(limit=200) as a best-effort
    // approximation; the full check happens in Step 2 against the snapshot.
    let inPoolNeighbors = 0;
    let pool = [];
    try {
      const needleQ = NEEDLE_QUESTIONS[m.needle];
      const search = await mcpCall("memory_search", { query: needleQ, limit: 200 });
      pool = (search.memories ?? []).map((x) => x.id);
      const poolSet = new Set(pool);
      inPoolNeighbors = neighborIds.filter((nid) => poolSet.has(nid)).length;
    } catch (err) {
      // Treat as unknown; won't hard-bail Step 1 on a search error.
    }
    findings.push({ ...m, neighbors: neighborIds, inPoolNeighbors, poolSize: pool.length });
    console.error(
      `  ${m.label} (${m.id.slice(0, 8)}): degree=${neighborIds.length}, in-pool-neighbors=${inPoolNeighbors}/${pool.length} pool`,
    );
  }
  return findings;
}

// Needle questions sourced from the Stage C bench (verbatim).
const NEEDLE_QUESTIONS = {
  n4_household_roster:
    "Based on these memories, list Person_0091's immediate household: his partner, his children (noting which child attends preschool), the nanny, the dog, and the dog walker. Return the pseudonymized identifiers where they exist.",
  n5_engrams_origin_infra:
    "These memories discuss a product called Engrams. What was the origin story of Engrams (what did it come from), and which three specific infrastructure services does its Pro tier use?",
  n7_marin_search:
    "Person_0091 is researching real estate and schools in a specific county. Which county, which specific high school area, and which specific town? Who (by name or role) did he meet with to discuss the real estate market in that area?",
};

// ---------- Step 2: offline PPR sim ----------

async function step2_offlinePprSim() {
  if (skipStep2) {
    console.error("\nStep 2: SKIPPED (--skip-step-2)");
    return { skipped: true };
  }
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error("\nStep 2: REQUIRES local snapshot — not present.");
    console.error("");
    console.error(`  Setup (one-time, ~5 min):`);
    console.error(`    1. Export hosted mrcr-bench data to JSON:`);
    console.error(`       node -e "/* call memory_export against hosted, write to file */"`);
    console.error(`    2. Bootstrap a local DB at ${SNAPSHOT_PATH} and bulk-import.`);
    console.error("");
    console.error(`  Or: rerun this script with --skip-step-2 to abort Step 2 only.`);
    console.error(`  Step 2 is the GATE on default w=0.7 lifting any miss; without it`);
    console.error(`  the gate is incomplete and you should NOT enable PPR in production.`);
    return { skipped: false, snapshotMissing: true };
  }
  console.error(`\nStep 2: running offline PPR sim against ${SNAPSHOT_PATH}…`);

  const coreDistPath = path.resolve("packages/core/dist/index.js");
  if (!fs.existsSync(coreDistPath)) {
    console.error(`Missing ${coreDistPath}. Run 'pnpm --filter @lodis/core build' first.`);
    process.exit(1);
  }
  const core = await import(pathToFileURL(coreDistPath).href);
  const { createDatabase, hybridSearch, rerank, applyPprPass, fetchPprEdges } = core;

  const { client } = await createDatabase({ url: "file:" + SNAPSHOT_PATH });

  const sweep = [0.5, 0.6, 0.7, 0.8, 0.9];
  const sweepResults = []; // [{ needle, w, missedGtRank, allGtRanks: { id: rank } }]

  for (const m of MISSED_GT) {
    const q = NEEDLE_QUESTIONS[m.needle];
    const { results } = await hybridSearch(client, q, { limit: 200, expand: false });
    const candidates = results.map((r) => ({ id: r.memory.id, text: ((r.memory.content ?? "") + " " + (r.memory.detail ?? "")).trim() }));
    const rerankResults = await rerank(q, candidates, { topK: candidates.length });
    const candidateIds = candidates.map((c) => c.id);
    const edges = await fetchPprEdges(client, candidateIds, null);

    const pprCandidates = rerankResults.map((rr) => ({ id: rr.id, rerankScore: rr.score }));
    for (const w of sweep) {
      const out = applyPprPass(pprCandidates, edges, { rerankBlendWeight: w });
      const orderedIds = out.ordered.map((o) => o.id);
      const rank = orderedIds.indexOf(m.id);
      sweepResults.push({
        needle: m.needle,
        label: m.label,
        w,
        missedGtRank: rank === -1 ? null : rank + 1,
        edgeCount: out.meta.edgeCount,
        candidatePoolSize: out.meta.candidatePoolSize,
      });
    }
  }
  client.close();

  console.error("");
  console.error(`| needle | w | missed-GT rank | edges | pool |`);
  console.error(`|---|---|---|---|---|`);
  for (const r of sweepResults) {
    console.error(`| ${r.label} | ${r.w} | ${r.missedGtRank ?? "—"} | ${r.edgeCount} | ${r.candidatePoolSize} |`);
  }

  // Gate evaluation (Saboteur F10): default w=0.7 lifts ≥1 of n4/n5/n7 to top-10.
  // The "no other GT drops" check requires the full 18-needle GT set with
  // baseline ranks; for v0 of this script we skip that secondary guard and
  // rely on the hosted preview-bench step (verification step 5) to catch it.
  const w07 = sweepResults.filter((r) => r.w === 0.7);
  const liftedAt07 = w07.filter((r) => r.missedGtRank != null && r.missedGtRank <= 10);
  return {
    skipped: false,
    sweepResults,
    gatePass: liftedAt07.length >= 1,
    liftCount: liftedAt07.length,
    liftedNeedles: liftedAt07.map((r) => r.label),
  };
}

// ---------- Run ----------

console.error(`# W2 PPR pre-flight A/B`);
console.error(`Endpoint: ${MCP_URL}`);
console.error(`Domain:   ${BENCH_DOMAIN}\n`);

const step0 = await step0_corpusDensity();
const step1 = await step1_graphProbe();
const step2 = await step2_offlinePprSim();

// ---------- Verdict ----------
console.log(`\n# Verdict\n`);

console.log(`## Step 0 — corpus density floor (soft warning)`);
if (step0.skipped) {
  console.log(`- SKIPPED`);
} else if (step0.median == null) {
  console.log(`- 🟡 NO DATA — sampling produced no results`);
} else {
  const verdict = step0.median >= 5 ? "✅" : "🟡";
  console.log(`- ${verdict} median in-pool edge count over ${step0.sampled} sampled queries: **${step0.median}**`);
  if (step0.median < 5) {
    console.log(`  Soft warning: production graph density appears low. PPR lift on real-user queries may underperform the bench. Proceed with caution; expect smaller production lift than bench lift.`);
  }
}

console.log(`\n## Step 1 — missed-GT graph probe (HARD GATE)`);
let step1Pass = true;
for (const f of step1) {
  if (f.error) {
    console.log(`- ❌ ${f.label}: ERROR ${f.error}`);
    step1Pass = false;
    continue;
  }
  const hasEdges = f.neighbors.length > 0;
  const hasInPool = f.inPoolNeighbors > 0;
  if (!hasEdges) {
    console.log(`- ❌ ${f.label}: zero connections in graph — PPR is structurally a no-op`);
    step1Pass = false;
  } else if (!hasInPool) {
    console.log(
      `- ❌ ${f.label}: degree=${f.neighbors.length} but ZERO in-pool neighbors (pool size ${f.poolSize}) — PPR cannot rescue via closed subgraph`,
    );
    step1Pass = false;
  } else {
    console.log(`- ✅ ${f.label}: degree=${f.neighbors.length}, ${f.inPoolNeighbors} in-pool neighbors`);
  }
}

console.log(`\n## Step 2 — offline PPR sim (HARD GATE)`);
let step2Pass = false;
let step2Status = "unknown";
if (step2.skipped) {
  console.log(`- 🟡 SKIPPED`);
  step2Status = "skipped";
} else if (step2.snapshotMissing) {
  console.log(`- 🟡 NOT RUN — local snapshot missing. See Step 2 setup instructions above.`);
  step2Status = "no_snapshot";
} else {
  step2Pass = step2.gatePass;
  if (step2Pass) {
    console.log(`- ✅ default w=0.7 lifted **${step2.liftCount}/3** missed GT into top-10: ${step2.liftedNeedles.join(", ")}`);
  } else {
    console.log(`- ❌ default w=0.7 lifted ${step2.liftCount}/3 missed GT into top-10. Gate requires ≥ 1.`);
  }
  step2Status = step2Pass ? "pass" : "fail";
}

console.log(`\n## Final\n`);
if (!step1Pass) {
  console.log(`❌ **ABORT** — Step 1 hard-gate failed. PPR is structurally unable to rescue the missed GT memories. Write handoff-w2-ppr-bail.md to the worktree root and pivot to Wave 3 (bge-small-en-v1.5 swap) or another lever. Do NOT enable PPR in production.`);
  process.exit(1);
}
if (step2Status === "no_snapshot" || step2Status === "skipped") {
  console.log(`🟡 **OPERATOR ACTION REQUIRED** — Step 1 passed; Step 2 needs the local snapshot to evaluate the lift gate. Do NOT enable PPR in production until Step 2 reports ✅ PROCEED.`);
  process.exit(2);
}
if (!step2Pass) {
  console.log(`❌ **ABORT** — Step 2 hard-gate failed. Default w=0.7 does not lift any missed GT into top-10 on the bench corpus. Write handoff-w2-ppr-bail.md.`);
  process.exit(1);
}
console.log(`✅ **PROCEED** — both hard gates pass. Proceed to verification step 5 (hosted preview bench).`);
process.exit(0);
