import { Dialog } from '@base-ui/react/dialog';
import { type ReactNode, type RefObject, useState } from 'react';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  initialFocus,
  canClose = true,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly canClose?: boolean;
}) {
  return (
    <Dialog.Root
      disablePointerDismissal={!canClose}
      open={open}
      onOpenChange={(next) => {
        if (next || canClose) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="dialog-popup" initialFocus={initialFocus}>
            <header className="dialog-header">
              <div>
                <Dialog.Title className="dialog-title">{title}</Dialog.Title>
                <Dialog.Description className="dialog-description">
                  {description}
                </Dialog.Description>
              </div>
              <Dialog.Close className="icon-button" aria-label="Close dialog" disabled={!canClose}>
                Close
              </Dialog.Close>
            </header>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
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
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="secret-reveal">
      <div className="field-label">{label}</div>
      <code className="secret-value">{value}</code>
      <div className="secret-actions">
        <p>{hint}</p>
        <button className="control control-primary" type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
