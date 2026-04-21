// Stage A diagnostic for the MRCR recall gap.
//
// Question: for each of the 8 MRCR needles, does Lodis's hybridSearch at
// limit=200 contain the ground-truth memory IDs? The V3 benchmark ran at
// limit=50 and surfaced 3/18 GT IDs. We want to know whether raising the
// candidate-set limit (and later adding a reranker) can recover the others.
//
// Approach:
//   1. Create a fresh temp SQLite DB via @lodis/core.
//   2. Load the 1990 pseudonymized benchmark memories from
//      simulation/data/memories.json (preserving their IDs).
//   3. Generate embeddings for each memory content.
//   4. Rebuild FTS5.
//   5. For each of the 8 needle queries, call hybridSearch(limit=200).
//   6. Report GT ranks per needle.
//
// Read-only against the benchmark artifact. Temp DB is deleted after the run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// Load compiled @lodis/core from local dist (no install required).
const coreDistPath = path.resolve(
  "packages/core/dist/index.js",
);
if (!fs.existsSync(coreDistPath)) {
  console.error(`Missing ${coreDistPath}. Run 'pnpm --filter @lodis/core build' first.`);
  process.exit(1);
}
const core = await import(pathToFileURL(coreDistPath).href);
const { createDatabase, hybridSearch, generateEmbeddings } = core;

const ART = "/Users/jamesheath/Documents/Claude/Projects/Anthropic Take Home Demo/simulation";
const memoriesPath = path.join(ART, "data/memories.json");
const needlesPath = path.join(ART, "needles-public.json");

// Ground-truth IDs per needle — extracted from results-retrieval-v3.json
// (evidence_expected, consistent across trials).
const GROUND_TRUTH = {
  n1_anthropic_interview: [
    "795dcb6fadb2057e2df80f2629ac904e",
    "b472213204e816ff2caa03142d938383",
    "7ed5c23f62254b0b2ff72a816e7dc97b",
  ],
  n2_sierra_advice: [
    "2c6c5a4f70a55e80884212089eb858b4",
    "538b0c561f0677dbb25cdbfa3262343f",
  ],
  n3_socal_trip: ["22fd2f66658a4a4b87fbd9368b6a16e5"],
  n4_household_roster: [
    "1c9d9f37252c5db321914edfdd6abd3d",
    "04fb9f878ac51a325e2dab20667d5a20",
    "462face88053814e141a3cca127f6c08",
    "78d7f4bd29fe29cbfa6cd605b18494dc",
  ],
  n5_engrams_origin_infra: [
    "f8095ca4f3aae04bec1de7c2c726bfdc",
    "b26ddf766fb9e003443939ee534fb0fd",
  ],
  n6_two_products: [
    "841bc943d5dadc6df3e5d4d5a6844cd3",
    "f8095ca4f3aae04bec1de7c2c726bfdc",
  ],
  n7_marin_search: [
    "f540bdf4fcd598feb5da7ba5d5e210d6",
    "5f8d5f07ff42ebe7fde7a2636e975af1",
    "9c8f6f75668af90d6db928b71f7fce5d",
  ],
  n8_anthropic_motivation: ["aea340d98be282e13263dcb800d3ebf6"],
};

const needleSpec = JSON.parse(fs.readFileSync(needlesPath, "utf8"));
const NEEDLES = needleSpec.needles;

const memories = JSON.parse(fs.readFileSync(memoriesPath, "utf8"));
console.error(`Loaded ${memories.length} memories and ${NEEDLES.length} needles.`);

// --- Create temp DB ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lodis-stage-a-"));
const dbPath = path.join(tmpDir, "stage-a.db");
const url = "file:" + dbPath;
console.error(`Temp DB: ${dbPath}`);

const { client, vecAvailable } = await createDatabase({ url });
console.error(`vecAvailable=${vecAvailable}`);

