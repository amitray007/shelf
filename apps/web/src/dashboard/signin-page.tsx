import { Form, useActionData, useNavigation } from 'react-router';

export function SignInPage() {
  const action = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';

  return (
    <main className="signin-page">
      <section className="signin-panel" aria-labelledby="signin-title">
        <header className="signin-header">
          <span className="wordmark">shelf</span>
          <span className="signin-status">owner access</span>
        </header>
        <div className="signin-copy">
          <p className="eyebrow">Self-hosted workspace</p>
          <h1 id="signin-title">Open your artifact shelf</h1>
          <p>Browse revisions, manage share links, and issue scoped agent access.</p>
        </div>
        <Form className="signin-form" method="post" replace>
          <label className="field">
            <span className="field-label">Email</span>
            <input autoComplete="email" inputMode="email" name="email" required type="email" />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input autoComplete="current-password" name="password" required type="password" />
          </label>
          {action?.error === undefined ? null : (
            <p className="form-error" role="alert">
              {action.error}
            </p>
          )}
          <button
            className="control control-primary signin-submit"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </Form>
        <footer className="signin-footnote">
          Registration is closed. The installation owner is created by the operator.
        </footer>
      </section>
    </main>
  );
}
