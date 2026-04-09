import clsx from "clsx";
import { type HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover, className, ...props }: CardProps) {
  return (
    <div
      className={clsx(
        "bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl",
        hover && "hover:bg-[var(--color-card-hover)] transition-colors cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}
