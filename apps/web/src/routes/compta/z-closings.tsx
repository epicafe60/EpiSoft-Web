import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Printer, TriangleAlert, XCircle } from 'lucide-react';
import {
  CLOSING_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  shopFormat,
  type ArchiveVerdict,
  type ClosingKind,
  type PaymentMethod,
  type PendingClosing,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useBranding } from '@/lib/branding';
import { useMe } from '@/lib/auth';
import { confirmNow } from '@/components/confirm';
import { euro, formatDate } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { cn } from '@/lib/utils';
import { QueryError } from '../errors';

// ADR 0016: the closings of period (« Z »), the control of the integrity of the till's journal and
// the archive for a controller. Day, month and year closings are final.

interface ClosingRow {
  id: string;
  kind: ClosingKind;
  periodStart: string;
  periodEnd: string;
  closedAt: string;
  tickets: number;
  cancellations: number;
  returns: number;
  salesTotal: string;
  refundsTotal: string;
  netTotal: string;
  grandTotal: string;
  journalSeq: number;
  totals: {
    byVat: { rate: string; ttc: string; ht?: string; vat?: string }[];
    byMethod: Record<string, string>;
    firstNumber: string | null;
    lastNumber: string | null;
  };
}

interface PendingData {
  today: string;
  openSessions: number;
  items: PendingClosing[];
}

interface VerifyData {
  at: string;
  signed: boolean;
  entries: number;
  lastHash: string | null;
  ok: boolean;
  findings: {
    id: string;
    label: string;
    severity: 'error' | 'warning';
    rows: { ref: string; detail: string; link: string | null }[];
  }[];
}

const dateTime = (iso: string) =>
  shopFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

const periodLabel = (kind: ClosingKind, start: string, end: string) =>
  kind === 'DAY'
    ? formatDate(start)
    : kind === 'MONTH'
      ? `${start.slice(5, 7)}/${start.slice(0, 4)}`
      : start.slice(0, 4) + (end.endsWith('-12-31') ? '' : ` (au ${formatDate(end)})`);

export function ZClosingsPage() {
  const me = useMe();
  const isAdmin = me.roles.includes('ADMIN');
  return (
    <div className="grid max-w-5xl gap-6">
      <PendingCard />
      <ClosingsCard />
      <VerifyCard />
      {isAdmin ? <ArchiveCard /> : null}
    </div>
  );
}

// --- What is left to close ---------------------------------------------------------------------

