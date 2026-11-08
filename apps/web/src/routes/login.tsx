import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { meQuery } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Alert, Field, Input, PasswordInput } from '@/components/ui/form';
import { PublicLayout } from './public-layout';

export function LoginPage() {
  const { redirect } = useSearch({ from: '/connexion' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password });
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      await queryClient.fetchQuery(meQuery);
      // Only same-site paths are accepted as a redirect target (« //x » and « /\x » lead elsewhere).
      const target = redirect && /^\/(?![/\\])/.test(redirect) ? redirect : '/';
      await navigate({ to: target });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connexion impossible.');
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  return (
    <PublicLayout title="Connexion" description="Identifiez-vous pour accéder à EpiSoft.">
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Identifiant ou courriel">
          {(p) => (
            <Input
              {...p}
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Prénom_NOM"
            />
          )}
        </Field>
        <Field label="Mot de passe">
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={pending || !username || !password} className="w-full">
          {pending ? 'Connexion…' : 'Se connecter'}
        </Button>
        <Link
          to="/mot-de-passe-oublie"
          className="text-center text-sm text-primary underline-offset-4 hover:underline"
        >
          Mot de passe oublié ?
        </Link>
      </form>
    </PublicLayout>
  );
}
