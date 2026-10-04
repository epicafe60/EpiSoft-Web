import { Fragment, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { euro } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';

type State = 'NEW' | 'UP_TO_DATE' | 'OUTDATED_DRAFT' | 'DIFFERS_VALIDATED';

interface Proposal {
  key: string;
  label: string;
  from: string;
  to: string;
  entryDate: string;
  sessions: number;
  state: State;
  entryNumber: string | null;
  total: string;
  adjustment: string;
  existingTotal: string | null;
  lines: { account: string; label: string; debit: string; credit: string }[];
}

interface Data {
  from: string;
  to: string;
  defaultFrom: string;
  grouping: 'WEEK' | 'DAY';
  overlappingEntries: number;
  proposals: Proposal[];
}

const fr = (iso: string) => iso.split('-').reverse().join('/');

const STATE: Record<
  State,
  { label: string; variant: 'default' | 'success' | 'muted' | 'destructive' }
> = {
  NEW: { label: 'À générer', variant: 'default' },
  UP_TO_DATE: { label: 'À jour', variant: 'success' },
  OUTDATED_DRAFT: { label: 'Brouillon à mettre à jour', variant: 'default' },
  DIFFERS_VALIDATED: { label: 'Validée, différente', variant: 'destructive' },
};

/**
 * Entries proposed to the treasurer from the cash sessions nothing covers yet. Nothing is created
 * until the treasurer picks periods and confirms; only drafts are created or refreshed.
 */
export function ProposalsPage() {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [grouping, setGrouping] = useState<'WEEK' | 'DAY'>('WEEK');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const params = new URLSearchParams({ grouping });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isFetching } = useQuery({
    queryKey: ['proposals', params.toString()],
    queryFn: () => api.get<Data>(`/accounting/proposals?${params}`),
  });

  const actionable = (data?.proposals ?? []).filter(
    (p) => p.state === 'NEW' || p.state === 'OUTDATED_DRAFT',
  );
  // By default everything actionable is ticked; the treasurer unticks what they want to skip.
  const selected = picked ?? actionable.map((p) => p.key);
  const toggle = (key: string) =>
    setPicked(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; skipped: string[] }>(
        '/accounting/proposals/generate',
        { from: data!.from, to: data!.to, grouping, keys: selected },
      ),
    onSuccess: async () => {
      setPicked(null);
      await queryClient.invalidateQueries({ queryKey: ['proposals'] });
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Les ventes et les versements de cagnotte des sessions de caisse qu’aucune écriture ne couvre
        encore. Choisissez les périodes puis générez : ce sont des <strong>brouillons</strong> que
        vous relisez et validez ensuite dans Écritures. Rien n’est validé automatiquement.
      </p>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <Field
            label="À partir du"
            hint={
              data
                ? `Par défaut : ${fr(data.defaultFrom)}, lendemain de la dernière écriture de ventes saisie.`
                : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                type="date"
                value={from || data?.from || ''}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPicked(null);
                }}
              />
            )}
          </Field>
          <Field label="Jusqu’au">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={to || data?.to || ''}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPicked(null);
                }}
              />
            )}
          </Field>
          <Field label="Regroupement">
            {(p) => (
              <Select
                {...p}
                className="w-44"
                value={grouping}
                onChange={(e) => {
                  setGrouping(e.target.value as 'WEEK' | 'DAY');
                  setPicked(null);
                }}
              >
                <option value="WEEK">Par semaine</option>
                <option value="DAY">Par jour de caisse</option>
              </Select>
            )}
          </Field>
          {from || to ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFrom('');
                setTo('');
                setPicked(null);
              }}
            >
              Rétablir les dates par défaut
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {error ? <QueryError error={error} /> : null}
      {data && data.overlappingEntries > 0 ? (
        <Alert variant="info">
          {data.overlappingEntries} écriture(s) de ventes déjà saisie(s) (ancienne comptabilité ou
          saisie manuelle) se trouvent entre ces dates : vérifiez pour ne pas compter deux fois.
        </Alert>
      ) : null}
      {generate.error ? <Alert>{generate.error.message}</Alert> : null}
      {generate.isSuccess ? (
        <Alert variant="success">
          {generate.data.created} brouillon(s) créé(s), {generate.data.updated} mis à jour
          {generate.data.skipped.length ? `, ${generate.data.skipped.length} ignoré(s)` : ''}.{' '}
          <Link to="/compta/ecritures" className="underline">
            Voir les écritures
          </Link>
        </Alert>
      ) : null}

      <Card className={isFetching ? 'opacity-60' : ''}>
        <Table>
          <thead>
            <tr>
              <th className="w-0" />
              <th>Période</th>
              <th className="text-right">Sessions</th>
              <th className="text-right">Total</th>
              <th>État</th>
              <th className="w-0" />
            </tr>
          </thead>
          <tbody>
            {(data?.proposals ?? []).map((p) => (
              <Fragment key={p.key}>
                <tr>
                  <td>
                    {p.state === 'NEW' || p.state === 'OUTDATED_DRAFT' ? (
                      <Checkbox
                        aria-label={`Générer ${p.label}`}
                        checked={selected.includes(p.key)}
                        onChange={() => toggle(p.key)}
                      />
                    ) : null}
                  </td>
                  <td>
                    {p.label}
                    <span className="block text-xs text-muted-foreground">
                      écriture du {fr(p.entryDate)}
                      {p.entryNumber ? ` · n° ${p.entryNumber}` : ''}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{p.sessions}</td>
                  <td className="text-right tabular-nums">
                    {euro(p.total)}
                    {Number(p.adjustment) !== 0 ? (
                      <span className="block text-xs text-warning">
                        dont ajustement {euro(p.adjustment)} (tickets repris incohérents)
                      </span>
                    ) : null}
                    {p.existingTotal !== null ? (
                      <span className="block text-xs text-muted-foreground">
                        écriture actuelle : {euro(p.existingTotal)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <Badge variant={STATE[p.state].variant}>{STATE[p.state].label}</Badge>
                    {p.state === 'DIFFERS_VALIDATED' ? (
                      <span className="mt-1 block max-w-56 text-xs text-muted-foreground">
                        Écriture validée : contre-passez-la pour la regénérer.
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setOpen(open === p.key ? null : p.key)}
                    >
                      {open === p.key ? 'Masquer' : 'Voir les lignes'}
                    </button>
                  </td>
                </tr>
                {open === p.key ? (
                  <tr>
                    <td />
                    <td colSpan={5}>
                      <Table>
                        <thead>
                          <tr>
                            <th>Compte</th>
                            <th>Libellé</th>
                            <th className="text-right">Débit</th>
                            <th className="text-right">Crédit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="tabular-nums">{l.account}</td>
                              <td>{l.label}</td>
                              <td className="text-right tabular-nums">
                                {Number(l.debit) ? euro(l.debit) : ''}
                              </td>
                              <td className="text-right tabular-nums">
                                {Number(l.credit) ? euro(l.credit) : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
            {data && data.proposals.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted-foreground">
                  Aucune session de caisse à comptabiliser sur cette période.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>
      <div>
        <Button onClick={() => generate.mutate()} disabled={!selected.length || generate.isPending}>
          Générer les brouillons ({selected.length})
        </Button>
      </div>
    </div>
  );
}
