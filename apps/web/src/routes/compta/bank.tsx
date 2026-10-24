import { useEffect, useState } from 'react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { confirmNow } from '@/components/confirm';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import {
  autoMatchPick,
  decimalToCents,
  ENTRY_MODE_LABELS,
  ENTRY_MODES,
  type EntryModeCode,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';
import { useAccounts, useFiscalYears, useJournals } from './queries';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';

const STATEMENT_SORT = {
  file: (s: StatementRow) => s.fileName,
  period: (s: StatementRow) => s.periodStart,
  matched: (s: StatementRow) => s.matched,
  gap: (s: StatementRow) => Number(s.gap),
  status: (s: StatementRow) => (s.status === 'CLOSED' ? 'Clos' : 'Ouvert'),
};
const LINE_SORT = {
  date: (l: BankLineRow) => l.date,
  label: (l: BankLineRow) => `${l.label} ${l.memo ?? ''}`,
  amount: (l: BankLineRow) => Number(l.amount),
  state: (l: BankLineRow) => (l.status === 'MATCHED' ? 'Rapprochée' : 'À rapprocher'),
};
import type {
  BankAccountRow,
  BankLineRow,
  BankRuleRow,
  StatementDetail,
  StatementRow,
  Suggestion,
} from './types';

type Tab = 'statements' | 'rules' | 'deposits' | 'accounts' | 'check';
const TABS: { key: Tab; label: string }[] = [
  { key: 'statements', label: 'Relevés' },
  { key: 'rules', label: 'Règles d’affectation' },
  { key: 'deposits', label: 'Remises en banque' },
  { key: 'check', label: 'Contrôle' },
  { key: 'accounts', label: 'Comptes bancaires' },
];

const useBankAccounts = () =>
  useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => api.get<BankAccountRow[]>('/bank/accounts'),
  });

export function BankPage() {
  const [tab, setTab] = useState<Tab>('statements');
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Banque" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            variant={tab === t.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {tab === 'statements' ? <StatementsTab /> : null}
      {tab === 'rules' ? <RulesTab /> : null}
      {tab === 'deposits' ? <DepositsTab /> : null}
      {tab === 'check' ? <CheckTab /> : null}
      {tab === 'accounts' ? <AccountsTab /> : null}
    </div>
  );
}

// --- Statements and import (R-CPT-12) ------------------------------------------------------------------

