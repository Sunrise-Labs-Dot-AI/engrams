import clsx from "clsx";

type BadgeVariant = "success" | "warning" | "danger" | "neutral" | "accent";

const variantStyles: Record<BadgeVariant, string> = {
  success:
    "bg-[var(--color-success-bg)] text-[var(--color-success)]",
  warning:
    "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
  danger:
    "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
  neutral:
    "bg-[var(--color-bg-soft)] text-[var(--color-text-secondary)]",
  accent:
    "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]",
};

interface StatusBadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export function StatusBadge({
  variant = "neutral",
  children,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full",
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
