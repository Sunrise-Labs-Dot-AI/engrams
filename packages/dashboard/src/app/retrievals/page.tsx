import Link from "next/link";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { getRetrievals, getRetrievalBudgetHistogram } from "@/lib/db";
import { getUserId } from "@/lib/auth";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface Saturation {
  budgetBound: boolean;
  budgetUsedPct: number;
}

interface ScoreDistribution {
  shape: "flat" | "cliff" | "decaying";
  hasCliff: boolean;
  cliffAt: number | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export default async function RetrievalsPage() {
  const userId = await getUserId();
  const [retrievals, histogram] = await Promise.all([
    getRetrievals({ limit: 100 }, userId),
    getRetrievalBudgetHistogram(userId),
  ]);

  const totalRetrievals = retrievals.length;
  const ratedCount = retrievals.filter((r) => r.rated_at).length;
  const boundCount = retrievals.filter((r) => {
    const s = parseJson<Saturation>(r.saturation_json);
    return s?.budgetBound === true;
  }).length;

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">Retrievals</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Every `memory_context` call logs here. Queries are PII-redacted before rendering.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="p-6">
          <div className="text-xs uppercase text-muted-foreground">Total</div>
          <div className="text-2xl font-semibold mt-1">{totalRetrievals}</div>
        </Card>
        <Card className="p-6">
          <div className="text-xs uppercase text-muted-foreground">Rated</div>
          <div className="text-2xl font-semibold mt-1">
            {ratedCount} / {totalRetrievals}
            <span className="text-sm text-muted-foreground ml-2">
              ({totalRetrievals > 0 ? Math.round((ratedCount / totalRetrievals) * 100) : 0}%)
            </span>
          </div>
        </Card>
        <Card className="p-6">
          <div className="text-xs uppercase text-muted-foreground">Budget-bound</div>
          <div className="text-2xl font-semibold mt-1">
            {boundCount} / {totalRetrievals}
            <span className="text-sm text-muted-foreground ml-2">
              ({totalRetrievals > 0 ? Math.round((boundCount / totalRetrievals) * 100) : 0}%)
            </span>
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Budget histogram</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2">Budget</th>
              <th className="pb-2">Calls</th>
              <th className="pb-2">Budget-bound</th>
              <th className="pb-2">Bound rate</th>
            </tr>
          </thead>
          <tbody>
            {histogram.map((h) => (
              <tr key={h.bucket} className="border-t border-border/30">
                <td className="py-2 font-mono">{h.bucket}</td>
                <td className="py-2">{h.count}</td>
                <td className="py-2">{h.boundCount}</td>
                <td className="py-2">{h.count > 0 ? Math.round((h.boundCount / h.count) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Recent retrievals</h2>
        {retrievals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No retrievals logged yet. Call `memory_context` from an MCP client to populate.</p>
        ) : (
          <div className="space-y-2">
            {retrievals.map((r) => {
              const sat = parseJson<Saturation>(r.saturation_json);
              const dist = parseJson<ScoreDistribution>(r.score_distribution_json);
              const returnedIds = parseJson<string[]>(r.returned_memory_ids_json) ?? [];
              const refIds = parseJson<string[]>(r.referenced_memory_ids_json) ?? [];
              const noiseIds = parseJson<string[]>(r.noise_memory_ids_json) ?? [];
              return (
                <div key={r.id} className="p-3 border-t border-border/30 first:border-t-0">
                  <div className="flex justify-between items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm truncate">
                        {r.query_redacted ?? "(empty query)"}
                      </div>
                      <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                        <span>{formatDate(r.created_at)}</span>
                        <span>{r.agent_id ? `agent: ${r.agent_id}` : "agent: —"}</span>
                        <span>budget: {r.token_budget}</span>
                        <span>used: {r.tokens_used}</span>
                        <span>format: {r.format}</span>
                        <span>returned: {returnedIds.length}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-xs">
                      {r.rated_at ? (
                        <StatusBadge variant="success">
                          rated: {refIds.length} ref / {noiseIds.length} noise
                        </StatusBadge>
                      ) : (
                        <StatusBadge variant="warning">unrated</StatusBadge>
                      )}
                      {sat?.budgetBound && <StatusBadge variant="accent">budget-bound</StatusBadge>}
                      {dist && <StatusBadge variant="neutral">shape: {dist.shape}</StatusBadge>}
                    </div>
                  </div>
                  {r.notes && (
                    <div className="mt-2 text-xs italic text-muted-foreground">
                      notes: {r.notes}
                    </div>
                  )}
                  {returnedIds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 text-xs">
                      {returnedIds.slice(0, 8).map((id) => {
                        const isRef = refIds.includes(id);
                        const isNoise = noiseIds.includes(id);
                        return (
                          <Link
                            key={id}
                            href={`/memory/${id}`}
                            className={
                              isRef
                                ? "px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 font-mono"
                                : isNoise
                                ? "px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 font-mono"
                                : "px-1.5 py-0.5 rounded bg-muted font-mono text-muted-foreground"
                            }
                          >
                            {id.slice(0, 8)}
                          </Link>
                        );
                      })}
                      {returnedIds.length > 8 && (
                        <span className="text-muted-foreground">+{returnedIds.length - 8} more</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
