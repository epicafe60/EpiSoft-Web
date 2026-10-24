import { useState, type FormEvent } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert, Field, Input, PasswordInput } from '@/components/ui/form';
import { PublicLayout } from './public-layout';

const backToLogin = (
  <Link
    to="/connexion"
    search={{}}
    className="text-center text-sm text-primary underline-offset-4 hover:underline"
  >
    Retour à la connexion
  </Link>
);

/** R-AUTH-02: request a link by e-mail. */
export function ForgotPasswordPage() {
  const [username, setUsername] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('pending');
    try {
      await api.post('/auth/password/forgot', { username });
      setState('sent');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Envoi impossible.');
      setState('error');
    }
  };

  return (
    <PublicLayout
      title="Mot de passe oublié"
      description="Recevez par courriel un lien pour définir un nouveau mot de passe."
    >
      {state === 'sent' ? (
        <div className="grid gap-4">
          <Alert variant="success">
            Si cet identifiant correspond à un compte avec une adresse électronique, un lien valable
            1 heure vient d’être envoyé.
          </Alert>
          {backToLogin}
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          {state === 'error' ? <Alert>{error}</Alert> : null}
          <Field label="Identifiant ou courriel">
            {(p) => (
              <Input
                {...p}
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={state === 'pending' || !username}>
            Envoyer le lien
          </Button>
          {backToLogin}
        </form>
      )}
    </PublicLayout>
  );
}

/** R-AUTH-02 / R-AUTH-01: set a new password from the e-mailed link. */
export function SetPasswordPage() {
  const { jeton } = useSearch({ from: '/mot-de-passe' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || mismatch || !jeton) return;
    setState('pending');
    setError(null);
    try {
      await api.post('/auth/password/reset', { token: jeton, password });
      setState('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible.');
      setState('idle');
    }
  };

  if (!jeton) {
    return (
      <PublicLayout title="Lien incomplet">
        <div className="grid gap-4">
          <Alert>
            Ce lien est incomplet. Ouvrez le lien reçu par courriel, ou demandez-en un nouveau.
          </Alert>
          <Link
            to="/mot-de-passe-oublie"
            className="text-center text-sm text-primary hover:underline"
          >
            Demander un nouveau lien
          </Link>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout
      title="Définir votre mot de passe"
      description={`Au moins ${PASSWORD_MIN_LENGTH} caractères. Une phrase facile à retenir convient très bien.`}
    >
      {state === 'done' ? (
        <div className="grid gap-4">
          <Alert variant="success">
            Votre mot de passe est enregistré. Vous pouvez vous connecter.
          </Alert>
          {backToLogin}
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field
            label="Nouveau mot de passe"
            error={tooShort ? `Au moins ${PASSWORD_MIN_LENGTH} caractères.` : undefined}
          >
            {(p) => (
              <PasswordInput
                {...p}
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Confirmation"
            error={mismatch ? 'Les deux saisies sont différentes.' : undefined}
          >
            {(p) => (
              <PasswordInput
                {...p}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </Field>
          <Button
            type="submit"
            disabled={
              state === 'pending' || !password || tooShort || mismatch || confirm !== password
            }
          >
            Enregistrer
          </Button>
        </form>
      )}
    </PublicLayout>
  );
}