function PendingCard() {
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: ['fiscal-pending'],
    queryFn: () => api.get<PendingData>('/fiscal/closings/pending'),
  });
  const close = useMutation({
    mutationFn: (c: PendingClosing) =>
      api.post('/fiscal/closings', { kind: c.kind, start: c.start }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['fiscal-pending'] });
      await queryClient.invalidateQueries({ queryKey: ['fiscal-closings'] });
    },
  });
  const ask = async (c: PendingClosing) => {
    const what = `${CLOSING_KIND_LABELS[c.kind].toLowerCase()} ${periodLabel(c.kind, c.start, c.end)}`;
    const ok = await confirmNow({
      title: `Clôturer ${what} ?`,
      message:
        'La clôture Z est définitive : elle fige les totaux de la période et plus aucun ticket ne pourra y être ajouté. Elle ne se refait pas.',
      impact: [`${c.tickets} document(s) de caisse sur la période`],
      confirmLabel: 'Clôturer',
      destructive: true,
    });
    if (ok) close.mutate(c);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">À clôturer</CardTitle>
        <p className="text-sm text-muted-foreground">
          Les journées se clôturent dans l’ordre, une fois la caisse fermée ; un mois, puis une
          année, quand ils sont terminés et que tout ce qu’ils contiennent est clôturé. Une tâche de
          nuit clôture seule les journées passées dont la caisse est fermée.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {pending.error ? <QueryError error={pending.error} /> : null}
        {close.isError ? (
          <Alert>
            {close.error instanceof ApiError ? close.error.message : 'Clôture impossible.'}
          </Alert>
        ) : null}
        {pending.data && pending.data.openSessions > 0 ? (
          <Alert variant="info">
            {pending.data.openSessions} session(s) de caisse encore ouverte(s) : une journée ne se
            clôture qu’après la fermeture de la caisse.
          </Alert>
        ) : null}
        {pending.data && !pending.data.items.length ? (
          <p className="text-sm text-muted-foreground">Rien à clôturer.</p>
        ) : null}
        {pending.data?.items.length ? (
          <Table exportable={false}>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3">Période</th>
                <th className="pr-3">Documents</th>
                <th className="pr-3">État</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.data.items.map((c) => (
                <tr key={`${c.kind}-${c.start}`} className="border-t align-top">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{CLOSING_KIND_LABELS[c.kind]}</span>{' '}
                    {periodLabel(c.kind, c.start, c.end)}
                  </td>
                  <td className="pr-3">{c.tickets}</td>
                  <td className="pr-3 text-sm">
                    {c.ready ? (
                      <Badge variant="success">Prête</Badge>
                    ) : (
                      <span className="text-muted-foreground">{c.reason}</span>
                    )}
                  </td>
                  <td className="text-right">
                    <Button
                      size="sm"
                      disabled={!c.ready || close.isPending}
                      onClick={() => void ask(c)}
                      aria-label={`Clôturer ${CLOSING_KIND_LABELS[c.kind].toLowerCase()} ${periodLabel(c.kind, c.start, c.end)}`}
                    >
                      Clôturer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- The closings made --------------------------------------------------------------------------

function ClosingsCard() {
  const [kind, setKind] = useState<ClosingKind | ''>('');
  const [open, setOpen] = useState<ClosingRow | null>(null);
  const closings = useQuery({
    queryKey: ['fiscal-closings'],
    queryFn: () => api.get<ClosingRow[]>('/fiscal/closings'),
  });
  const rows = (closings.data ?? []).filter((c) => !kind || c.kind === kind);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <CardTitle className="text-base">Clôtures faites</CardTitle>
        <Field label="Afficher">
          {(p) => (
            <Select
              {...p}
              className="w-40"
              value={kind}
              onChange={(e) => setKind(e.target.value as ClosingKind | '')}
            >
              <option value="">Tout</option>
              <option value="DAY">Journées</option>
              <option value="MONTH">Mois</option>
              <option value="YEAR">Années</option>
            </Select>
          )}
        </Field>
      </CardHeader>
      <CardContent>
        {closings.error ? <QueryError error={closings.error} /> : null}
        {closings.data && !rows.length ? (
          <p className="text-sm text-muted-foreground">Aucune clôture pour le moment.</p>
        ) : null}
        {rows.length ? (
          <Table exportName="Clôtures Z">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3">Période</th>
                <th className="pr-3">Clôturée le</th>
                <th className="pr-3 text-right">Tickets</th>
                <th className="pr-3 text-right">Annulations</th>
                <th className="pr-3 text-right">Avoirs</th>
                <th className="pr-3 text-right">Total net</th>
                <th className="pr-3 text-right">Cumul perpétuel</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{CLOSING_KIND_LABELS[c.kind]}</span>{' '}
                    {periodLabel(c.kind, c.periodStart, c.periodEnd)}
                  </td>
                  <td className="pr-3">{dateTime(c.closedAt)}</td>
                  <td className="pr-3 text-right tabular-nums">{c.tickets}</td>
                  <td className="pr-3 text-right tabular-nums">{c.cancellations}</td>
                  <td className="pr-3 text-right tabular-nums">{c.returns}</td>
                  <td className="pr-3 text-right tabular-nums">{euro(c.netTotal)}</td>
                  <td className="pr-3 text-right tabular-nums">{euro(c.grandTotal)}</td>
                  <td className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpen(c)}
                      aria-label={`Ticket Z, ${CLOSING_KIND_LABELS[c.kind].toLowerCase()} ${periodLabel(c.kind, c.periodStart, c.periodEnd)}`}
                    >
                      Ticket Z
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        <ZTicketDialog closing={open} onClose={() => setOpen(null)} />
      </CardContent>
    </Card>
  );
}

/** The printed « Z »: what a closing holds, for the paper file. */
function ZTicketDialog({ closing, onClose }: { closing: ClosingRow | null; onClose: () => void }) {
  const { associationName } = useBranding();
  if (!closing) return null;
  const t = closing.totals;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Ticket Z · ${CLOSING_KIND_LABELS[closing.kind]} ${periodLabel(closing.kind, closing.periodStart, closing.periodEnd)}`}
      description="Imprimez-le pour le classeur de la caisse."
    >
      <div className="print-area mx-auto grid w-full max-w-sm gap-1 rounded-lg border bg-white p-4 font-mono text-xs text-black">
        <p className="text-center text-sm font-bold">{associationName}</p>
        <p className="text-center font-bold">
          TICKET Z · {CLOSING_KIND_LABELS[closing.kind].toUpperCase()}
        </p>
        <p className="text-center">
          {periodLabel(closing.kind, closing.periodStart, closing.periodEnd)}
          {closing.kind !== 'DAY'
            ? ` · du ${formatDate(closing.periodStart)} au ${formatDate(closing.periodEnd)}`
            : ''}
        </p>
        <p className="text-center">Clôturé le {dateTime(closing.closedAt)}</p>
        <hr className="my-1 border-dashed border-black" />
        <Line label="Tickets" value={String(closing.tickets)} />
        <Line label="Annulations" value={String(closing.cancellations)} />
        <Line label="Avoirs" value={String(closing.returns)} />
        <Line label="Ventes" value={euro(closing.salesTotal)} />
        <Line label="Remboursements" value={euro(closing.refundsTotal)} />
        <Line label="TOTAL NET" value={euro(closing.netTotal)} bold />
        <hr className="my-1 border-dashed border-black" />
        <p className="font-bold">TVA par taux (TTC)</p>
        {t.byVat.length ? (
          t.byVat.map((v) => (
            <Line
              key={v.rate}
              label={`${Number(v.rate).toLocaleString('fr-FR')} %`}
              value={euro(v.ttc)}
            />
          ))
        ) : (
          <p>—</p>
        )}
        <hr className="my-1 border-dashed border-black" />
        <p className="font-bold">Règlements</p>
        {Object.entries(t.byMethod).map(([m, v]) => (
          <Line key={m} label={PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m} value={euro(v)} />
        ))}
        <hr className="my-1 border-dashed border-black" />
        <Line label="Premier n°" value={t.firstNumber ?? '—'} />
        <Line label="Dernier n°" value={t.lastNumber ?? '—'} />
        <Line label="GRAND TOTAL PERPÉTUEL" value={euro(closing.grandTotal)} bold />
        <Line label="Rang du journal" value={String(closing.journalSeq)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimer
        </Button>
      </div>
    </Dialog>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <p className={cn('flex justify-between gap-3', bold && 'font-bold')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </p>
  );
}

// --- Integrity ----------------------------------------------------------------------------------

function VerifyCard() {
  const check = useMutation({ mutationFn: () => api.get<VerifyData>('/admin/fiscal/verify') });
  const v = check.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contrôle de l’intégrité</CardTitle>
        <p className="text-sm text-muted-foreground">
          Recalcule la chaîne signée du journal de caisse, relit chaque ticket et chaque clôture, et
          dit si quelque chose a été modifié hors de l’application. C’est le contrôle qu’un
          contrôleur ferait.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <Button variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Contrôle en cours…' : 'Lancer le contrôle'}
          </Button>
        </div>
        {check.isError ? (
          <Alert>
            {check.error instanceof ApiError ? check.error.message : 'Contrôle impossible.'}
          </Alert>
        ) : null}
        {v ? (
          <div className="grid gap-2 text-sm" role="status">
            <p className="flex items-center gap-2 font-medium">
              {v.ok ? (
                <>
                  <CheckCircle2 className="size-4 text-success" aria-hidden /> Journal intact
                </>
              ) : (
                <>
                  <XCircle className="size-4 text-destructive" aria-hidden /> Anomalie détectée
                </>
              )}
            </p>
            <p className="text-muted-foreground">
              {v.entries} entrée(s) dans le journal · dernière empreinte{' '}
              <code>{v.lastHash ? `${v.lastHash.slice(0, 16)}…` : '—'}</code> · contrôlé le{' '}
              {dateTime(v.at)}
            </p>
            {!v.signed ? (
              <p className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                Le journal n’est pas signé : la clé de signature n’est pas posée sur le serveur. La
                chaîne reste vérifiable, pas les signatures.
              </p>
            ) : null}
            {v.findings.map((f) => (
              <div key={f.id} className="rounded-md border p-3">
                <p className="font-medium">
                  <Badge variant={f.severity === 'error' ? 'destructive' : 'muted'}>{f.id}</Badge>{' '}
                  {f.label}
                </p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {f.rows.slice(0, 10).map((r) => (
                    <li key={r.ref + r.detail}>
                      {r.ref} : {r.detail}
                    </li>
                  ))}
                  {f.rows.length > 10 ? <li>… et {f.rows.length - 10} autre(s)</li> : null}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- Archive ------------------------------------------------------------------------------------

function ArchiveCard() {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(
    `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: (archive: unknown) =>
      api.post<ArchiveVerdict>('/admin/fiscal/archive/verify', archive),
  });
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setFileError(null);
    verify.reset();
    if (!file) return;
    try {
      verify.mutate(JSON.parse(await file.text()));
    } catch {
      setFileError('Ce fichier n’est pas une archive fiscale (JSON attendu).');
    }
  };
  const valid = !!from && !!to && from <= to;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Archive pour un contrôleur</CardTitle>
        <p className="text-sm text-muted-foreground">
          Tickets, lignes, règlements, clôtures et journal chaîné d’une période, dans un fichier
          signé. À conserver hors du serveur, au minimum après chaque clôture annuelle (six ans).
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Du">
            {(p) => (
              <Input
                {...p}
                type="date"
                className="w-40"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label="Au" error={from > to ? 'La date de début suit la date de fin.' : undefined}>
            {(p) => (
              <Input
                {...p}
                type="date"
                className="w-40"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
          {valid ? (
            <a
              className={cn(buttonVariants({ variant: 'outline' }))}
              href={`/api/v1/admin/fiscal/archive?from=${from}&to=${to}`}
            >
              <Download /> Télécharger l’archive
            </a>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Field
            label="Vérifier un fichier d’archive"
            hint="Contrôle les sections, la chaîne du journal et la signature."
          >
            {(p) => <Input {...p} type="file" accept=".json,application/json" onChange={onFile} />}
          </Field>
          {fileError ? <Alert>{fileError}</Alert> : null}
          {verify.isError ? (
            <Alert>
              {verify.error instanceof ApiError ? verify.error.message : 'Vérification impossible.'}
            </Alert>
          ) : null}
          {verify.data ? (
            <div className="grid gap-1 text-sm" role="status">
              <p className="flex items-center gap-2 font-medium">
                {verify.data.ok ? (
                  <>
                    <CheckCircle2 className="size-4 text-success" aria-hidden /> Archive conforme
                  </>
                ) : (
                  <>
                    <XCircle className="size-4 text-destructive" aria-hidden /> Archive non conforme
                  </>
                )}
              </p>
              <p className="text-muted-foreground">
                {verify.data.signatureChecked
                  ? 'Signature vérifiée.'
                  : 'Signature non vérifiée (aucune clé sur le serveur) : sections et chaîne seulement.'}
              </p>
              {verify.data.problems.length ? (
                <ul className="list-disc pl-5 text-muted-foreground">
                  {verify.data.problems.slice(0, 20).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
