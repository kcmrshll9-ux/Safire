import React from 'react';

export type OverflowMenuAction = {
  label: string;
  onSelect: () => void | Promise<void>;
  hint?: string;
  danger?: boolean;
  separator?: boolean;
};

type OverflowMenuProps = {
  label: string;
  items: readonly OverflowMenuAction[];
  className?: string;
  trigger?: React.ReactNode;
};

export function OverflowMenu({ label, items, className, trigger = '•••' }: OverflowMenuProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const focusTargetRef = React.useRef<'first' | 'last'>('first');
  const reactId = React.useId();
  const menuId = `overflow-menu-${reactId.replace(/:/g, '')}`;

  const menuItems = React.useCallback(() => (
    [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])]
  ), []);

  const closeAndRestoreFocus = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const focusableItems = menuItems();
    const target = focusTargetRef.current === 'last' ? focusableItems[focusableItems.length - 1] : focusableItems[0];
    target?.focus();
  }, [menuItems, open]);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeAndRestoreFocus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeAndRestoreFocus, open]);

  const openMenu = (focusTarget: 'first' | 'last' = 'first') => {
    focusTargetRef.current = focusTarget;
    setOpen(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu('last');
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const focusableItems = menuItems();
    if (!focusableItems.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, focusableItems.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? focusableItems.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % focusableItems.length
          : (currentIndex - 1 + focusableItems.length) % focusableItems.length;
    focusableItems[nextIndex].focus();
  };

  const selectItem = async (item: OverflowMenuAction) => {
    closeAndRestoreFocus();
    await item.onSelect();
  };

  return <div
    ref={rootRef}
    className={`overflow-menu${className ? ` ${className}` : ''}`}
    style={{ position: 'relative', display: 'inline-flex' }}
  >
    <button
      ref={triggerRef}
      type="button"
      className="overflow-menu-trigger"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={onTriggerKeyDown}
    >
      <span aria-hidden="true">{trigger}</span>
    </button>
    {open && <div
      ref={menuRef}
      id={menuId}
      className="overflow-menu-popover"
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKeyDown}
      style={{ position: 'absolute', zIndex: 20, top: 'calc(100% + 8px)', right: 0 }}
    >
      {items.map((item, index) => <React.Fragment key={`${item.label}-${index}`}>
        {item.separator && <div className="overflow-menu-separator" role="separator" />}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`overflow-menu-item${item.danger ? ' danger' : ''}`}
          onClick={() => void selectItem(item)}
        >
          <span>{item.label}</span>
          {item.hint && <small className="overflow-menu-hint">{item.hint}</small>}
        </button>
      </React.Fragment>)}
    </div>}
  </div>;
}