function StatementsTab() {
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const [bankId, setBankId] = useState('');
  const bank = bankId || banks.data?.find((b) => b.active)?.id || '';
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const list = useQuery({
    queryKey: ['statements', bank],
    queryFn: () =>
      api.get<StatementRow[]>(`/bank/statements${bank ? `?bankAccountId=${bank}` : ''}`),
  });
  const sort = useSort(list.data, STATEMENT_SORT, { key: 'period', dir: 'desc' });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const p = new URLSearchParams({ bankAccountId: bank });
      if (opening.trim()) p.set('openingBalance', opening.trim());
      if (closing.trim()) p.set('closingBalance', closing.trim());
      return api.postFile<{ statementId: string | null; inserted: number; duplicates: number }>(
        `/bank/statements/import?${p}`,
        file,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['statements'] }),
  });
  const r = upload.data;

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <Field label="Compte bancaire">
            {(p) => (
              <Select
                {...p}
                className="w-56"
                value={bank}
                onChange={(e) => setBankId(e.target.value)}
              >
                {(banks.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} ({b.accountNumber})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Solde d’ouverture" hint="CSV seulement">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                className="w-32"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            )}
          </Field>
          <Field label="Solde de clôture" hint="CSV seulement">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                className="w-32"
                value={closing}
                onChange={(e) => setClosing(e.target.value)}
              />
            )}
          </Field>
          <label
            className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent ${bank ? '' : 'pointer-events-none opacity-50'}`}
          >
            <FileUp className="size-4" /> Importer un relevé (OFX, CSV, CAMT)
            <input
              type="file"
              accept=".ofx,.qfx,.csv,.xml,.txt"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
          </label>
        </CardContent>
      </Card>
      {!banks.data?.length && !banks.isLoading ? (
        <Alert variant="info">
          Déclarez d’abord un compte bancaire (onglet « Comptes bancaires »).
        </Alert>
      ) : null}
      {upload.error ? <Alert>{upload.error.message}</Alert> : null}
      {r ? (
        <Alert variant="success">
          {r.inserted} opération(s) importée(s), {r.duplicates} déjà connue(s).
          {r.statementId ? (
            <>
              {' '}
              <Link to="/compta/banque/$id" params={{ id: r.statementId }} className="underline">
                Ouvrir le relevé
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}
      {list.error ? <QueryError error={list.error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="file">
                Relevé
              </SortTh>
              <SortTh state={sort} sortKey="period">
                Période
              </SortTh>
              <SortTh state={sort} sortKey="matched" className="text-right">
                Rapprochées
              </SortTh>
              <SortTh state={sort} sortKey="gap" className="text-right">
                Écart
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(sort.rows ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <Link
                    to="/compta/banque/$id"
                    params={{ id: s.id }}
                    className="text-primary hover:underline"
                  >
                    {s.fileName}
                  </Link>
                </td>
                <td>
                  {formatDate(s.periodStart)} – {formatDate(s.periodEnd)}
                </td>
                <td className="text-right tabular-nums">
                  {s.matched} / {s.lines}
                </td>
                <td
                  className={`text-right tabular-nums ${s.gap === '0.00' ? '' : 'text-destructive'}`}
                >
                  {euro(s.gap)}
                </td>
                <td>
                  {s.status === 'CLOSED' ? (
                    <Badge variant="success">Clos</Badge>
                  ) : (
                    <Badge variant="muted">Ouvert</Badge>
                  )}
                </td>
              </tr>
            ))}
            {(list.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucun relevé importé.
                </td>
              </tr>
            ) : null}
          </tbody>
          <NoMatchRow state={sort} total={list.data?.length} />
        </Table>
      </Card>
    </div>
  );
}

// --- One statement: suggestions and batch matching (R-CPT-13, R-CPT-14) ------------------------------

export function StatementPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const { data, error } = useQuery({
    queryKey: ['statement', id],
    queryFn: () => api.get<StatementDetail>(`/bank/statements/${id}`),
  });
  /** lineId → "KIND:ref" ('' = leave aside), pre-filled with the first suggestion. */
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [account, setAccount] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    setChoice(
      Object.fromEntries(
        data.lines
          .filter((l) => l.status === 'NEW')
          .map((l) => [
            l.id,
            (() => {
              const pick = autoMatchPick(l.suggestions);
              return pick ? encode(pick) : '';
            })(),
          ]),
      ),
    );
  }, [data]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['statement', id] });
    await queryClient.invalidateQueries({ queryKey: ['statements'] });
    await queryClient.invalidateQueries({ queryKey: ['entries'] });
  };
  const match = useMutation({
    mutationFn: () => {
      const items = Object.entries(choice)
        .filter(([, v]) => v)
        .map(([lineId, v]) => {
          const [kind, ref] = v.split(':') as [string, string];
          if (kind === 'ENTRY_LINE') return { lineId, action: kind, entryLineId: ref };
          if (kind === 'INVOICE') return { lineId, action: kind, invoiceId: ref };
          if (kind === 'HOUSEHOLD') return { lineId, action: kind, householdId: ref };
          if (kind === 'RULE') return { lineId, action: kind, ruleId: ref };
          return { lineId, action: 'ACCOUNT', accountId: account[lineId] };
        });
      return api.post<{ matched: number }>('/bank/lines/match', { items });
    },
    onSuccess: refresh,
  });
  const unmatch = useMutation({
    mutationFn: (lineId: string) => api.post(`/bank/lines/${lineId}/unmatch`),
    onSuccess: refresh,
  });
  const close = useMutation({
    mutationFn: () => api.post(`/bank/statements/${id}/close`),
    onSuccess: refresh,
  });
  const lineSort = useSort(data?.lines, LINE_SORT);

  if (error) return <QueryError error={error} />;
  if (!data) return null;
  const open = data.status === 'OPEN';
  const pending = Object.values(choice).filter(Boolean).length;
  const newLines = data.lines.filter((l) => l.status === 'NEW').length;
  const ambiguous = data.lines.filter((l) => l.status === 'NEW' && l.suggestions.length > 1).length;

  return (
    <div className="grid gap-4">
      <Breadcrumbs
        items={[
          { label: 'Comptabilité', to: '/compta' },
          { label: 'Banque', to: '/compta/banque' },
          { label: data.fileName },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{data.fileName}</h2>
        <Badge variant={open ? 'muted' : 'success'}>{open ? 'Ouvert' : 'Clos'}</Badge>
      </div>
      <Card>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-2 pt-6 text-sm">
          <span>Compte {data.bankAccountNumber}</span>
          <span>
            {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
          </span>
          <span>Ouverture : {euro(data.openingBalance)}</span>
          <span>Clôture : {euro(data.closingBalance)}</span>
          <span className={data.gap === '0.00' ? 'text-success' : 'text-destructive'}>
            Écart : {euro(data.gap)}
          </span>
        </CardContent>
      </Card>
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={lineSort} sortKey="date">
                Date
              </SortTh>
              <SortTh state={lineSort} sortKey="label">
                Libellé
              </SortTh>
              <SortTh state={lineSort} sortKey="amount" className="text-right">
                Montant
              </SortTh>
              <SortTh state={lineSort} sortKey="state">
                Affectation
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(lineSort.rows ?? []).map((l) => (
              <tr key={l.id}>
                <td className="tabular-nums">{formatDate(l.date)}</td>
                <td>
                  {l.label}
                  {l.memo ? (
                    <span className="block text-xs text-muted-foreground">{l.memo}</span>
                  ) : null}
                </td>
                <td
                  className={`text-right tabular-nums ${decimalToCents(l.amount) < 0 ? '' : 'text-success'}`}
                >
                  {euro(l.amount)}
                </td>
                <td>
                  {l.status === 'MATCHED' ? (
                    <span className="flex items-center gap-2">
                      <Badge variant="success">Rapprochée</Badge>
                      {open ? (
                        <Button variant="ghost" size="sm" onClick={() => unmatch.mutate(l.id)}>
                          Défaire
                        </Button>
                      ) : null}
                    </span>
                  ) : (
                    <div className="grid gap-1">
                      <Select
                        aria-label={`Affectation de ${l.label}`}
                        value={choice[l.id] ?? ''}
                        onChange={(e) => setChoice({ ...choice, [l.id]: e.target.value })}
                      >
                        <option value="">— laisser de côté —</option>
                        {l.suggestions.map((s) => (
                          <option key={encode(s)} value={encode(s)}>
                            {suggestionLabel(s)}
                          </option>
                        ))}
                        <option value="ACCOUNT:">Autre compte…</option>
                      </Select>
                      {(choice[l.id] ?? '').startsWith('ACCOUNT') ? (
                        <Select
                          aria-label={`Compte pour ${l.label}`}
                          value={account[l.id] ?? ''}
                          onChange={(e) => setAccount({ ...account, [l.id]: e.target.value })}
                        >
                          <option value="">Choisir un compte…</option>
                          {(accounts.data ?? [])
                            .filter((a) => a.active)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.number} · {a.label}
                              </option>
                            ))}
                        </Select>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <NoMatchRow state={lineSort} total={data.lines.length} />
        </Table>
      </Card>
      {match.error ? <Alert>{match.error.message}</Alert> : null}
      {unmatch.error ? <Alert>{unmatch.error.message}</Alert> : null}
      {close.error ? <Alert>{close.error.message}</Alert> : null}
      {match.isSuccess ? (
        <Alert variant="success">{match.data.matched} ligne(s) rapprochée(s).</Alert>
      ) : null}
      {open && ambiguous > 0 ? (
        <p className="text-sm text-warning">
          {ambiguous} ligne(s) ont plusieurs propositions : choisissez-en une, elles ne sont pas
          présélectionnées.
        </p>
      ) : null}
      {open ? (
        <div className="flex flex-wrap gap-3">
          <Button disabled={!pending || match.isPending} onClick={() => match.mutate()}>
            Valider les rapprochements ({pending})
          </Button>
          <Button
            variant="outline"
            disabled={newLines > 0 || data.gap !== '0.00' || close.isPending}
            onClick={() => close.mutate()}
          >
            Clore le relevé
          </Button>
          {newLines > 0 ? (
            <span className="self-center text-sm text-muted-foreground">
              {newLines} ligne(s) à rapprocher.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function encode(s: Suggestion): string {
  switch (s.kind) {
    case 'ENTRY_LINE':
      return `ENTRY_LINE:${s.entryLineId}`;
    case 'INVOICE':
      return `INVOICE:${s.invoiceId}`;
    case 'HOUSEHOLD':
      return `HOUSEHOLD:${s.householdId}`;
    case 'RULE':
      return `RULE:${s.ruleId}`;
  }
}

function suggestionLabel(s: Suggestion): string {
  switch (s.kind) {
    case 'ENTRY_LINE':
      return `Écriture existante : ${s.label} (${formatDate(s.date)})`;
    case 'INVOICE':
      return `Régler la facture ${s.label}`;
    case 'HOUSEHOLD':
      return `Alimenter la cagnotte : ${s.label}`;
    case 'RULE':
      return `Règle : ${s.label}`;
  }
}

// --- Rules (R-CPT-13) -------------------------------------------------------------------------------------

const blankRule = () => ({
  priority: 100,
  label: '',
  pattern: '',
  matchType: 'CONTAINS' as BankRuleRow['matchType'],
  direction: 'ANY' as BankRuleRow['direction'],
  minAmount: '',
  maxAmount: '',
  counterAccountId: '',
  journalId: '',
  mode: '' as EntryModeCode | '',
  labelTemplate: '',
  householdMatch: false,
  active: true,
});

function RulesTab() {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const journals = useJournals();
  const rules = useQuery({
    queryKey: ['bank-rules'],
    queryFn: () => api.get<BankRuleRow[]>('/bank/rules'),
  });
  const suggestions = useQuery({
    queryKey: ['bank-rule-suggestions'],
    queryFn: () =>
      api.get<
        {
          pattern: string;
          direction: 'IN' | 'OUT';
          counterAccountId: string;
          counterAccount: string;
          count: number;
          example: string;
        }[]
      >('/bank/rules/suggestions'),
  });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [f, setF] = useState(blankRule());
  const set = <K extends keyof ReturnType<typeof blankRule>>(
    k: K,
    v: ReturnType<typeof blankRule>[K],
  ) => setF((x) => ({ ...x, [k]: v }));
  const body = () => ({
    ...f,
    minAmount: f.minAmount.trim() || null,
    maxAmount: f.maxAmount.trim() || null,
    counterAccountId: f.counterAccountId || null,
    journalId: f.journalId || null,
    mode: f.mode || null,
    labelTemplate: f.labelTemplate.trim() || null,
    supplierId: null,
  });
  const open = (r: BankRuleRow | null) => {
    setEditing(r?.id ?? 'new');
    setF(
      r
        ? {
            priority: r.priority,
            label: r.label,
            pattern: r.pattern,
            matchType: r.matchType,
            direction: r.direction,
            minAmount: r.minAmount ?? '',
            maxAmount: r.maxAmount ?? '',
            counterAccountId: r.counterAccountId ?? '',
            journalId: r.journalId ?? '',
            mode: r.mode ?? '',
            labelTemplate: r.labelTemplate ?? '',
            householdMatch: r.householdMatch,
            active: r.active,
          }
        : blankRule(),
    );
  };
  const save = useMutation({
    mutationFn: () =>
      editing === 'new'
        ? api.post('/bank/rules', body())
        : api.put(`/bank/rules/${editing}`, body()),
    onSuccess: async () => {
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
      await queryClient.invalidateQueries({ queryKey: ['bank-rule-suggestions'] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<{
        count: number;
        scanned: number;
        sample: { id: string; date: string; label: string; amount: string }[];
      }>('/bank/rules/test', body()),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/bank/rules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bank-rules'] }),
  });
  const accountName = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? `${a.number} ${a.label}` : '';
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Règles d’affectation</CardTitle>
        <Button onClick={() => open(null)}>Nouvelle règle</Button>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          La première règle (par priorité croissante) dont le motif correspond propose l’écriture.
        </p>
        {(suggestions.data ?? []).length > 0 ? (
          <div
            className="grid gap-2 rounded-md border border-dashed p-3"
            data-testid="rule-suggestions"
          >
            <p className="text-sm font-medium">Règles suggérées</p>
            {suggestions.data!.map((s) => (
              <div
                key={`${s.pattern}-${s.direction}`}
                className="flex flex-wrap items-center gap-3 text-sm"
              >
                <span>
                  « {s.pattern} » ({s.direction === 'IN' ? 'entrée' : 'sortie'}) →{' '}
                  {s.counterAccount} · {s.count} affectations manuelles, par ex. {s.example}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing('new');
                    setF({
                      ...blankRule(),
                      label: s.pattern,
                      pattern: s.pattern,
                      matchType: 'CONTAINS',
                      direction: s.direction,
                      counterAccountId: s.counterAccountId,
                    });
                  }}
                >
                  Créer la règle
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <Table>
          <thead>
            <tr>
              <th>Priorité</th>
              <th>Règle</th>
              <th>Motif</th>
              <th>Compte</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rules.data ?? []).map((r) => (
              <tr key={r.id} className={r.active ? '' : 'opacity-60'}>
                <td className="tabular-nums">{r.priority}</td>
                <td>{r.label}</td>
                <td className="font-mono text-xs">{r.pattern}</td>
                <td>{r.householdMatch ? 'Cagnotte du foyer' : accountName(r.counterAccountId)}</td>
                <td className="whitespace-nowrap text-right">
                  <Button variant="ghost" size="sm" onClick={() => open(r)}>
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (
                        await confirmNow({
                          title: 'Supprimer cette règle ?',
                          message: `La règle « ${r.label} » ne classera plus les lignes bancaires.`,
                          confirmLabel: 'Supprimer',
                          destructive: true,
                        })
                      )
                        remove.mutate(r.id);
                    }}
                  >
                    Supprimer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardContent>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nouvelle règle' : 'Modifier la règle'}
      >
        <div className="grid gap-3">
          <Field label="Nom">
            {(p) => <Input {...p} value={f.label} onChange={(e) => set('label', e.target.value)} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type de motif">
              {(p) => (
                <Select
                  {...p}
                  value={f.matchType}
                  onChange={(e) => set('matchType', e.target.value as BankRuleRow['matchType'])}
                >
                  <option value="CONTAINS">Contient</option>
                  <option value="STARTS">Commence par</option>
                  <option value="REGEX">Expression régulière</option>
                </Select>
              )}
            </Field>
            <Field label="Priorité">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  value={f.priority}
                  onChange={(e) => set('priority', Number(e.target.value))}
                />
              )}
            </Field>
          </div>
          <Field label="Motif">
            {(p) => (
              <Input {...p} value={f.pattern} onChange={(e) => set('pattern', e.target.value)} />
            )}
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Sens">
              {(p) => (
                <Select
                  {...p}
                  value={f.direction}
                  onChange={(e) => set('direction', e.target.value as BankRuleRow['direction'])}
                >
                  <option value="ANY">Tous</option>
                  <option value="IN">Encaissement</option>
                  <option value="OUT">Paiement</option>
                </Select>
              )}
            </Field>
            <Field label="Montant min.">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={f.minAmount}
                  onChange={(e) => set('minAmount', e.target.value)}
                />
              )}
            </Field>
            <Field label="Montant max.">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={f.maxAmount}
                  onChange={(e) => set('maxAmount', e.target.value)}
                />
              )}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={f.householdMatch}
              onChange={(e) => set('householdMatch', e.target.checked)}
            />
            Virement d’un foyer : alimenter sa cagnotte
          </label>
          {!f.householdMatch ? (
            <Field label="Compte de contrepartie">
              {(p) => (
                <Select
                  {...p}
                  value={f.counterAccountId}
                  onChange={(e) => set('counterAccountId', e.target.value)}
                >
                  <option value="">Choisir…</option>
                  {(accounts.data ?? [])
                    .filter((a) => a.active)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.number} · {a.label}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Journal">
              {(p) => (
                <Select
                  {...p}
                  value={f.journalId}
                  onChange={(e) => set('journalId', e.target.value)}
                >
                  <option value="">Banque (BNQ)</option>
                  {(journals.data ?? []).map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Mode">
              {(p) => (
                <Select
                  {...p}
                  value={f.mode}
                  onChange={(e) => set('mode', e.target.value as EntryModeCode | '')}
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
          </div>
          <Field label="Libellé de l’écriture" hint="Variables : {libelle}, {date}, {montant}">
            {(p) => (
              <Input
                {...p}
                value={f.labelTemplate}
                onChange={(e) => set('labelTemplate', e.target.value)}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Règle
            active
          </label>
          {test.data ? (
            <Alert variant="info">
              {test.data.count} opération(s) sur {test.data.scanned} correspondent.
              {test.data.sample.slice(0, 5).map((s) => (
                <span key={s.id} className="block text-xs">
                  {formatDate(s.date)} · {s.label} · {euro(s.amount)}
                </span>
              ))}
            </Alert>
          ) : null}
          {test.error ? <Alert>{test.error.message}</Alert> : null}
          {save.error ? <Alert>{save.error.message}</Alert> : null}
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={!f.pattern || test.isPending}
            >
              Tester sur l’historique
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Enregistrer
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

// --- Deposits (R-SES-04) ------------------------------------------------------------------------------------

interface DepositRow {
  id: string;
  date: string;
  kind: 'CASH' | 'CHEQUES';
  amount: string;
  comment: string | null;
}

function DepositsTab() {
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const list = useQuery({
    queryKey: ['deposits'],
    queryFn: () => api.get<DepositRow[]>('/deposits'),
  });
  const [date, setDate] = useState(todayIso());
  const [kind, setKind] = useState<'CASH' | 'CHEQUES'>('CHEQUES');
  const [amount, setAmount] = useState('');
  const [bankId, setBankId] = useState('');
  const [comment, setComment] = useState('');
  const bank = bankId || banks.data?.find((b) => b.active)?.id || '';
  const add = useMutation({
    mutationFn: () =>
      api.post('/deposits', { date, kind, amount, bankAccountId: bank, cheques: [], comment }),
    onSuccess: async () => {
      setAmount('');
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['deposits'] });
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });
  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <Field label="Date">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Field label="Nature">
            {(p) => (
              <Select
                {...p}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'CASH' | 'CHEQUES')}
              >
                <option value="CHEQUES">Chèques</option>
                <option value="CASH">Espèces</option>
              </Select>
            )}
          </Field>
          <Field label="Montant">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                className="w-32"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Compte bancaire">
            {(p) => (
              <Select {...p} value={bank} onChange={(e) => setBankId(e.target.value)}>
                {(banks.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Commentaire">
            {(p) => (
              <Input
                {...p}
                className="w-56"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            )}
          </Field>
          <Button disabled={!amount || !bank || add.isPending} onClick={() => add.mutate()}>
            Enregistrer la remise
          </Button>
        </CardContent>
      </Card>
      {add.error ? <Alert>{add.error.message}</Alert> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Nature</th>
              <th>Commentaire</th>
              <th className="text-right">Montant</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((d) => (
              <tr key={d.id}>
                <td className="tabular-nums">{formatDate(d.date)}</td>
                <td>{d.kind === 'CASH' ? 'Espèces' : 'Chèques'}</td>
                <td>{d.comment}</td>
                <td className="text-right tabular-nums">{euro(d.amount)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// --- Bank control (R-CPT-15) ---------------------------------------------------------------------------------

function CheckTab() {
  const banks = useBankAccounts();
  const years = useFiscalYears();
  const [bankId, setBankId] = useState('');
  const bank = bankId || banks.data?.find((b) => b.active)?.id || '';
  const [date, setDate] = useState(todayIso());
  const check = useQuery({
    queryKey: ['bank-check', bank, date],
    queryFn: () =>
      api.get<{
        ledger: string;
        statement: string | null;
        statementDate: string | null;
        pending: string;
        pendingCount: number;
        gap: string | null;
      }>(`/bank/check?bankAccountId=${bank}&date=${date}`),
    enabled: !!bank && !!years.data,
  });
  const c = check.data;
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Compte bancaire">
            {(p) => (
              <Select {...p} value={bank} onChange={(e) => setBankId(e.target.value)}>
                {(banks.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="À la date du">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
        </div>
        {check.error ? <QueryError error={check.error} /> : null}
        {c ? (
          <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt>Solde du compte en comptabilité</dt>
            <dd className="text-right tabular-nums">{euro(c.ledger)}</dd>
            <dt>Dernier relevé clos{c.statementDate ? ` (${formatDate(c.statementDate)})` : ''}</dt>
            <dd className="text-right tabular-nums">
              {c.statement === null ? '—' : euro(c.statement)}
            </dd>
            <dt>Écritures non encore rapprochées ({c.pendingCount})</dt>
            <dd className="text-right tabular-nums">{euro(c.pending)}</dd>
            <dt className="font-semibold">Écart</dt>
            <dd
              className={`text-right font-semibold tabular-nums ${c.gap === null || c.gap === '0.00' ? '' : 'text-destructive'}`}
            >
              {c.gap === null ? '—' : euro(c.gap)}
            </dd>
          </dl>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Un écart nul signifie que la comptabilité et le dernier relevé clos concordent, une fois
          les opérations en attente de rapprochement mises de côté.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Bank accounts --------------------------------------------------------------------------------------------

function AccountsTab() {
  const queryClient = useQueryClient();
  const banks = useBankAccounts();
  const accounts = useAccounts();
  const [label, setLabel] = useState('');
  const [iban, setIban] = useState('');
  const [accountId, setAccountId] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post('/bank/accounts', { label, iban: iban || null, accountId, active: true }),
    onSuccess: async () => {
      setLabel('');
      setIban('');
      await queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
  });
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <Table>
          <tbody>
            {(banks.data ?? []).map((b) => (
              <tr key={b.id}>
                <td>{b.label}</td>
                <td className="tabular-nums">{b.accountNumber}</td>
                <td className="font-mono text-xs">{b.iban}</td>
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
          <Field label="Nom">
            {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
          <Field label="IBAN">
            {(p) => <Input {...p} value={iban} onChange={(e) => setIban(e.target.value)} />}
          </Field>
          <Field label="Compte comptable">
            {(p) => (
              <Select {...p} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Choisir…</option>
                {(accounts.data ?? [])
                  .filter((a) => a.active && a.number.startsWith('512'))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} · {a.label}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={!label || !accountId || add.isPending}>
            Ajouter
          </Button>
        </form>
        {add.error ? <Alert>{add.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}
