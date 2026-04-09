"use client";

import { type ReactNode, useEffect, useRef } from "react";
import clsx from "clsx";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

export function Modal({ open, onClose, title, size = "md", children }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className={clsx(
        "bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl shadow-xl w-full mx-4 p-6 max-h-[85vh] overflow-y-auto",
        size === "sm" && "max-w-sm",
        size === "md" && "max-w-md",
        size === "lg" && "max-w-xl",
      )}>
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  );
}
