import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  centsToDecimal,
  ENTRY_MODE_LABELS,
  ENTRY_MODES,
  parseAmountToCents,
  type EntryModeCode,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { SortTh, useSort, NoMatchRow } from '@/components/ui/sortable';
import { QueryError } from '../errors';
import { useAccounts, useFiscalYears, useJournals } from './queries';
import type { EntryDetail, EntryRow, TemplateCategory, TemplateRow } from './types';

const SOURCE_LABELS: Record<string, string> = {
  session: 'Caisse',
  invoice: 'Facture',
  invoice_payment: 'Règlement',
  bank_line: 'Banque',
  deposit: 'Remise',
  closing_stock: 'Clôture',
  closing_result: 'Clôture',
  closing_ran: 'À-nouveaux',
};

const ENTRY_SORT = {
  date: (r: EntryRow) => r.date,
  number: (r: EntryRow) => r.displayNumber,
  label: (r: EntryRow) => r.label,
  piece: (r: EntryRow) => r.pieceRef,
  total: (r: EntryRow) => Number(r.total),
  status: (r: EntryRow) => (r.status === 'VALIDATED' ? 'Validée' : 'Brouillon'),
};

export function EntriesPage() {
  const queryClient = useQueryClient();
  const journals = useJournals();
  const years = useFiscalYears();
  const [journalId, setJournalId] = useState('');
  const [status, setStatus] = useState('');
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const params = new URLSearchParams({ limit: '200' });
  if (journalId) params.set('journalId', journalId);
  if (status) params.set('status', status);
  if (fiscalYearId) params.set('fiscalYearId', fiscalYearId);
  if (q.trim()) params.set('q', q.trim());
  const { data, error } = useQuery({
    queryKey: ['entries', params.toString()],
    queryFn: () => api.get<EntryRow[]>(`/entries?${params}`),
  });
  const rows = data ?? [];
  const sort = useSort(rows, ENTRY_SORT);
  const drafts = rows.filter((r) => r.status === 'DRAFT');
  const validate = useMutation({
    mutationFn: (ids: string[]) => api.post<{ validated: number }>('/entries/validate', { ids }),
    onSuccess: async () => {
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
      await queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
    },
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="Exercice"
          className="w-48"
          value={fiscalYearId}
          onChange={(e) => setFiscalYearId(e.target.value)}
        >
          <option value="">Tous les exercices</option>
          {(years.data ?? []).map((y) => (
            <option key={y.id} value={y.id}>
              {y.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Journal"
          className="w-48"
          value={journalId}
          onChange={(e) => setJournalId(e.target.value)}
        >
          <option value="">Tous les journaux</option>
          {(journals.data ?? []).map((j) => (
            <option key={j.id} value={j.id}>
              {j.code} · {j.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="État"
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Tous les états</option>
          <option value="DRAFT">Brouillons</option>
          <option value="VALIDATED">Validées</option>
        </Select>
        <Input
          aria-label="Rechercher"
          placeholder="Libellé ou pièce"
          className="w-56"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Link to="/compta/ecritures/nouvelle" className={buttonVariants({ className: 'ml-auto' })}>
          <Plus /> Nouvelle écriture
        </Link>
      </div>
      {error ? <QueryError error={error} /> : null}
      {drafts.length ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button
            variant="outline"
            disabled={!selected.length || validate.isPending}
            onClick={() => validate.mutate(selected)}
          >
            Valider la sélection ({selected.length})
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setSelected(selected.length === drafts.length ? [] : drafts.map((d) => d.id))
            }
          >
            {selected.length === drafts.length
              ? 'Tout désélectionner'
              : 'Sélectionner les brouillons'}
          </Button>
          <span className="text-muted-foreground">
            La validation fixe l’écriture et lui donne son numéro.
          </span>
        </div>
      ) : null}
      {validate.error ? <Alert>{validate.error.message}</Alert> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th className="w-8" />
              <SortTh state={sort} sortKey="date">
                Date
              </SortTh>
              <SortTh state={sort} sortKey="number">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="label">
                Libellé
              </SortTh>
              <SortTh state={sort} sortKey="piece">
                Pièce
              </SortTh>
              <SortTh state={sort} sortKey="total" className="text-right">
                Montant
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(sort.rows ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.status === 'DRAFT' ? (
                    <Checkbox
                      aria-label={`Sélectionner ${r.label}`}
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, r.id]
                            : selected.filter((x) => x !== r.id),
                        )
                      }
                    />
                  ) : null}
                </td>
                <td className="tabular-nums">{formatDate(r.date)}</td>
                <td className="whitespace-nowrap tabular-nums">{r.displayNumber ?? '—'}</td>
                <td>
                  <Link
                    to="/compta/ecritures/$id"
                    params={{ id: r.id }}
                    className="text-primary hover:underline"
                  >
                    {r.label}
                  </Link>
                  {r.sourceType ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {SOURCE_LABELS[r.sourceType] ?? r.sourceType}
                    </span>
                  ) : null}
                </td>
                <td>{r.pieceRef}</td>
                <td className="text-right tabular-nums">{euro(r.total)}</td>
                <td>
                  {r.status === 'VALIDATED' ? (
                    <Badge variant="success">Validée</Badge>
                  ) : (
                    <Badge variant="muted">Brouillon</Badge>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-muted-foreground">
                  Aucune écriture.
                </td>
              </tr>
            ) : null}
          </tbody>
          <NoMatchRow state={sort} total={rows?.length} />
        </Table>
      </Card>
    </div>
  );
}

interface LineState {
  accountId: string;
  label: string;
  debit: string;
  credit: string;
}
const emptyLine = (): LineState => ({ accountId: '', label: '', debit: '', credit: '' });
const cents = (s: string) => (s.trim() === '' ? 0 : (parseAmountToCents(s) ?? 0));

export function NewEntryPage() {
  return <EntryForm id={null} />;
}

export function EditEntryPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <EntryForm id={id} />;
}

function EntryForm({ id }: { id: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const journals = useJournals();
  const detail = useQuery({
    queryKey: ['entry', id],
    queryFn: () => api.get<EntryDetail>(`/entries/${id}`),
    enabled: !!id,
  });
  const templates = useQuery({
    queryKey: ['entry-templates'],
    queryFn: () => api.get<TemplateRow[]>('/entry-templates'),
  });
  const categories = useQuery({
    queryKey: ['entry-template-categories'],
    queryFn: () => api.get<TemplateCategory[]>('/entry-template-categories'),
  });

  const [journalId, setJournalId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [pieceRef, setPieceRef] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<EntryModeCode | ''>('');
  const [lines, setLines] = useState<LineState[]>([emptyLine(), emptyLine()]);
  const [guideId, setGuideId] = useState('');
  const [asGuide, setAsGuide] = useState(false);
  const [reversing, setReversing] = useState(false);

  const e = detail.data;
  const locked = e?.status === 'VALIDATED';
  useEffect(() => {
    if (!e) return;
    setJournalId(e.journalId);
    setDate(e.date);
    setPieceRef(e.pieceRef ?? '');
    setLabel(e.label);
    setMode(e.mode ?? '');
    setLines(
      e.lines.map((l) => ({
        accountId: l.accountId,
        label: l.label === e.label ? '' : l.label,
        debit: cents(l.debit) ? l.debit : '',
        credit: cents(l.credit) ? l.credit : '',
      })),
    );
  }, [e]);
  useEffect(() => {
    if (!id && !journalId && journals.data?.length)
      setJournalId(journals.data.find((j) => j.code === 'OD')?.id ?? journals.data[0]!.id);
  }, [id, journalId, journals.data]);

  const debit = lines.reduce((s, l) => s + cents(l.debit), 0);
  const credit = lines.reduce((s, l) => s + cents(l.credit), 0);
  const gap = debit - credit;
  const balanced = gap === 0 && debit > 0;

  const update = (i: number, patch: Partial<LineState>) =>
    setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  /** R-CPT-06 "solder": puts the missing amount on this line. */
  const settle = (i: number) => {
    const others = lines.filter((_, k) => k !== i);
    const d = others.reduce((s, l) => s + cents(l.debit), 0);
    const c = others.reduce((s, l) => s + cents(l.credit), 0);
    const diff = d - c;
    update(
      i,
      diff > 0
        ? { debit: '', credit: centsToDecimal(diff) }
        : { debit: centsToDecimal(-diff), credit: '' },
    );
  };

  const loadGuide = (tid: string) => {
    const t = templates.data?.find((x) => x.id === tid);
    if (!t) return;
    const touched = lines.some((l) => l.accountId || l.debit || l.credit);
    if (touched && !window.confirm('Remplacer les lignes saisies par celles du guide ?')) return;
    setJournalId(t.journalId);
    setMode(t.mode ?? '');
    if (!label) setLabel(t.label);
    setLines(
      t.lines.map((l) => ({
        accountId: l.accountId,
        label: l.label,
        debit: l.debit ?? '',
        credit: l.credit ?? '',
      })),
    );
    setGuideId('');
  };

  const body = () => ({
    journalId,
    date,
    pieceRef,
    label,
    mode: mode || null,
    lines: lines.filter((l) => l.accountId || l.debit || l.credit),
  });

  const save = useMutation({
    mutationFn: async (validateAfter: boolean) => {
      const res = id
        ? await api.put<{ id: string }>(`/entries/${id}`, body())
        : await api.post<{ id: string }>('/entries', body());
      if (validateAfter) await api.post('/entries/validate', { ids: [res.id] });
      return res;
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
      await queryClient.invalidateQueries({ queryKey: ['entry', res.id] });
      await queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      if (!id) await navigate({ to: '/compta/ecritures/$id', params: { id: res.id } });
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/entries/${id}/duplicate`, {}),
    onSuccess: (res) => navigate({ to: '/compta/ecritures/$id', params: { id: res.id } }),
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/entries/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
      await navigate({ to: '/compta/ecritures' });
    },
  });

  const active = (accounts.data ?? []).filter((a) => a.active);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/compta/ecritures" className="text-sm text-primary hover:underline">
          ← Écritures
        </Link>
        {e ? (
          <h2 className="text-lg font-semibold">
            {e.displayNumber ?? 'Brouillon'}{' '}
            {locked ? (
              <Badge variant="success">Validée</Badge>
            ) : (
              <Badge variant="muted">Brouillon</Badge>
            )}
          </h2>
        ) : (
          <h2 className="text-lg font-semibold">Nouvelle écriture</h2>
        )}
        {e?.sourceType ? (
          <Badge variant="muted">Générée : {SOURCE_LABELS[e.sourceType] ?? e.sourceType}</Badge>
        ) : null}
        {e?.reversedById ? (
          <Link
            to="/compta/ecritures/$id"
            params={{ id: e.reversedById }}
            className="text-sm text-primary hover:underline"
          >
            Contre-passée →
          </Link>
        ) : null}
      </div>
      {detail.error ? <QueryError error={detail.error} /> : null}

      {!locked ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Charger un guide">
            {(p) => (
              <Select
                {...p}
                className="w-72"
                value={guideId}
                onChange={(ev) => loadGuide(ev.target.value)}
              >
                <option value="">—</option>
                {(categories.data ?? []).map((c) => (
                  <optgroup key={c.code} label={c.label}>
                    {(templates.data ?? [])
                      .filter((t) => t.active && t.categoryCode === c.code)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
                {(templates.data ?? []).some((t) => t.active && !t.categoryCode) ? (
                  <optgroup label="Autres">
                    {(templates.data ?? [])
                      .filter((t) => t.active && !t.categoryCode)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
              </Select>
            )}
          </Field>
        </div>
      ) : null}

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Journal">
            {(p) => (
              <Select
                {...p}
                disabled={locked}
                value={journalId}
                onChange={(ev) => setJournalId(ev.target.value)}
              >
                {(journals.data ?? [])
                  .filter((j) => j.active || j.id === journalId)
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.code} · {j.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Date">
            {(p) => (
              <Input
                {...p}
                type="date"
                disabled={locked}
                value={date}
                onChange={(ev) => setDate(ev.target.value)}
              />
            )}
          </Field>
          <Field label="Pièce">
            {(p) => (
              <Input
                {...p}
                disabled={locked}
                value={pieceRef}
                onChange={(ev) => setPieceRef(ev.target.value)}
              />
            )}
          </Field>
          <Field label="Mode de règlement">
            {(p) => (
              <Select
                {...p}
                disabled={locked}
                value={mode}
                onChange={(ev) => setMode(ev.target.value as EntryModeCode | '')}
              >
                <option value="">—</option>
                {ENTRY_MODES.map((m) => (
                  <option key={m} value={m}>
                    {ENTRY_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Libellé">
              {(p) => (
                <Input
                  {...p}
                  disabled={locked}
                  value={label}
                  onChange={(ev) => setLabel(ev.target.value)}
                />
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <Table className="stack-rows">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Libellé de ligne</th>
              <th className="w-32 text-right">Débit</th>
              <th className="w-32 text-right">Crédit</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td data-label="Compte" data-wide>
                  <Select
                    aria-label={`Compte, ligne ${i + 1}`}
                    disabled={locked}
                    value={l.accountId}
                    onChange={(ev) => update(i, { accountId: ev.target.value })}
                  >
                    <option value="">Choisir…</option>
                    {active.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.number} · {a.label}
                      </option>
                    ))}
                    {locked
                      ? (accounts.data ?? [])
                          .filter((a) => !a.active && a.id === l.accountId)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.number} · {a.label}
                            </option>
                          ))
                      : null}
                  </Select>
                </td>
                <td data-label="Libellé de ligne" data-wide>
                  <Input
                    aria-label={`Libellé, ligne ${i + 1}`}
                    disabled={locked}
                    placeholder={label}
                    value={l.label}
                    onChange={(ev) => update(i, { label: ev.target.value })}
                  />
                </td>
                <td data-label="Débit">
                  <Input
                    aria-label={`Débit, ligne ${i + 1}`}
                    inputMode="decimal"
                    className="text-right"
                    disabled={locked}
                    value={l.debit}
                    onChange={(ev) =>
                      update(i, { debit: ev.target.value, credit: ev.target.value ? '' : l.credit })
                    }
                  />
                </td>
                <td data-label="Crédit">
                  <Input
                    aria-label={`Crédit, ligne ${i + 1}`}
                    inputMode="decimal"
                    className="text-right"
                    disabled={locked}
                    value={l.credit}
                    onChange={(ev) =>
                      update(i, { credit: ev.target.value, debit: ev.target.value ? '' : l.debit })
                    }
                  />
                </td>
                <td className="whitespace-nowrap" data-actions>
                  {!locked ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={gap === 0 && !!(l.debit || l.credit)}
                        onClick={() => settle(i)}
                      >
                        Solder
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Supprimer la ligne ${i + 1}`}
                        disabled={lines.length <= 2}
                        onClick={() => setLines(lines.filter((_, k) => k !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <td colSpan={2} data-wide>
                {!locked ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLines([...lines, emptyLine()])}
                  >
                    <Plus /> Ajouter une ligne
                  </Button>
                ) : null}
              </td>
              <td className="text-right tabular-nums" data-label="Total débit">
                {euro(centsToDecimal(debit))}
              </td>
              <td className="text-right tabular-nums" data-label="Total crédit">
                {euro(centsToDecimal(credit))}
              </td>
              <td className="hidden sm:table-cell" />
            </tr>
          </tfoot>
        </Table>
      </Card>

      {!locked ? (
        <p role="status" className={balanced ? 'text-sm text-success' : 'text-sm text-destructive'}>
          {balanced
            ? 'L’écriture est équilibrée.'
            : gap === 0
              ? 'Saisissez des montants.'
              : `Écart : ${euro(centsToDecimal(Math.abs(gap)))} au ${gap > 0 ? 'crédit' : 'débit'} à compléter.`}
        </p>
      ) : null}
      {save.error ? <Alert>{save.error.message}</Alert> : null}
      {duplicate.error ? <Alert>{duplicate.error.message}</Alert> : null}
      {del.error ? <Alert>{del.error.message}</Alert> : null}
      {save.isSuccess && id ? <Alert variant="success">Écriture enregistrée.</Alert> : null}

      <div className="flex flex-wrap gap-3">
        {!locked ? (
          <>
            <Button disabled={save.isPending || !journalId} onClick={() => save.mutate(false)}>
              Enregistrer le brouillon
            </Button>
            <Button
              variant="outline"
              disabled={save.isPending || !balanced}
              onClick={() => save.mutate(true)}
            >
              Enregistrer et valider
            </Button>
            {id ? (
              <Button
                variant="destructive"
                onClick={() => window.confirm('Supprimer ce brouillon ?') && del.mutate()}
              >
                Supprimer
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {!e?.reversedById && !e?.reversesEntryId ? (
              <Button variant="outline" onClick={() => setReversing(true)}>
                Contre-passer
              </Button>
            ) : null}
          </>
        )}
        {id ? (
          <>
            <Button
              variant="outline"
              disabled={duplicate.isPending}
              onClick={() => duplicate.mutate()}
            >
              Dupliquer
            </Button>
            <Button variant="outline" onClick={() => setAsGuide(true)}>
              Enregistrer comme guide
            </Button>
          </>
        ) : null}
      </div>

      {id ? (
        <>
          <ReverseDialog entryId={id} open={reversing} onClose={() => setReversing(false)} />
          <GuideDialog
            entryId={id}
            label={label}
            categories={categories.data ?? []}
            open={asGuide}
            onClose={() => setAsGuide(false)}
          />
        </>
      ) : null}
    </div>
  );
}

function ReverseDialog({
  entryId,
  open,
  onClose,
}: {
  entryId: string;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayIso());
  const reverse = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/entries/${entryId}/reverse`, { date }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
      await queryClient.invalidateQueries({ queryKey: ['entry', entryId] });
      onClose();
      await navigate({ to: '/compta/ecritures/$id', params: { id: res.id } });
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Contre-passer l’écriture"
      description="Une écriture inverse, validée aussitôt, annule l’originale. Elle ne peut être faite qu’une fois."
    >
      <div className="grid gap-3">
        <Field label="Date de la contre-passation">
          {(p) => (
            <Input {...p} type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
          )}
        </Field>
        {reverse.error ? <Alert>{reverse.error.message}</Alert> : null}
        <Button onClick={() => reverse.mutate()} disabled={reverse.isPending}>
          Contre-passer
        </Button>
      </div>
    </Dialog>
  );
}

function GuideDialog({
  entryId,
  label,
  categories,
  open,
  onClose,
}: {
  entryId: string;
  label: string;
  categories: TemplateCategory[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(label);
  const [categoryCode, setCategoryCode] = useState('');
  const [keepAmounts, setKeepAmounts] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/entries/${entryId}/save-as-template`, {
        label: name,
        categoryCode: categoryCode || null,
        keepAmounts,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['entry-templates'] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Enregistrer comme guide">
      <div className="grid gap-3">
        <Field label="Nom du guide">
          {(p) => <Input {...p} value={name} onChange={(ev) => setName(ev.target.value)} />}
        </Field>
        <Field label="Catégorie">
          {(p) => (
            <Select {...p} value={categoryCode} onChange={(ev) => setCategoryCode(ev.target.value)}>
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={keepAmounts} onChange={(ev) => setKeepAmounts(ev.target.checked)} />
          Conserver les montants
        </label>
        {save.error ? <Alert>{save.error.message}</Alert> : null}
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
          Enregistrer
        </Button>
      </div>
    </Dialog>
  );
}
