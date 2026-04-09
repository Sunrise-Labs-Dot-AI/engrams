"use client";

import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

interface DomainFilterProps {
  domains: { domain: string; count: number }[];
}

export function DomainFilter({ domains }: DomainFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeDomain = searchParams.get("domain");
  const [, startTransition] = useTransition();

  function selectDomain(domain: string | null) {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (domain) {
        params.set("domain", domain);
      } else {
        params.delete("domain");
      }
      router.push(`/?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => selectDomain(null)}
        className={clsx(
          "px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer",
          !activeDomain
            ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]"
            : "bg-[var(--color-bg-soft)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
        )}
      >
        All
      </button>
      {domains.map(({ domain, count }) => (
        <button
          key={domain}
          onClick={() => selectDomain(domain)}
          className={clsx(
            "px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer",
            activeDomain === domain
              ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]"
              : "bg-[var(--color-bg-soft)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
          )}
        >
          {domain}
          <span className="ml-1 opacity-60">{count}</span>
        </button>
      ))}
    </div>
  );
}
