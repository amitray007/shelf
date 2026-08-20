import { useEffect, useRef, useState } from 'react';

import {
  type ReviewVisitorIdentity,
  readReviewVisitorIdentity,
  saveReviewVisitorIdentity,
} from './identity.js';

export function VisitorNameDialog({
  onCancel,
  onSaved,
}: {
  readonly onCancel: () => void;
  readonly onSaved: (identity: ReviewVisitorIdentity) => void;
}) {
  const [name, setName] = useState(() => readReviewVisitorIdentity().displayName);
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
    const identity = readReviewVisitorIdentity();
    if (name.trim().length === 0) return;
    onSaved(saveReviewVisitorIdentity({ ...identity, displayName: name }));
  };
  return (
    <div
      aria-labelledby="review-visitor-title"
      className="review-dialog-backdrop"
      role="presentation"
    >
      <form className="review-dialog" onSubmit={submit} role="dialog" aria-modal="true">
        <h2 id="review-visitor-title">Choose a name for this review</h2>
        <p>Your name is shown beside comments you leave on this shared link.</p>
        <label className="review-field">
          <span>Display name</span>
          <input
            aria-label="Display name"
            autoComplete="nickname"
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            ref={inputRef}
            required
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
