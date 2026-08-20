import { Button } from '@cloudflare/kumo/components/button';
import { ClipboardText } from '@cloudflare/kumo/components/clipboard-text';
import { Dialog, type DialogProps } from '@cloudflare/kumo/components/dialog';
import { XIcon } from '@phosphor-icons/react/X';
import { type ReactNode, type RefObject, useEffect } from 'react';

import './dialog.css';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  initialFocus,
  canClose = true,
  size = 'lg',
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly canClose?: boolean;
  readonly size?: DialogProps['size'];
}) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (!open || initialFocus === undefined) return;
    const frame = requestAnimationFrame(() => initialFocus.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [initialFocus, open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next || canClose) onOpenChange(next);
      }}
    >
      <Dialog
        className="shelf-dialog"
        size={size}
        {...(prefersReducedMotion
          ? { style: { transitionDuration: '100ms', transitionProperty: 'opacity' } }
          : {})}
      >
        <div className="dialog-header">
          <div>
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          </div>
          <Dialog.Close
            render={
              <Button
                aria-label="Close dialog"
                disabled={!canClose}
                icon={XIcon}
                shape="square"
                size="sm"
                variant="ghost"
              />
            }
          />
        </div>
        {children}
      </Dialog>
    </Dialog.Root>
  );
}

export function SecretReveal({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <div className="secret-reveal">
      <div className="field-label">{label}</div>
      <ClipboardText
        className="shelf-secret-copy"
        labels={{ copyAction: `Copy ${label.toLocaleLowerCase()}` }}
        size="sm"
        text={value}
        tooltip={{ copiedText: 'Copied', text: 'Copy' }}
      />
      <p className="secret-hint">{hint}</p>
    </div>
  );
}
