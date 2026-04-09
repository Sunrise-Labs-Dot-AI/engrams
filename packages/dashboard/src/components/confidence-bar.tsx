import { formatConfidence, confidenceColor } from "@/lib/utils";

interface ConfidenceBarProps {
  confidence: number;
  showLabel?: boolean;
}

export function ConfidenceBar({
  confidence,
  showLabel = true,
}: ConfidenceBarProps) {
  const color = confidenceColor(confidence);
  const pct = Math.round(confidence * 100);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[var(--color-bg-soft)] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      {showLabel && (
        <span className="text-xs font-medium tabular-nums" style={{ color }}>
          {formatConfidence(confidence)}
        </span>
      )}
    </div>
  );
}
