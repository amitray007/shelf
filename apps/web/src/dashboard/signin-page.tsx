import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { SensitiveInput } from '@cloudflare/kumo/components/sensitive-input';
import { Form, useActionData, useNavigation } from 'react-router';

import './access.css';

export function SignInPage() {
  const action = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';

  return (
    <main className="signin-page">
      <section className="signin-panel" aria-labelledby="signin-title">
        <header className="signin-header">
          <span className="wordmark">shelf</span>
        </header>
        <div className="signin-copy">
          <h1 id="signin-title">Sign in</h1>
          <p>Use your installation owner account.</p>
        </div>
        <Form className="signin-form" method="post" replace>
          <Input
            autoComplete="email"
            inputMode="email"
            label="Email"
            name="email"
            required
            type="email"
          />
          <SensitiveInput
            autoComplete="current-password"
            label="Password"
            name="password"
            required
          />
          {action?.error === undefined ? null : (
            <Banner
              description={action.error}
              role="alert"
              size="sm"
              title="Sign-in failed"
              variant="error"
            />
          )}
          <Button
            className="signin-submit"
            disabled={submitting}
            loading={submitting}
            type="submit"
            variant="primary"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </Form>
        <footer className="signin-footnote">
          Registration is closed. The installation owner is created by the operator.
        </footer>
      </section>
    </main>
  );
}
