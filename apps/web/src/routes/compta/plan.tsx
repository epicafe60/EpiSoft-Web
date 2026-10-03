import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';
import { useAccounts, useFiscalYears, useJournals } from './queries';
import type { AccountRow, TemplateRow } from './types';

export function PlanPage() {
  return (
    <div className="grid gap-6">
      <AccountsCard />
      <JournalsCard />
      <FiscalYearsCard />
      <GuidesCard />
    </div>
  );
}

const SIDE_LABELS = { D: 'Débiteur', C: 'Créditeur', M: 'Mixte' } as const;

function AccountsCard() {
  const queryClient = useQueryClient();
  const { data, error } = useAccounts();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Partial<AccountRow> | null>(null);
  const rows = (data ?? []).filter(
    (a) =>
      !q.trim() ||
      a.number.startsWith(q.trim()) ||
      a.label.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [side, setSide] = useState<'D' | 'C' | 'M'>('D');
  const [active, setActive] = useState(true);
  const open = (a: Partial<AccountRow>) => {
    setEditing(a);
    setNumber(a.number ?? '');
    setLabel(a.label ?? '');
    setSide(a.normalSide ?? 'D');
    setActive(a.active ?? true);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { number, label, normalSide: side, active };
      return editing?.id ? api.put(`/accounts/${editing.id}`, body) : api.post('/accounts', body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">Plan comptable</CardTitle>
        <div className="flex gap-2">
          <Input
            aria-label="Rechercher un compte"
            placeholder="Numéro ou libellé"
            className="w-52"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button onClick={() => open({})}>
            <Plus /> Compte
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error ? <QueryError error={error} /> : null}
        {remove.error ? <Alert>{remove.error.message}</Alert> : null}
        <div className="max-h-96 overflow-auto">
          <Table>
            <thead>
              <tr>
                <th>Compte</th>
                <th>Libellé</th>
                <th>Sens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="tabular-nums">{a.number}</td>
                  <td>
                    {a.label} {a.active ? null : <Badge variant="muted">Inactif</Badge>}
                  </td>
                  <td>{SIDE_LABELS[a.normalSide]}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="ghost" size="sm" onClick={() => open(a)}>
                      Modifier
                    </Button>
                    {!a.used ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          window.confirm(`Supprimer le compte ${a.number} ?`) && remove.mutate(a.id)
                        }
                      >
                        Supprimer
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </CardContent>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Modifier le compte' : 'Nouveau compte'}
      >
        <div className="grid gap-3">
          <Field label="Numéro (6 chiffres)">
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                maxLength={6}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
              />
            )}
          </Field>
          <Field label="Libellé">
            {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
          <Field label="Sens habituel">
            {(p) => (
              <Select
                {...p}
                value={side}
                onChange={(e) => setSide(e.target.value as 'D' | 'C' | 'M')}
              >
                <option value="D">Débiteur</option>
                <option value="C">Créditeur</option>
                <option value="M">Mixte</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} /> Compte actif
          </label>
          {save.error ? <Alert>{save.error.message}</Alert> : null}
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Enregistrer
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function JournalsCard() {
  const queryClient = useQueryClient();
  const { data } = useJournals();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/journals', { code, label, active: true }),
    onSuccess: async () => {
      setCode('');
      setLabel('');
      await queryClient.invalidateQueries({ queryKey: ['journals'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (j: { id: string; code: string; label: string; active: boolean }) =>
      api.put(`/journals/${j.id}`, { code: j.code, label: j.label, active: !j.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['journals'] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Journaux</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Table>
          <tbody>
            {(data ?? []).map((j) => (
              <tr key={j.id}>
                <td className="w-24 font-medium">{j.code}</td>
                <td>{j.label}</td>
                <td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => toggle.mutate(j)}>
                    {j.active ? 'Désactiver' : 'Réactiver'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Code">
            {(p) => (
              <Input
                {...p}
                className="w-28"
                maxLength={5}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <Field label="Libellé">
            {(p) => (
              <Input
                {...p}
                className="w-64"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!code || !label || add.isPending}>
            Ajouter
          </Button>
        </form>
        {add.error ? <Alert>{add.error.message}</Alert> : null}
        {toggle.error ? <Alert>{toggle.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

function FiscalYearsCard() {
  const queryClient = useQueryClient();
  const { data } = useFiscalYears();
  const [label, setLabel] = useState('');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/fiscal-years', { label, startDate, endDate }),
    onSuccess: async () => {
      setLabel('');
      setStart('');
      setEnd('');
      await queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exercices</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Table>
          <thead>
            <tr>
              <th>Exercice</th>
              <th>Période</th>
              <th className="text-right">Écritures</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((y) => (
              <tr key={y.id}>
                <td>{y.label}</td>
                <td>
                  {formatDate(y.startDate)} – {formatDate(y.endDate)}
                </td>
                <td className="text-right tabular-nums">
                  {y.entries}
                  {y.drafts ? ` (dont ${y.drafts} brouillon${y.drafts > 1 ? 's' : ''})` : ''}
                </td>
                <td>
                  {y.status === 'OPEN' ? (
                    <Badge variant="success">Ouvert</Badge>
                  ) : (
                    <Badge variant="muted">Clôturé</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Libellé">
            {(p) => (
              <Input
                {...p}
                className="w-48"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Field label="Début">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={startDate}
                onChange={(e) => setStart(e.target.value)}
              />
            )}
          </Field>
          <Field label="Fin">
            {(p) => (
              <Input {...p} type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
            )}
          </Field>
          <Button type="submit" disabled={!label || !startDate || !endDate || add.isPending}>
            Créer l’exercice
          </Button>
        </form>
        {add.error ? <Alert>{add.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

function GuidesCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['entry-templates'],
    queryFn: () => api.get<TemplateRow[]>('/entry-templates'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/entry-templates/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['entry-templates'] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Guides de saisie</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          Créez un guide depuis une écriture (« Enregistrer comme guide »), puis chargez-le dans une
          nouvelle écriture.
        </p>
        <Table>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td className="text-muted-foreground">
                  {t.journalCode} · {t.lines.map((l) => l.accountNumber).join(', ')}
                </td>
                <td className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      window.confirm(`Supprimer le guide « ${t.label} » ?`) && remove.mutate(t.id)
                    }
                  >
                    Supprimer
                  </Button>
                </td>
              </tr>
            ))}
            {(data ?? []).length === 0 ? (
              <tr>
                <td className="text-muted-foreground">Aucun guide.</td>
              </tr>
            ) : null}
          </tbody>
        </Table>
        {remove.error ? <Alert>{remove.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}
