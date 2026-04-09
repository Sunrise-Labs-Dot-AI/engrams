"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, AlertTriangle, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { confirmMemory, correctMemory, flagMemory, deleteMemory } from "@/lib/api";

interface MemoryActionsProps {
  id: string;
}

export function MemoryActions({ id }: MemoryActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [correctModalOpen, setCorrectModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [correctContent, setCorrectContent] = useState("");

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
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => handleAction(() => confirmMemory(id))}
        >
          <CheckCircle size={14} className="mr-1" />
          Confirm
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => setCorrectModalOpen(true)}
        >
          <Pencil size={14} className="mr-1" />
          Correct
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => handleAction(() => flagMemory(id))}
        >
          <AlertTriangle size={14} className="mr-1" />
          Flag Mistake
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={loading}
          onClick={() => setDeleteModalOpen(true)}
        >
          <Trash2 size={14} className="mr-1" />
          Delete
        </Button>
      </div>

      <Modal
        open={correctModalOpen}
        onClose={() => setCorrectModalOpen(false)}
        title="Correct Memory"
      >
        <textarea
          value={correctContent}
          onChange={(e) => setCorrectContent(e.target.value)}
          placeholder="Enter the corrected content..."
          rows={3}
          className="w-full p-3 text-sm bg-[var(--color-bg-soft)] border border-[var(--color-border)] rounded-lg placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-solid)] resize-none"
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCorrectModalOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!correctContent.trim() || loading}
            onClick={() =>
              handleAction(async () => {
                await correctMemory(id, correctContent.trim());
                setCorrectModalOpen(false);
                setCorrectContent("");
              })
            }
          >
            Save Correction
          </Button>
        </div>
      </Modal>

      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Memory"
      >
        <p className="text-sm text-[var(--color-text-secondary)]">
          Are you sure you want to delete this memory? This action can be undone
          by an administrator.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteModalOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={loading}
            onClick={() =>
              handleAction(async () => {
                await deleteMemory(id);
                setDeleteModalOpen(false);
                router.push("/");
              })
            }
          >
            Delete
          </Button>
        </div>
      </Modal>
    </>
  );
}
