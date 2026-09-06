import React from 'react';

export function useDialogAccessibility<T extends HTMLElement = HTMLElement>(open: boolean, close: () => void) {
  const ref = React.useRef<T>(null);
  const onClose = React.useRef(close);
  onClose.current = close;
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  // Install keyboard handling with focus, before the opened dialog is painted.
  React.useLayoutEffect(() => {
    if (!open) return;
    const previous = opener.current;
    const panel = ref.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || [])].filter(element => element.getClientRects().length > 0);
    if (!panel?.contains(document.activeElement)) focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose.current(); }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0]; const last = items[items.length - 1];
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  return ref;
}
