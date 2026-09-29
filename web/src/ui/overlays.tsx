import { useEffect, useId, useRef } from 'react';
import type { PropsWithChildren } from 'react';

import { Button } from './primitives';

export function Dialog({
  title,
  children,
  open = true,
  onClose,
  wide = false,
  className = '',
}: PropsWithChildren<{
  title: string;
  open?: boolean;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}>): React.JSX.Element | null {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={`modal ui-dialog${wide ? ' wide' : ''} ${className}`}
    >
      <div className="modal-title">
        <h2 id={id}>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  open,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: PropsWithChildren<{
  title: string;
  open: boolean;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>): React.JSX.Element | null {
  return (
    <Dialog
      title={title}
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <p>{children}</p>
      <div className="ui-page-actions">
        <Button type="button" secondary disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function Drawer({
  title,
  children,
  open = true,
  onClose,
}: PropsWithChildren<{
  title: string;
  open?: boolean;
  onClose: () => void;
}>): React.JSX.Element | null {
  return (
    <Dialog title={title} open={open} onClose={onClose} className="ui-drawer">
      {children}
    </Dialog>
  );
}

export function Sheet({
  title,
  children,
  open = true,
  onClose,
}: PropsWithChildren<{
  title: string;
  open?: boolean;
  onClose: () => void;
}>): React.JSX.Element | null {
  return (
    <Dialog title={title} open={open} onClose={onClose} className="ui-sheet">
      {children}
    </Dialog>
  );
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  pageSize,
  onPageSizeChange,
  total,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  total?: number;
}): React.JSX.Element {
  return (
    <nav className="pagination ui-pagination" aria-label="Pagination">
      <Button
        secondary
        disabled={page <= 1}
        onClick={() => {
          onPageChange(page - 1);
        }}
      >
        Previous
      </Button>
      <span aria-live="polite">
        {page} / {Math.max(1, pageCount)}
      </span>
      <Button
        secondary
        disabled={page >= pageCount}
        onClick={() => {
          onPageChange(page + 1);
        }}
      >
        Next
      </Button>
      {onPageSizeChange && (
        <label>
          Show{' '}
          <select
            aria-label="Items per page"
            value={pageSize}
            onChange={(event) => {
              onPageSizeChange(Number(event.target.value));
            }}
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
      )}
      {total !== undefined && <span>{total} total</span>}
    </nav>
  );
}

export function Stepper({
  steps,
  current,
  onStepChange,
}: {
  steps: string[];
  current: number;
  onStepChange?: (index: number) => void;
}): React.JSX.Element {
  return (
    <ol className="ui-stepper">
      {steps.map((step, index) => (
        <li
          key={step}
          className={
            index === current ? 'current' : index < current ? 'complete' : ''
          }
        >
          <button
            type="button"
            aria-current={index === current ? 'step' : undefined}
            disabled={!onStepChange}
            onClick={() => onStepChange?.(index)}
          >
            <span>{index + 1}</span>
            {step}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function ToastRegion({
  children,
}: PropsWithChildren): React.JSX.Element {
  return (
    <div
      className="ui-toast-region"
      aria-live="polite"
      aria-relevant="additions"
    >
      {children}
    </div>
  );
}

export function PageActions({
  children,
}: PropsWithChildren): React.JSX.Element {
  return <div className="ui-page-actions">{children}</div>;
}
