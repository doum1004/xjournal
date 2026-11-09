import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useProject } from '../project';
import { Button } from './ui';

// Quick-add (spec §3.6): one step to write a note. Press "n" anywhere to open it.
// Hints in the text (#project @date !kind !tag) route it; otherwise it goes to the Inbox.

export function QuickAdd({
  open,
  onClose,
  prefill = '',
}: {
  open: boolean;
  onClose: () => void;
  prefill?: string;
}) {
  const [text, setText] = useState(prefill);
  const [result, setResult] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const { projects } = useProject();

  useEffect(() => {
    if (open) {
      setText(prefill);
      setResult(null);
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [open, prefill]);

  const add = useMutation({
    mutationFn: (t: string) => api.addNote(t),
    onSuccess: ({ note, routed }) => {
      const slug = projects.find((p) => p.id === note.projectId)?.slug;
      setResult(routed ? `Filed in #${slug} for ${note.applicableDate}.` : 'Saved to the Inbox.');
      setText('');
      qc.invalidateQueries();
    },
  });

  if (!open) return null;
  const submit = () => {
    if (text.trim()) add.mutate(text);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center px-4 pt-24">
      {/* Clicking the backdrop closes the dialog. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a note"
        className="relative w-full max-w-xl rounded-lg border border-line bg-panel p-4 shadow-xl"
      >
        <textarea
          ref={ref}
          value={text}
          aria-label="Note text"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={4}
          placeholder="What happened? #project @yesterday !decision"
          className="w-full resize-y rounded-md border border-line bg-bg p-3 text-sm outline-none focus:border-accent"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted" aria-live="polite">
            {add.error ? (
              <span className="text-warn">{(add.error as Error).message}</span>
            ) : (
              (result ?? 'Ctrl+Enter to save · Esc to close')
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={submit} disabled={!text.trim() || add.isPending}>
              {add.isPending ? 'Saving…' : 'Add note'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
