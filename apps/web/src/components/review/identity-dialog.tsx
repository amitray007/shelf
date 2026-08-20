import { useEffect, useRef, useState } from 'react';

import {
  type ReviewVisitorIdentity,
  readReviewVisitorIdentity,
  saveReviewVisitorIdentity,
} from './identity.js';
import { readModeratorDisplayName, saveModeratorDisplayName } from './moderator-identity.js';

function ReviewNameDialog({
  description,
  initialName,
  onCancel,
  onSubmitName,
  required = true,
  title,
}: {
  readonly description: string;
  readonly initialName: string;
  readonly onCancel: () => void;
  readonly onSubmitName: (name: string) => void;
  readonly required?: boolean;
  readonly title: string;
}) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onCancel]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (required && name.trim().length === 0) return;
    onSubmitName(name);
  };
  return (
    <div
      aria-labelledby="review-visitor-title"
      className="review-dialog-backdrop"
      role="presentation"
    >
      <form className="review-dialog" onSubmit={submit} role="dialog" aria-modal="true">
        <h2 id="review-visitor-title">{title}</h2>
        <p>{description}</p>
        <label className="review-field">
          <span>Display name</span>
          <input
            aria-label="Display name"
            autoComplete="nickname"
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            ref={inputRef}
            required={required}
            value={name}
          />
        </label>
        <div className="review-dialog-actions">
          <button className="review-button review-button-quiet" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="review-button review-button-primary" type="submit">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

export function VisitorNameDialog({
  onCancel,
  onSaved,
}: {
  readonly onCancel: () => void;
  readonly onSaved: (identity: ReviewVisitorIdentity) => void;
}) {
  return (
    <ReviewNameDialog
      description="Your name is shown beside comments you leave on this shared link."
      initialName={readReviewVisitorIdentity().displayName}
      onCancel={onCancel}
      onSubmitName={(name) => {
        const identity = readReviewVisitorIdentity();
        onSaved(saveReviewVisitorIdentity({ ...identity, displayName: name }));
      }}
      title="Choose a name for this review"
    />
  );
}

export function ModeratorNameDialog({
  onCancel,
  onSaved,
}: {
  readonly onCancel: () => void;
  readonly onSaved: (displayName: string) => void;
}) {
  return (
    <ReviewNameDialog
      description="Shown beside your comments instead of “Shelf team”. Leave empty to use the default."
      initialName={readModeratorDisplayName()}
      onCancel={onCancel}
      onSubmitName={(name) => onSaved(saveModeratorDisplayName(name))}
      required={false}
      title="Choose your commenting name"
    />
  );
}
