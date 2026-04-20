export const dynamic = "force-dynamic";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { CleanupClient } from "./client";
import { getUserId } from "@/lib/auth";
import {
  getRetrievedButNeverUseful,
  getProvenUsefulUnpinned,
  getInconsistentSignal,
  type UtilityCleanupCandidate,
} from "@/lib/db";

function UtilitySection({
  title,
  description,
  hint,
  rows,
  emptyText,
}: {
  title: string;
  description: string;
  hint: string;
  rows: UtilityCleanupCandidate[];
  emptyText: string;
}) {
  return (
    <Card className="p-6">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        <p className="text-xs text-muted-foreground mt-0.5 italic">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/memory/${row.id}`}
              className="block p-3 rounded border border-border/30 hover:border-border hover:bg-[var(--surface-hover)] transition"
            >
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm line-clamp-2">{row.content}</div>
                  <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                    <span>used: {row.used_count}</span>
                    <span>referenced: {row.referenced_count}</span>
                    <span>noise: {row.noise_count}</span>
                    {row.permanence && <span>{row.permanence}</span>}
                  </div>
                </div>
                <StatusBadge variant="neutral">
                  {row.id.slice(0, 8)}
                </StatusBadge>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

export default async function CleanupPage() {
  const userId = await getUserId();
  const [junk, proven, inconsistent] = await Promise.all([
    getRetrievedButNeverUseful(userId),
    getProvenUsefulUnpinned(userId),
    getInconsistentSignal(userId),
  ]);

  return (
    <div className="space-y-6">
      <CleanupClient />

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Retrieval signal</h2>
        <p className="text-xs text-muted-foreground -mt-2">
          Derived from `memory_rate_context` feedback. Populates as agents rate retrievals.
        </p>

        <UtilitySection
          title="Returned but never useful"
          description="Retrieved ≥5 times, never cited, flagged as noise ≥2 times."
          hint="Consider archiving — agents keep pulling these but never use them."
          rows={junk}
          emptyText="No junk candidates yet."
        />

        <UtilitySection
          title="Proven useful — consider pinning"
          description="Cited ≥3 times and not canonical."
          hint="These memories earn their keep. Pin them so they survive decay."
          rows={proven}
          emptyText="No pin candidates yet."
        />

        <UtilitySection
          title="Inconsistent signal — investigate"
          description="Cited at least once AND flagged as noise at least once."
          hint="Either the memory is context-dependent or one of the rating calls was noise itself."
          rows={inconsistent}
          emptyText="No inconsistent-signal memories."
        />
      </div>
    </div>
  );
}