// --- Insert memories with preserved IDs ---
console.error("Generating embeddings for 1990 memories (this takes ~90s)...");
const embedTexts = memories.map((m) => m.content + (m.detail ? " " + m.detail : ""));
const t0 = Date.now();
const embeddings = await generateEmbeddings(embedTexts);
console.error(`Embeddings generated in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

console.error("Inserting memories into temp DB...");
const BATCH = 200;
for (let i = 0; i < memories.length; i += BATCH) {
  const chunk = memories.slice(i, i + BATCH);
  const stmts = [];
  for (let j = 0; j < chunk.length; j++) {
    const m = chunk[j];
    const emb = embeddings[i + j];
    stmts.push({
      sql: `INSERT INTO memories (
        id, content, detail, domain,
        source_agent_id, source_agent_name,
        source_type, source_description,
        confidence, learned_at, has_pii_flag,
        entity_type, entity_name, structured_data,
        permanence, expires_at, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        m.id,
        m.content,
        m.detail ?? null,
        m.domain ?? "general",
        "stage-a",
        "stage-a-diagnostic",
        m.source_type ?? "observed",
        m.source_description ?? null,
        m.confidence ?? 0.75,
        m.learned_at ?? new Date().toISOString(),
        0,
        m.entity_type ?? null,
        m.entity_name ?? null,
        m.structured_data ? (typeof m.structured_data === "string" ? m.structured_data : JSON.stringify(m.structured_data)) : null,
        m.permanence ?? "active",
        null,
        null,
      ],
    });
    if (emb) {
      stmts.push({
        sql: `UPDATE memories SET embedding = vector(?) WHERE id = ?`,
        args: [JSON.stringify(Array.from(emb)), m.id],
      });
    }
  }
  await client.batch(stmts, "write");
}
console.error(`Inserted ${memories.length} memories.`);

// Rebuild FTS to pick up the new rows.
await client.execute({ sql: `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`, args: [] });
console.error("FTS rebuilt.");

// Bump last_modified so result cache considers data stale.
await client.execute({
  sql: `INSERT OR REPLACE INTO lodis_meta (key, value) VALUES ('last_modified', ?)`,
  args: [new Date().toISOString()],
});

// --- Run needles ---
console.error("\nRunning needle queries at limit=200...\n");

const results = [];
for (const needle of NEEDLES) {
  const gt = GROUND_TRUTH[needle.id] ?? [];
  const start = Date.now();
  // expand=false so the raw candidate set is reported (no graph-expanded hops).
  const { results: rows } = await hybridSearch(client, needle.question, {
    limit: 200,
    expand: false,
  });
  const elapsed = Date.now() - start;

  const returnedIds = rows.map((r) => r.memory.id);
  const gtRanks = gt.map((id) => {
    const idx = returnedIds.indexOf(id);
    return { id, rank: idx === -1 ? null : idx + 1 };
  });

  const hitsTop50 = gtRanks.filter((g) => g.rank !== null && g.rank <= 50).length;
  const hitsTop100 = gtRanks.filter((g) => g.rank !== null && g.rank <= 100).length;
  const hitsTop200 = gtRanks.filter((g) => g.rank !== null && g.rank <= 200).length;

  results.push({
    needle: needle.id,
    gtCount: gt.length,
    returnedCount: returnedIds.length,
    elapsedMs: elapsed,
    gtRanks,
    hitsTop50,
    hitsTop100,
    hitsTop200,
  });
}

// --- Report ---
console.log("# Stage A Diagnostic — GT Rank at limit=200\n");
console.log("| Needle | GT count | Hits top-50 | Hits top-100 | Hits top-200 | GT ranks |");
console.log("|---|---|---|---|---|---|");
for (const r of results) {
  const ranksStr = r.gtRanks
    .map((g) => (g.rank === null ? "—" : g.rank))
    .join(", ");
  console.log(
    `| ${r.needle} | ${r.gtCount} | ${r.hitsTop50} | ${r.hitsTop100} | ${r.hitsTop200} | ${ranksStr} |`,
  );
}

// Totals
const tot = (k) => results.reduce((a, r) => a + r[k], 0);
const totalGt = tot("gtCount");
console.log(`\n**Totals:** ${totalGt} GT IDs across 8 needles · top-50 ${tot("hitsTop50")}/${totalGt} (${((tot("hitsTop50")/totalGt)*100).toFixed(1)}%) · top-100 ${tot("hitsTop100")}/${totalGt} (${((tot("hitsTop100")/totalGt)*100).toFixed(1)}%) · top-200 ${tot("hitsTop200")}/${totalGt} (${((tot("hitsTop200")/totalGt)*100).toFixed(1)}%)`);

// Verdict
console.log("\n## Verdict\n");
const gainRerankable = tot("hitsTop200") - tot("hitsTop50");
if (gainRerankable >= 5) {
  console.log(`✅ **Reranker-recoverable:** ${gainRerankable} additional GT IDs appear at ranks 51–200. A cross-encoder rerank over top-200 will surface them.`);
} else {
  console.log(`⚠️ **Not reranker-only recoverable:** only +${gainRerankable} GT IDs between top-50 and top-200. Representation/query-rewriting fix needed upstream.`);
}

// Cleanup temp DB
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}
process.exit(0);
