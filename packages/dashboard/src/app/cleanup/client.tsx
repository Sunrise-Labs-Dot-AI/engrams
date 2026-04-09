"use client";

import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { StatusBadge } from "../../components/ui/status-badge";
import {
  analyzeCleanupAction,
  applyMergeSuggestionAction,
  applySplitSuggestionAction,
  deleteMemoryAction,
  confirmMemoryAction,
  correctMemoryAction,
} from "../../lib/actions";
import type { CleanupSuggestion } from "../../lib/cleanup";
import { Search, CheckCircle, Loader2 } from "lucide-react";

const TYPE_LABELS: Record<CleanupSuggestion["type"], string> = {
  merge: "Duplicate",
  split: "Needs Split",
  contradiction: "Conflict",
  stale: "Stale",
  update: "May Be Outdated",
};

const TYPE_BADGE_VARIANT: Record<
  CleanupSuggestion["type"],
  "accent" | "warning" | "danger" | "neutral" | "success"
> = {
  merge: "accent",
  split: "warning",
  contradiction: "danger",
  stale: "neutral",
  update: "success",
};

export function CleanupClient() {
  const [suggestions, setSuggestions] = useState<CleanupSuggestion[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);

  async function handleAnalyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await analyzeCleanupAction();
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuggestions(result.suggestions);
      }
      setHasAnalyzed(true);
    } catch {
      setError("Analysis failed unexpectedly");
    } finally {
      setAnalyzing(false);
    }
  }

  function dismiss(index: number) {
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  }

  async function applyMerge(suggestion: CleanupSuggestion, index: number) {
    if (!suggestion.keepId) return;
    setApplyingIndex(index);
    try {
      const deleteIds = suggestion.memoryIds.filter(
        (id) => id !== suggestion.keepId,
      );
      await applyMergeSuggestionAction(suggestion.keepId, deleteIds);
      dismiss(index);
    } finally {
      setApplyingIndex(null);
    }
  }

  async function applySplit(suggestion: CleanupSuggestion, index: number) {
    if (!suggestion.parts || suggestion.parts.length < 2) return;
    setApplyingIndex(index);
    try {
      await applySplitSuggestionAction(suggestion.memoryIds[0], suggestion.parts);
      dismiss(index);
    } finally {
      setApplyingIndex(null);
    }
  }

  async function applyStaleConfirm(suggestion: CleanupSuggestion, index: number) {
    setApplyingIndex(index);
    try {
      await confirmMemoryAction(suggestion.memoryIds[0]);
      dismiss(index);
    } finally {
      setApplyingIndex(null);
    }
  }

  async function applyStaleDelete(suggestion: CleanupSuggestion, index: number) {
    setApplyingIndex(index);
    try {
      await deleteMemoryAction(suggestion.memoryIds[0]);
      dismiss(index);
    } finally {
      setApplyingIndex(null);
    }
  }

  async function applyContradictionKeep(
    suggestion: CleanupSuggestion,
    keepId: string,
    index: number,
  ) {
    setApplyingIndex(index);
    try {
      const deleteIds = suggestion.memoryIds.filter((id) => id !== keepId);
      for (const id of deleteIds) {
        await deleteMemoryAction(id);
      }
      dismiss(index);
    } finally {
      setApplyingIndex(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--color-text)" }}
          >
            Cleanup
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Scan your memories for duplicates, conflicts, and stale entries
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasAnalyzed && suggestions.length > 0 && (
            <span
              className="text-sm font-medium"
              style={{ color: "var(--color-text-muted)" }}
            >
              {suggestions.length} suggestion{suggestions.length !== 1 && "s"}
            </span>
          )}
          <Button onClick={handleAnalyze} disabled={analyzing}>
            {analyzing ? (
              <>
                <Loader2 size={16} className="animate-spin mr-1.5" />
                Analyzing...
              </>
            ) : (
              <>
                <Search size={16} className="mr-1.5" />
                Analyze
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="p-4 mb-4 border-[var(--color-danger)]">
          <p style={{ color: "var(--color-danger)" }}>{error}</p>
        </Card>
      )}

      {hasAnalyzed && !analyzing && suggestions.length === 0 && !error && (
        <Card className="p-8 text-center">
          <CheckCircle
            size={40}
            className="mx-auto mb-3"
            style={{ color: "var(--color-success)" }}
          />
          <p
            className="text-lg font-medium"
            style={{ color: "var(--color-text)" }}
          >
            No suggestions
          </p>
          <p
            className="text-sm mt-1"
            style={{ color: "var(--color-text-muted)" }}
          >
            Your memory store looks clean!
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-4">
        {suggestions.map((suggestion, index) => (
          <SuggestionCard
            key={`${suggestion.type}-${suggestion.memoryIds.join("-")}-${index}`}
            suggestion={suggestion}
            index={index}
            applying={applyingIndex === index}
            onDismiss={() => dismiss(index)}
            onApplyMerge={() => applyMerge(suggestion, index)}
            onApplySplit={() => applySplit(suggestion, index)}
            onStaleConfirm={() => applyStaleConfirm(suggestion, index)}
            onStaleDelete={() => applyStaleDelete(suggestion, index)}
            onContradictionKeep={(keepId: string) =>
              applyContradictionKeep(suggestion, keepId, index)
            }
          />
        ))}
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  index,
  applying,
  onDismiss,
  onApplyMerge,
  onApplySplit,
  onStaleConfirm,
  onStaleDelete,
  onContradictionKeep,
}: {
  suggestion: CleanupSuggestion;
  index: number;
  applying: boolean;
  onDismiss: () => void;
  onApplyMerge: () => void;
  onApplySplit: () => void;
  onStaleConfirm: () => void;
  onStaleDelete: () => void;
  onContradictionKeep: (keepId: string) => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusBadge variant={TYPE_BADGE_VARIANT[suggestion.type]}>
            {TYPE_LABELS[suggestion.type]}
          </StatusBadge>
          <span
            className="text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {suggestion.description}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={applying}
        >
          Dismiss
        </Button>
      </div>

      {suggestion.type === "merge" && (
        <MergeDetail
          suggestion={suggestion}
          applying={applying}
          onApply={onApplyMerge}
        />
      )}
      {suggestion.type === "split" && (
        <SplitDetail
          suggestion={suggestion}
          applying={applying}
          onApply={onApplySplit}
        />
      )}
      {suggestion.type === "contradiction" && (
        <ContradictionDetail
          suggestion={suggestion}
          applying={applying}
          onKeep={onContradictionKeep}
        />
      )}
      {suggestion.type === "stale" && (
        <StaleDetail
          suggestion={suggestion}
          applying={applying}
          onConfirm={onStaleConfirm}
          onDelete={onStaleDelete}
        />
      )}
      {suggestion.type === "update" && (
        <UpdateDetail
          suggestion={suggestion}
          applying={applying}
          onDelete={onStaleDelete}
        />
      )}
    </Card>
  );
}

function MemoryPreview({ id, label }: { id: string; label?: string }) {
  return (
    <div
      className="text-xs font-mono px-2 py-1 rounded"
      style={{
        background: "var(--color-bg-soft)",
        color: "var(--color-text-secondary)",
      }}
    >
      {label && (
        <span style={{ color: "var(--color-text-muted)" }}>{label}: </span>
      )}
      <span className="break-all">{id.slice(0, 12)}...</span>
    </div>
  );
}

function MergeDetail({
  suggestion,
  applying,
  onApply,
}: {
  suggestion: CleanupSuggestion;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {suggestion.memoryIds.map((id) => (
          <div
            key={id}
            className="text-xs px-2 py-1 rounded border"
            style={{
              background:
                id === suggestion.keepId
                  ? "var(--color-success-bg)"
                  : "var(--color-bg-soft)",
              borderColor:
                id === suggestion.keepId
                  ? "var(--color-success)"
                  : "var(--color-border)",
              color:
                id === suggestion.keepId
                  ? "var(--color-success)"
                  : "var(--color-text-secondary)",
            }}
          >
            {id.slice(0, 12)}...
            {id === suggestion.keepId && " (keep)"}
          </div>
        ))}
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--color-text-muted)" }}>
        {suggestion.proposedAction}
      </p>
      <Button size="sm" onClick={onApply} disabled={applying}>
        {applying ? "Merging..." : "Merge"}
      </Button>
    </div>
  );
}

