"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Moon, Sun, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { clearAllMemoriesAction } from "@/lib/actions";

export function SettingsActions() {
  const router = useRouter();
  const [dark, setDark] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  function toggleDark() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  }

  async function handleExport() {
    const res = await fetch("/api/export");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `engrams-export-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleClear() {
    setLoading(true);
    try {
      await clearAllMemoriesAction();
      setClearModalOpen(false);
      router.refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Appearance</h3>
        <Button variant="secondary" size="sm" onClick={toggleDark}>
          {dark ? <Sun size={14} className="mr-1" /> : <Moon size={14} className="mr-1" />}
          {dark ? "Light Mode" : "Dark Mode"}
        </Button>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Export</h3>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          Download all your memories as a JSON file.
        </p>
        <Button variant="secondary" size="sm" onClick={handleExport}>
          <Download size={14} className="mr-1" />
          Export Memories
        </Button>
      </Card>

      <Card className="p-4 border-[var(--color-danger)]">
        <h3 className="text-sm font-semibold text-[var(--color-danger)] mb-3">
          Danger Zone
        </h3>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          Permanently delete all memories. This cannot be undone.
        </p>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setClearModalOpen(true)}
        >
          <Trash2 size={14} className="mr-1" />
          Clear All Memories
        </Button>
      </Card>

      <Modal
        open={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        title="Clear All Memories"
      >
        <p className="text-sm text-[var(--color-text-secondary)]">
          This will permanently delete all memories. This action cannot be
          undone. Are you absolutely sure?
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClearModalOpen(false)}
          >
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={loading} onClick={handleClear}>
            Yes, Delete Everything
          </Button>
        </div>
      </Modal>
    </>
  );
}
