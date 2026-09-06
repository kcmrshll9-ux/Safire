import React from 'react';

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type DiskNote = { path: string; content: string; revision: string };
type Slot = DiskNote & { savedContent: string; checkpoint: string; remote?: DiskNote };
const empty: Slot = { path: '', content: '', savedContent: '', revision: '', checkpoint: '' };

export function useNoteWorkspace(api: Api) {
  const slots = React.useRef(new Map<string, Slot>());
  const current = React.useRef<Slot>(empty);
  const requestId = React.useRef(0);
  const queues = React.useRef(new Map<string, Promise<unknown>>());
  const saving = React.useRef(new Map<string, Promise<void>>());
  const [view, setView] = React.useState<Slot>(empty);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [checkpointAt, setCheckpointAt] = React.useState<number | null>(null);

  const publish = React.useCallback((slot: Slot) => {
    slots.current.set(slot.path, slot);
    if (current.current.path === slot.path) {
      current.current = slot;
      setView({ ...slot });
    }
  }, []);

  const checkpoint = React.useCallback((slot: Slot) => {
    if (!slot.path || slot.content === slot.savedContent || slot.checkpoint === slot.content) return Promise.resolve();
    const prior = queues.current.get(slot.path) || Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      await api('/api/draft', { method: 'PUT', body: JSON.stringify({ path: slot.path, content: slot.content, baseRevision: slot.revision }) });
      const latest = slots.current.get(slot.path);
      if (latest?.content === slot.content && latest.revision === slot.revision) publish({ ...latest, checkpoint: slot.content });
      setCheckpointAt(Date.now());
    });
    queues.current.set(slot.path, task);
    return task;
  }, [api, publish]);

  const setContent: React.Dispatch<React.SetStateAction<string>> = React.useCallback(value => {
    const slot = current.current;
    publish({ ...slot, content: typeof value === 'function' ? value(slot.content) : value });
    setError('');
  }, [publish]);

  React.useEffect(() => {
    const prepare = (event: Event) => {
      const request = event as CustomEvent<{ waitUntil: (pending: Promise<unknown>) => void }>;
      request.detail.waitUntil((async () => {
        await Promise.all([...saving.current.values()]);
        await Promise.all([...slots.current.values()].map(slot => checkpoint(slot)));
      })());
    };
    window.addEventListener('safire:checkpoint', prepare);
    return () => window.removeEventListener('safire:checkpoint', prepare);
  }, [checkpoint]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void checkpoint(current.current).catch(reason => setError(`Draft recovery unavailable: ${reason.message}. Save before closing.`));
    }, 200);
    return () => clearTimeout(timer);
  }, [view.content, view.path, checkpoint]);

  React.useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const atRisk = [...slots.current.values()].some(slot => slot.content !== slot.savedContent && slot.content !== slot.checkpoint);
      if (atRisk || saving.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const open = React.useCallback(async (path: string) => {
    const ticket = ++requestId.current;
    await checkpoint(current.current);
    const [disk, recovered] = await Promise.all([
      api<DiskNote>(`/api/note?path=${encodeURIComponent(path)}`),
      api<{ draft: { content: string; baseRevision: string } | null }>(`/api/draft?path=${encodeURIComponent(path)}`),
    ]);
    if (ticket !== requestId.current) return null;
    const existing = slots.current.get(disk.path);
    const draft = existing && existing.content !== existing.savedContent
      ? { content: existing.content, baseRevision: existing.revision } : recovered.draft;
    const hasDraft = draft && draft.content !== disk.content;
    const slot: Slot = {
      ...disk,
      savedContent: disk.content,
      content: hasDraft ? draft.content : disk.content,
      revision: hasDraft ? draft.baseRevision : disk.revision,
      checkpoint: hasDraft ? draft.content : disk.content,
      remote: hasDraft && draft.baseRevision !== disk.revision ? disk : undefined,
    };
    current.current = slot;
    publish(slot);
    setError('');
    return disk;
  }, [api, checkpoint, publish]);

  const save = React.useCallback((): Promise<void> => {
    const notePath = current.current.path;
    if (!notePath) return Promise.resolve();
    const pending = saving.current.get(notePath);
    if (pending) return pending;
    const task = (async () => {
      const slot = slots.current.get(notePath)!;
      if (slot.content === slot.savedContent) return;
      if (slot.remote) throw new Error('Review the newer version before saving. Your draft is preserved.');
      setBusy(true);
      try {
        // Explicit saves remain available for notes too large for draft recovery.
        await checkpoint(slot).catch(() => {});
        const result = await api<{ revision: string }>('/api/note', { method: 'PUT', body: JSON.stringify({ path: notePath, content: slot.content, revision: slot.revision }) });
        const latest = slots.current.get(notePath)!;
        const updated = { ...latest, savedContent: slot.content, revision: result.revision, checkpoint: '', remote: undefined };
        publish(updated);
        // Queue cleanup after older checkpoints; conditional deletion cannot
        // erase a draft written while this save was in flight.
        await (queues.current.get(notePath) || Promise.resolve()).catch(() => {});
        const afterQueue = slots.current.get(notePath)!;
        if (afterQueue.content !== afterQueue.savedContent) await checkpoint(afterQueue);
        else await api('/api/draft', { method: 'DELETE', body: JSON.stringify({ path: notePath, revision: result.revision }) });
        setError('');
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Save failed';
        setError(message);
        if ((reason as { status?: number }).status === 409) {
          const remote = await api<DiskNote>(`/api/note?path=${encodeURIComponent(notePath)}`);
          publish({ ...slots.current.get(notePath)!, remote });
        }
        throw reason;
      } finally { setBusy(false); }
    })();
    saving.current.set(notePath, task);
    void task.finally(() => saving.current.delete(notePath)).catch(() => {});
    return task;
  }, [api, checkpoint, publish]);

  const useLatest = React.useCallback(async () => {
    const slot = current.current;
    if (!slot.remote) return;
    // Preserve the draft in recovery; choosing latest only changes the editor.
    const latest = { ...slot.remote, savedContent: slot.remote.content, checkpoint: slot.remote.content };
    current.current = latest;
    publish(latest);
    setError('');
  }, [publish]);

  const mergeLatest = React.useCallback(() => {
    const slot = current.current;
    if (!slot.remote) return;
    publish({ ...slot, revision: slot.remote.revision, savedContent: slot.remote.content, remote: undefined, checkpoint: '' });
    setError('The editor now uses the latest revision. Review your merged text, then save.');
  }, [publish]);

  const clear = React.useCallback(() => { ++requestId.current; current.current = empty; setView(empty); }, []);
  return { ...view, checkpointContent: view.checkpoint, setContent, open, save, clear, busy, error, checkpointAt, checkpoint: () => checkpoint(current.current), useLatest, mergeLatest };
}