function SplitDetail({
  suggestion,
  applying,
  onApply,
}: {
  suggestion: CleanupSuggestion;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <div>
      {suggestion.parts && (
        <div className="flex flex-col gap-2 mb-3">
          {suggestion.parts.map((part, i) => (
            <div
              key={i}
              className="text-sm p-2 rounded border"
              style={{
                background: "var(--color-bg-soft)",
                borderColor: "var(--color-border)",
                color: "var(--color-text)",
              }}
            >
              <span className="font-medium">Part {i + 1}:</span> {part.content}
              {part.detail && (
                <p
                  className="text-xs mt-0.5"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {part.detail}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <Button size="sm" onClick={onApply} disabled={applying}>
        {applying ? "Splitting..." : "Split"}
      </Button>
    </div>
  );
}

function ContradictionDetail({
  suggestion,
  applying,
  onKeep,
}: {
  suggestion: CleanupSuggestion;
  applying: boolean;
  onKeep: (keepId: string) => void;
}) {
  return (
    <div>
      {suggestion.conflicts && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {suggestion.conflicts.map((conflict) => (
            <div
              key={conflict.id}
              className="p-3 rounded border"
              style={{
                background: "var(--color-bg-soft)",
                borderColor: "var(--color-border)",
              }}
            >
              <p className="text-sm mb-2" style={{ color: "var(--color-text)" }}>
                {conflict.statement}
              </p>
              <div className="flex items-center justify-between">
                <span
                  className="text-xs font-mono"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {conflict.id.slice(0, 12)}...
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onKeep(conflict.id)}
                  disabled={applying}
                >
                  Keep this
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StaleDetail({
  suggestion,
  applying,
  onConfirm,
  onDelete,
}: {
  suggestion: CleanupSuggestion;
  applying: boolean;
  onConfirm: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <MemoryPreview id={suggestion.memoryIds[0]} />
      <Button size="sm" variant="secondary" onClick={onConfirm} disabled={applying}>
        {applying ? "..." : "Confirm"}
      </Button>
      <Button size="sm" variant="danger" onClick={onDelete} disabled={applying}>
        {applying ? "..." : "Delete"}
      </Button>
    </div>
  );
}

function UpdateDetail({
  suggestion,
  applying,
  onDelete,
}: {
  suggestion: CleanupSuggestion;
  applying: boolean;
  onDelete: () => void;
}) {
  return (
    <div>
      <p className="text-xs mb-3" style={{ color: "var(--color-text-muted)" }}>
        {suggestion.proposedAction}
      </p>
      <div className="flex items-center gap-2">
        <MemoryPreview id={suggestion.memoryIds[0]} />
        <Button size="sm" variant="danger" onClick={onDelete} disabled={applying}>
          {applying ? "..." : "Delete"}
        </Button>
      </div>
    </div>
  );
}
