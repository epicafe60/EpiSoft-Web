import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { euro } from '@/lib/format';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, Table } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { cn } from '@/lib/utils';
import { QueryError } from '../errors';
import { useFiscalYears, useJournals } from './queries';
import type { ReportTableData } from './types';

const REPORTS = [
  { key: 'situation', label: 'Situation intermédiaire' },
  { key: 'income', label: 'Compte de résultat' },
  { key: 'balance-sheet', label: 'Bilan' },
  { key: 'balance', label: 'Balance des comptes' },
  { key: 'journal', label: 'Journal' },
  { key: 'ledger', label: 'Grand livre' },
  { key: 'aged-payables', label: 'Dettes fournisseurs par ancienneté' },
] as const;

export function ReportsPage() {
  const years = useFiscalYears();
  const journals = useJournals();
  const [report, setReport] = useState<(typeof REPORTS)[number]['key']>('situation');
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [journalId, setJournalId] = useState('');
  const [accountFrom, setFrom] = useState('');
  const [accountTo, setTo] = useState('');
  const [validatedOnly, setValidatedOnly] = useState(false);

  const fy = fiscalYearId || years.data?.[0]?.id || '';
  const params = new URLSearchParams();
  if (fy && report !== 'aged-payables') params.set('fiscalYearId', fy);
  if (journalId && report === 'journal') params.set('journalId', journalId);
  if (accountFrom) params.set('accountFrom', accountFrom);
  if (accountTo) params.set('accountTo', accountTo);
  if (validatedOnly) params.set('status', 'VALIDATED');
  const ready = report === 'aged-payables' || !!fy;
  const { data, error, isFetching } = useQuery({
    queryKey: ['report', report, params.toString()],
    queryFn: () => api.get<ReportTableData>(`/reports/${report}?${params}`),
    enabled: ready,
  });
  const file = (format: 'xlsx' | 'pdf') => `/api/v1/reports/${report}?${params}&format=${format}`;
  const link = buttonVariants({ variant: 'outline' });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Édition">
          {(p) => (
            <Select
              {...p}
              className="w-72"
              value={report}
              onChange={(e) => setReport(e.target.value as typeof report)}
            >
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {report !== 'aged-payables' ? (
          <Field label="Exercice">
            {(p) => (
              <Select
                {...p}
                className="w-48"
                value={fy}
                onChange={(e) => setFiscalYearId(e.target.value)}
              >
                {(years.data ?? []).map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {report === 'journal' ? (
          <Field label="Journal">
            {(p) => (
              <Select
                {...p}
                className="w-44"
                value={journalId}
                onChange={(e) => setJournalId(e.target.value)}
              >
                <option value="">Tous</option>
                {(journals.data ?? []).map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {report === 'balance' || report === 'ledger' ? (
          <>
            <Field label="Du compte" hint="ex. 401000">
              {(p) => (
                <Input
                  {...p}
                  className="w-28"
                  inputMode="numeric"
                  value={accountFrom}
                  onChange={(e) => setFrom(e.target.value)}
                />
              )}
            </Field>
            <Field label="Au compte" hint="ex. 401999">
              {(p) => (
                <Input
                  {...p}
                  className="w-28"
                  inputMode="numeric"
                  value={accountTo}
                  onChange={(e) => setTo(e.target.value)}
                />
              )}
            </Field>
          </>
        ) : null}
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={validatedOnly}
            onChange={(e) => setValidatedOnly(e.target.checked)}
          />
          Écritures validées seulement
        </label>
        <div className="ml-auto flex gap-2">
          <a className={cn(link)} href={file('xlsx')}>
            <Download /> Excel
          </a>
          <a className={cn(link)} href={file('pdf')}>
            <Download /> PDF
          </a>
        </div>
      </div>
      {error ? <QueryError error={error} /> : null}
      {data ? (
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-lg font-semibold">{data.title}</h2>
            {data.subtitle ? (
              <p className="mb-3 text-sm text-muted-foreground">{data.subtitle}</p>
            ) : null}
            <div className={cn('overflow-x-auto', isFetching && 'opacity-60')}>
              <Table>
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c.key} className={c.type === 'money' ? 'text-right' : ''}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={i} className={r.bold ? 'font-semibold' : ''}>
                      {data.columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            c.type === 'money' && 'text-right tabular-nums',
                            'whitespace-pre',
                          )}
                        >
                          {c.type === 'money' ? euro(r.cells[c.key]) : (r.cells[c.key] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {data.rows.length === 0 ? (
                    <tr>
                      <td colSpan={data.columns.length} className="text-muted-foreground">
                        Aucune donnée sur cette période.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <FecCard fiscalYearId={fy} />
    </div>
  );
}

function FecCard({ fiscalYearId }: { fiscalYearId: string }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 text-sm">
        <p>
          <strong>Fichier des écritures comptables (FEC)</strong> : écritures validées de l’exercice
          choisi, pour l’expert-comptable ou l’administration.
        </p>
        <a
          className={buttonVariants({ variant: 'outline' })}
          aria-disabled={!fiscalYearId}
          href={fiscalYearId ? `/api/v1/reports/fec/${fiscalYearId}` : undefined}
        >
          <Download /> Exporter le FEC
        </a>
      </CardContent>
    </Card>
  );
}
