import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, TriangleAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { confirmNow } from '@/components/confirm';
import { euro, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { useMe } from '@/lib/auth';
import { QueryError } from '../errors';
import { useFiscalYears } from './queries';
import type { ClosingCheckData } from './types';

/** R-CPT-18: guided year-end closing. */
export function ClosingPage() {
  const queryClient = useQueryClient();
  const years = useFiscalYears();
  const me = useMe();
  const [selected, setSelected] = useState('');
  const [stockValue, setStockValue] = useState('');
  const [confirm, setConfirm] = useState(false);
  const year =
    years.data?.find((y) => y.id === selected) ??
    years.data?.find((y) => y.status === 'OPEN') ??
    years.data?.[0];
  const check = useQuery({
    queryKey: ['closing-check', year?.id],
    queryFn: () => api.get<ClosingCheckData>(`/fiscal-years/${year!.id}/closing-check`),
    enabled: !!year,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['closing-check'] });
    await queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
    await queryClient.invalidateQueries({ queryKey: ['entries'] });
  };
  const close = useMutation({
    mutationFn: () =>
      api.post(`/fiscal-years/${year!.id}/close`, {
        confirm: true,
        ...(stockValue.trim() ? { stockValue } : {}),
      }),
    onSuccess: async () => {
      setConfirm(false);
      await refresh();
    },
  });
  const reopen = useMutation({
    mutationFn: () => api.post(`/fiscal-years/${year!.id}/reopen`),
    onSuccess: refresh,
  });
  const c = check.data;
  const isAdmin = me?.roles.includes('ADMIN');

  return (
    <div className="grid max-w-3xl gap-4">
      <Field label="Exercice à clôturer">
        {(p) => (
          <Select
            {...p}
            className="w-64"
            value={year?.id ?? ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.label} {y.status === 'CLOSED' ? '(clôturé)' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {check.error ? <QueryError error={check.error} /> : null}
      {year ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {year.label}
              {year.status === 'CLOSED' ? (
                <Badge variant="muted">Clôturé</Badge>
              ) : (
                <Badge variant="success">Ouvert</Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Du {formatDate(year.startDate)} au {formatDate(year.endDate)}
            </p>
          </CardHeader>
          <CardContent className="grid gap-4">
            {year.status === 'OPEN' && c ? (
              <>
                <ul className="grid gap-2 text-sm">
                  {c.checks.map((k) => (
                    <li key={k.code} className="flex items-start gap-2">
                      {k.ok ? (
                        <CheckCircle2
                          className="mt-0.5 size-4 shrink-0 text-success"
                          aria-label="Conforme"
                        />
                      ) : k.severity === 'error' ? (
                        <XCircle
                          className="mt-0.5 size-4 shrink-0 text-destructive"
                          aria-label="Bloquant"
                        />
                      ) : (
                        <TriangleAlert
                          className="mt-0.5 size-4 shrink-0 text-amber-600"
                          aria-label="Avertissement"
                        />
                      )}
                      {k.message}
                    </li>
                  ))}
                </ul>
                <div className="grid gap-2 rounded-md border p-3 text-sm">
                  <p>
                    Stock en comptabilité : <strong>{euro(c.stock.account)}</strong> · valorisé
                    d’après les mouvements : <strong>{euro(c.stock.valuation)}</strong>.
                  </p>
                  <Field
                    label="Valeur du stock à retenir (facultatif)"
                    hint="Laissez vide pour utiliser la valorisation du stock au dernier jour de l’exercice."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="decimal"
                        className="w-40"
                        placeholder={c.stock.valuation}
                        value={stockValue}
                        onChange={(e) => setStockValue(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <p className="text-sm text-muted-foreground">
                  La clôture enregistre la variation de stock, solde les comptes de charges et de
                  produits vers le résultat (120000 / 129000), génère les à-nouveaux au premier jour
                  de l’exercice suivant, puis verrouille l’exercice.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                  Je confirme la clôture de {year.label}
                </label>
                {close.error ? <Alert>{close.error.message}</Alert> : null}
                <div>
                  <Button
                    disabled={!c.canClose || !confirm || close.isPending}
                    onClick={() => close.mutate()}
                  >
                    Clôturer l’exercice
                  </Button>
                </div>
              </>
            ) : year.status === 'CLOSED' ? (
              <>
                <p className="text-sm">
                  Cet exercice est clôturé : ses écritures ne peuvent plus changer.
                </p>
                {isAdmin ? (
                  <div className="grid gap-2">
                    <p className="text-sm text-muted-foreground">
                      Rouvrir l’exercice supprime les écritures de clôture (variation de stock,
                      résultat, à-nouveaux). Action réservée à l’administrateur, tracée au journal
                      d’audit.
                    </p>
                    {reopen.error ? <Alert>{reopen.error.message}</Alert> : null}
                    <div>
                      <Button
                        variant="destructive"
                        disabled={reopen.isPending}
                        onClick={async () => {
                          if (
                            await confirmNow({
                              title: `Rouvrir l’exercice ${year.label} ?`,
                              message:
                                'Les écritures de clôture (variation de stock, résultat, à-nouveaux) seront supprimées.',
                              confirmLabel: 'Rouvrir l’exercice',
                              destructive: true,
                            })
                          )
                            reopen.mutate();
                        }}
                      >
                        Rouvrir l’exercice
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {year ? <OpeningCheck yearId={year.id} /> : null}
    </div>
  );
}

interface OpeningCheckData {
  previous: string | null;
  previousStatus: 'OPEN' | 'CLOSED' | null;
  ok: boolean;
  differences: number;
  rows: { number: string; label: string; closing: string; opening: string; difference: string }[];
}

/** R-EVO-51: the carried-forward balances against the closing of the previous year. */
function OpeningCheck({ yearId }: { yearId: string }) {
  const { data } = useQuery({
    queryKey: ['opening-check', yearId],
    queryFn: () => api.get<OpeningCheckData>(`/fiscal-years/${yearId}/opening-check`),
  });
  if (!data?.previous) return null;
  const off = data.rows.filter((r) => r.difference !== '0.00');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Soldes d’ouverture</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant={data.ok ? 'success' : 'destructive'}>
            {data.ok ? 'À-nouveaux conformes' : `${data.differences} écart(s)`}
          </Badge>
          <span className="text-muted-foreground">
            comparés à la clôture de {data.previous}
            {data.previousStatus === 'OPEN' ? ' (exercice précédent non clôturé)' : ''}
          </span>
        </p>
        {off.length ? (
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Compte</th>
                <th className="text-right">Clôture</th>
                <th className="text-right">Ouverture</th>
                <th className="text-right">Écart</th>
              </tr>
            </thead>
            <tbody>
              {off.map((r) => (
                <tr key={r.number}>
                  <td>
                    {r.number} {r.label}
                  </td>
                  <td className="text-right tabular-nums">{euro(r.closing)}</td>
                  <td className="text-right tabular-nums">{euro(r.opening)}</td>
                  <td className="text-right tabular-nums text-destructive">{euro(r.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </CardContent>
    </Card>
  );
}
