import { Button } from '@cloudflare/kumo/components/button';
import type { HtmlPreviewSettings } from '@shelf/contracts';
import { useState } from 'react';
import { useLoaderData } from 'react-router';

import { DashboardApiError, saveHtmlPreviewSettings } from './api.js';
import './html-preview-settings.css';

function originsText(origins: readonly string[]): string {
  return origins.join('\n');
}

function parsedOrigins(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function HtmlPreviewSettingsPage() {
  const initial = useLoaderData() as HtmlPreviewSettings;
  const [savedOrigins, setSavedOrigins] = useState<readonly string[]>(
    initial.trustedResourceOrigins,
  );
  const [value, setValue] = useState(() => originsText(initial.trustedResourceOrigins));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const dirty = value !== originsText(savedOrigins);

  const save = async () => {
    setPending(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const settings = await saveHtmlPreviewSettings(parsedOrigins(value));
      const canonical = originsText(settings.trustedResourceOrigins);
      setSavedOrigins(settings.trustedResourceOrigins);
      setValue(canonical);
      setSuccess(
        'Trusted asset sources saved. Changes apply when a preview next opens or reloads.',
      );
    } catch (caught) {
      setError(
        caught instanceof DashboardApiError
          ? caught.message
          : 'Shelf could not save trusted asset sources. Try again.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="dashboard-page html-preview-settings">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Installation settings</p>
          <h1>HTML previews</h1>
          <p>Set which external HTTPS origins standalone HTML previews can load assets from.</p>
        </div>
      </div>

      <div className="html-preview-settings-panel">
        <div className="html-preview-settings-field">
          <label htmlFor="trusted-resource-origins">Trusted asset sources</label>
          <p id="trusted-resource-origins-help">
            Enter exact HTTPS origins, one per line, up to 32 sources and 2048 characters. Leave the
            list empty to block external assets.
          </p>
          <textarea
            aria-describedby={
              error === undefined
                ? 'trusted-resource-origins-help'
                : 'trusted-resource-origins-help trusted-resource-origins-error'
            }
            aria-invalid={error === undefined ? undefined : true}
            disabled={pending}
            id="trusted-resource-origins"
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
              setSuccess(undefined);
            }}
            placeholder={'https://cdn.example.com\nhttps://fonts.example.com'}
            spellCheck={false}
            value={value}
          />
        </div>

        <div className="html-preview-settings-notes">
          <p>
            This applies to standalone HTML previews in all workspaces. Folder previews keep local
            assets only.
          </p>
          <p>
            Trusted scripts can read shared HTML, including Protected shares. Use only sources you
            trust.
          </p>
          <p>Changes apply when a preview next opens or reloads. No restart is needed.</p>
        </div>

        <div className="html-preview-settings-actions">
          <Button disabled={!dirty || pending} onClick={() => void save()} type="button">
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {dirty && !pending ? <span role="status">Unsaved changes</span> : null}
        </div>
        {error === undefined ? null : (
          <p
            className="html-preview-settings-error"
            id="trusted-resource-origins-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {success === undefined ? null : (
          <p className="html-preview-settings-success" role="status">
            {success}
          </p>
        )}
      </div>
    </section>
  );
}
