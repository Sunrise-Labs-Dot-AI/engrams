"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircle,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldAlert,
  Star,
  Clock,
  Archive,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfidenceBar } from "@/components/confidence-bar";
import { confirmMemoryAction, deleteMemoryAction, pinMemoryAction, archiveMemoryAction } from "@/lib/actions";
import { formatDate, sourceTypeLabel } from "@/lib/utils";
import type { MemoryRow } from "@/lib/db";

interface MemoryCardProps {
  memory: MemoryRow;
}

export function MemoryCard({ memory: m }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleAction(action: () => Promise<unknown>) {
    setLoading(true);
    try {
      await action();
      router.refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed">{m.content}</p>
          <div className="flex items-center gap-2 mt-2">
            <StatusBadge variant="accent">{m.domain}</StatusBadge>
            <StatusBadge variant="neutral">
              {sourceTypeLabel(m.source_type)}
            </StatusBadge>
            {m.permanence === "canonical" && (
              <StatusBadge variant="accent">
                <Star size={10} className="mr-0.5 inline fill-current" />
                Canonical
              </StatusBadge>
            )}
            {m.permanence === "ephemeral" && (
              <StatusBadge variant="warning">
                <Clock size={10} className="mr-0.5 inline" />
                Ephemeral
              </StatusBadge>
            )}
            {m.permanence === "archived" && (
              <StatusBadge variant="neutral">
                <Archive size={10} className="mr-0.5 inline" />
                Archived
              </StatusBadge>
            )}
            {m.entity_type && (
              <StatusBadge variant="neutral">
                {m.entity_type}{m.entity_name ? `: ${m.entity_name}` : ""}
              </StatusBadge>
            )}
            {!!m.has_pii_flag && (
              <StatusBadge variant="warning">
                <ShieldAlert size={12} className="mr-0.5 inline" />
                PII
              </StatusBadge>
            )}
            <span className="text-xs text-[var(--color-text-muted)]">
              {m.source_agent_name}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {formatDate(m.learned_at)}
            </span>
          </div>
          <div className="mt-2 max-w-48">
            <ConfidenceBar confidence={m.confidence} />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={`/memory/${m.id}`}
            className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <ExternalLink size={14} />
          </Link>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border-light)]">
          {m.detail && (
            <div className="text-xs text-[var(--color-text-secondary)] mb-3 prose-engrams">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.detail}</ReactMarkdown>
            </div>
          )}
          {m.source_description && (
            <p className="text-xs text-[var(--color-text-muted)] mb-3 italic">
              Source: {m.source_description}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => handleAction(() => confirmMemoryAction(m.id))}
            >
              <CheckCircle size={14} className="mr-1" />
              Confirm
            </Button>
            <Link href={`/memory/${m.id}`}>
              <Button
                variant="ghost"
                size="sm"
              >
                <Pencil size={14} className="mr-1" />
                Correct
              </Button>
            </Link>
            {m.permanence !== "canonical" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => handleAction(() => pinMemoryAction(m.id))}
              >
                <Star size={14} className="mr-1" />
                Pin
              </Button>
            )}
            {m.permanence !== "archived" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => handleAction(() => archiveMemoryAction(m.id))}
              >
                <Archive size={14} className="mr-1" />
                Archive
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => handleAction(() => deleteMemoryAction(m.id))}
              className="text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
            >
              <Trash2 size={14} className="mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
