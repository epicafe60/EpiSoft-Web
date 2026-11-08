import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { Printer, Send } from 'lucide-react';
import {
  centsToDecimal,
  cashGapNeedsComment,
  closing,
  countedCashCents,
  DEFAULT_THRESHOLDS,
  decimalToCents,
  DENOMINATIONS,
  formatEuro,
  othersActive,
  parseAmountToCents,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  silentDevices,
  type SessionPresence,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Textarea } from '@/components/ui/inputs';
import { Dialog } from '@/components/ui/dialog';
import { confirmNow } from '@/components/confirm';
import { setMeta, tillDb } from './db';
import { useTill } from './context';

const eur = (c: number) => formatEuro(centsToDecimal(c));
const faceLabel = (cents: number) => (cents >= 100 ? `${cents / 100} €` : `${cents} c`);

interface Summary {
  openingFloat: string;
  salesCount: number;
  cancellationsCount: number;
  salesTotal: string;
  byMethod: Record<string, string>;
  other: { purpose: string; method: string | null; amount: string }[];
  membershipsCount: number;
  cashSales: string;
  cashOther: string;
  chequesComputed: string;
  cardComputed: string;
  devices?: string[];
  byCashier?: { name: string; salesCount: number; total: string }[];
}

interface ClosedReport {
  countedCash: string;
  expectedCash: string;
  difference: string;
  bankDeposit: string;
  nextFloat: string;
  closedAt: string;
  summary: Summary;
}

/** R-SES-02: session closing; R-OFF-07: needs the outbox to be empty, or an explicit force. */
export function ClosingPage() {
  const { meta } = useTill();
  const [closed, setClosed] = useState<{ report: ClosedReport; openedAt: string } | null>(null);
  if (closed) return <Report report={closed.report} openedAt={closed.openedAt} />;
  if (!meta.session) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4">
        <Alert variant="info">Aucune session ouverte sur ce poste.</Alert>
      </div>
    );
  }
  return (
    <ClosingForm
      session={meta.session}
      onClosed={(report) => setClosed({ report, openedAt: meta.session!.openedAt })}
    />
  );
}

function ClosingForm({
  session,
  onClosed,
}: {
  session: { id: string; openedAt: string; openingFloat: string };
  onClosed: (r: ClosedReport) => void;
}) {
  const { sync, pendingCount, engine, settings, cashierId, meta } = useTill();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [deposit, setDeposit] = useState('');
  const [chequesCount, setChequesCount] = useState('');
  const [chequesTotal, setChequesTotal] = useState('');
  const [card, setCard] = useState('');
  const [comment, setComment] = useState('');
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  // R-SES-07: another cashier keeps the till: the closing is in their name, with their code
  // (checked by the server).
  const me = useMe();
  const closer = useLiveQuery(
    () => (cashierId === me.id ? undefined : tillDb.members.get(cashierId)),
    [cashierId, me.id],
  );
  const closerPinNeeded =
    cashierId !== me.id && (settings?.cashierPinRequired ?? true) && !!closer?.tillPin;
  const [closerPin, setCloserPin] = useState('');

  const summary = useQuery({
    queryKey: ['session-summary', session.id, pendingCount],
    queryFn: () => api.get<Summary>(`/pos/sessions/${session.id}/summary`),
    enabled: sync.online,
    retry: false,
  });

  // R-SES-06: anyone can close; the closing says who else is still there.
  const presence = useQuery({
    queryKey: ['session-presence', session.id],
    queryFn: () => api.get<SessionPresence>(`/pos/sessions/${session.id}/presence`),
    enabled: sync.online,
    retry: false,
    refetchInterval: 30_000,
  });
  const delay = (settings?.thresholds ?? DEFAULT_THRESHOLDS).closingOthersActiveMin;
  const now = new Date();
  const stillThere = presence.data
    ? othersActive(presence.data.cashiers, cashierId, now, delay)
    : [];
  const silent = presence.data
    ? silentDevices(
        presence.data.devices.filter((d) => d.id !== meta.device?.id),
        now,
        delay,
      )
    : [];
  const minutesAgo = (iso: string) =>
    Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));

  const intCounts = Object.fromEntries(
    DENOMINATIONS.map((d) => [String(d), Math.max(0, Math.trunc(Number(counts[String(d)] || 0)))]),
  );
  const counted = countedCashCents(intCounts);
  const result = summary.data
    ? closing({
        openingFloatCents: decimalToCents(summary.data.openingFloat),
        cashSalesCents: decimalToCents(summary.data.cashSales),
        cashOtherCents: decimalToCents(summary.data.cashOther),
        countedCashCents: counted,
        bankDepositCents: parseAmountToCents(deposit || '0') ?? 0,
      })
    : null;

  // A gap above the threshold, or a closing with tickets not sent, must be explained.
  const gapNeedsComment = result
    ? cashGapNeedsComment(result.differenceCents, settings?.thresholds ?? DEFAULT_THRESHOLDS)
    : false;
  const needsComment = gapNeedsComment || (pendingCount > 0 && force);
  const commentMissing = needsComment && comment.trim().length < 3;

  const close = useMutation({
    mutationFn: () =>
      api.post<ClosedReport>(`/pos/sessions/${session.id}/close`, {
        denominations: intCounts,
        bankDeposit: deposit || '0',
        chequesCount: Number(chequesCount || 0),
        chequesTotal: chequesTotal || '0',
        cardTotalDeclared: card || '0',
        comment: comment || undefined,
        forced: pendingCount > 0,
        ...(cashierId !== me.id
          ? { cashierId, ...(closerPinNeeded ? { pin: closerPin } : {}) }
          : {}),
      }),
    onSuccess: async (r) => {
      onClosed({ ...r, summary: summary.data! });
      // The copy of « the open session » kept by the device state is no longer true.
      queryClient.removeQueries({ queryKey: ['device-state'] });
      await setMeta('session', null);
    },
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pendingCount > 0 && !force) return;
    if (
      stillThere.length &&
      !(await confirmNow({
        title: 'Un autre caissier est encore actif',
        message: `${stillThere.map((c) => c.name).join(', ')} ${stillThere.length > 1 ? 'ont' : 'a'} vendu il y a moins de ${delay} minutes dans cette caisse. Une fois la caisse clôturée, plus personne ne peut y vendre.`,
        confirmLabel: 'Clôturer quand même',
        cancelLabel: 'Pas encore',
      }))
    )
      return;
    // R-EVO-05: the count is shown again and has to be confirmed before anything is saved.
    setConfirming(true);
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4">
      <h1 className="text-xl font-semibold">
        Clôture de la session ouverte le {formatDateTime(session.openedAt)}
      </h1>
      {!sync.online ? (
        <Alert>La clôture nécessite le réseau : elle calcule les totaux sur le serveur.</Alert>
      ) : null}
      {pendingCount > 0 ? (
        <Alert className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {pendingCount} opération(s) de ce poste ne sont pas encore envoyées. Envoyez-les avant
            de clôturer.
          </span>
          <Button size="sm" variant="outline" onClick={() => engine.kick()}>
            <Send /> Envoyer maintenant
          </Button>
        </Alert>
      ) : null}
      {stillThere.length || silent.length ? (
        <Alert variant="info" className="grid gap-1">
          {stillThere.length ? (
            <span>
              Encore actif dans cette caisse :{' '}
              {stillThere
                .map((c) => `${c.name} (dernier ticket il y a ${minutesAgo(c.lastSaleAt)} min)`)
                .join(', ')}
              .
            </span>
          ) : null}
          {silent.length ? (
            <span>
              Sans nouvelles depuis plus de {delay} minutes :{' '}
              {silent.map((d) => d.label).join(', ')}. Des tickets peuvent y attendre d’être
              envoyés.
            </span>
          ) : null}
        </Alert>
      ) : null}
      {summary.error ? (
        <Alert>
          {summary.error instanceof ApiError && summary.error.status === 404
            ? 'La session n’est pas encore connue du serveur : envoyez d’abord les opérations.'
            : summary.error.message}
        </Alert>
      ) : null}

      {summary.data && result ? (
        <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comptage des espèces</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {DENOMINATIONS.map((d) => (
                <div key={d} className="grid grid-cols-[4rem_1fr] items-center gap-2">
                  <Label htmlFor={`d-${d}`} className="text-right tabular-nums">
                    {faceLabel(d)}
                  </Label>
                  <Input
                    id={`d-${d}`}
                    inputMode="numeric"
                    className="h-11 text-right"
                    value={counts[String(d)] ?? ''}
                    onChange={(e) =>
                      setCounts({ ...counts, [String(d)]: e.target.value.replace(/\D/g, '') })
                    }
                  />
                </div>
              ))}
              <p className="col-span-full text-right text-lg">
                Espèces comptées : <strong className="tabular-nums">{eur(counted)}</strong>
              </p>
            </CardContent>
          </Card>

          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contrôle</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                <Row
                  label="Tickets de la session"
                  value={`${summary.data.salesCount} (annulations : ${summary.data.cancellationsCount})`}
                />
                <Row label="Total des ventes" value={formatEuro(summary.data.salesTotal)} />
                {PAYMENT_METHODS.filter(
                  (m) => m !== 'CASH' && decimalToCents(summary.data.byMethod[m] ?? '0') !== 0,
                ).map((m) => (
                  <Row
                    key={m}
                    label={`dont ${PAYMENT_METHOD_LABELS[m]}`}
                    value={formatEuro(summary.data.byMethod[m] ?? '0')}
                  />
                ))}
                <Row label="Fond initial" value={formatEuro(summary.data.openingFloat)} />
                <Row label="Ventes en espèces" value={formatEuro(summary.data.cashSales)} />
                <Row
                  label="Encaissements hors ventes en espèces"
                  value={formatEuro(summary.data.cashOther)}
                />
                {summary.data.byCashier && summary.data.byCashier.length > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    Session partagée : ventes de{' '}
                    {summary.data.byCashier.map((c) => c.name).join(', ')} (un seul tiroir, une
                    seule clôture). Vérifiez que chacun a tout envoyé.
                  </p>
                ) : null}
                {summary.data.byCashier && summary.data.byCashier.length > 1
                  ? summary.data.byCashier.map((c) => (
                      <Row
                        key={c.name}
                        label={`Ventes de ${c.name} (${c.salesCount} ticket(s))`}
                        value={formatEuro(c.total)}
                      />
                    ))
                  : null}
                <Row label="Espèces théoriques" value={eur(result.expectedCashCents)} strong />
                <Row label="Espèces comptées" value={eur(counted)} />
                <Row
                  label="Écart"
                  value={eur(result.differenceCents)}
                  strong
                  className={result.differenceCents === 0 ? 'text-success' : 'text-destructive'}
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="grid gap-3 pt-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Dépôt en banque (€)">
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="decimal"
                        value={deposit}
                        onChange={(e) => setDeposit(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Nouveau fond de caisse">
                    {(p) => <Input {...p} disabled value={eur(result.nextFloatCents)} />}
                  </Field>
                  <Field
                    label="Nombre de chèques"
                    hint={`Calculé : ${formatEuro(summary.data.chequesComputed)}`}
                  >
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="numeric"
                        value={chequesCount}
                        onChange={(e) => setChequesCount(e.target.value.replace(/\D/g, ''))}
                      />
                    )}
                  </Field>
                  <Field label="Total des chèques (€)">
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="decimal"
                        value={chequesTotal}
                        onChange={(e) => setChequesTotal(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label="Total des tickets de carte (€)"
                    hint={`Calculé : ${formatEuro(summary.data.cardComputed)}`}
                  >
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="decimal"
                        value={card}
                        onChange={(e) => setCard(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                {needsComment ? (
                  <Alert variant={commentMissing ? 'error' : 'info'}>
                    {gapNeedsComment
                      ? `Il y a un écart de ${eur(result.differenceCents)} dans le tiroir : recomptez, puis expliquez-le ci-dessous (obligatoire).`
                      : 'Vous clôturez alors que des tickets ne sont pas envoyés : dites pourquoi ci-dessous (obligatoire).'}
                  </Alert>
                ) : null}
                <Field label={needsComment ? 'Commentaire (obligatoire)' : 'Commentaire'}>
                  {(p) => (
                    <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} />
                  )}
                </Field>
                {pendingCount > 0 ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="force"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                    />
                    <Label htmlFor="force" className="font-normal text-destructive">
                      Forcer la clôture malgré les opérations non envoyées
                    </Label>
                  </div>
                ) : null}
                {closerPinNeeded ? (
                  <Field
                    label={`Code caissier de ${closer!.firstName} ${closer!.lastName}`}
                    hint="La clôture est enregistrée au nom de la personne qui a compté le tiroir."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        autoComplete="off"
                        className="w-32"
                        value={closerPin}
                        onChange={(e) =>
                          setCloserPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                        }
                      />
                    )}
                  </Field>
                ) : null}
                {close.error ? <Alert>{close.error.message}</Alert> : null}
                <Button
                  type="submit"
                  size="lg"
                  disabled={
                    close.isPending ||
                    (closerPinNeeded && closerPin.length !== 4) ||
                    (pendingCount > 0 && !force) ||
                    result.nextFloatCents < 0 ||
                    commentMissing
                  }
                >
                  Clôturer la session
                </Button>
              </CardContent>
            </Card>
          </div>
        </form>
      ) : null}
      {summary.data && result ? (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Confirmer la clôture"
          description="Vérifiez le comptage : la clôture ne se corrige ensuite qu’avec un responsable."
        >
          <div className="grid gap-4">
            <div className="grid gap-1 text-sm">
              <Row label="Espèces théoriques" value={eur(result.expectedCashCents)} />
              <Row label="Espèces comptées" value={eur(counted)} strong />
              <Row
                label="Écart"
                value={eur(result.differenceCents)}
                strong
                className={result.differenceCents === 0 ? 'text-success' : 'text-destructive'}
              />
              <Row label="Dépôt en banque" value={eur(parseAmountToCents(deposit || '0') ?? 0)} />
              <Row label="Fond de caisse suivant" value={eur(result.nextFloatCents)} />
            </div>
            {close.error ? <Alert>{close.error.message}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Corriger le comptage
              </Button>
              <Button onClick={() => close.mutate()} disabled={close.isPending}>
                Confirmer la clôture
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex justify-between gap-4', className)}>
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={cn('tabular-nums', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}

/** R-SES-02 step 6: the closing report, printable; also e-mailed to the treasurer. */
function Report({ report, openedAt }: { report: ClosedReport; openedAt: string }) {
  const s = report.summary;
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 p-4">
      <Alert variant="success">
        Session clôturée. Le rapport a été envoyé au trésorier s’il est paramétré.
      </Alert>
      <Card className="print-area">
        <CardHeader>
          <CardTitle>Rapport de clôture</CardTitle>
          <p className="text-sm text-muted-foreground">
            Du {formatDateTime(openedAt)} au {formatDateTime(report.closedAt)}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <Table>
            <tbody>
              <tr>
                <td>Tickets</td>
                <td className="text-right">
                  {s.salesCount} (annulations : {s.cancellationsCount})
                </td>
              </tr>
              <tr>
                <td>Total des ventes</td>
                <td className="text-right tabular-nums">{formatEuro(s.salesTotal)}</td>
              </tr>
              {PAYMENT_METHODS.map((m) => (
                <tr key={m}>
                  <td>{PAYMENT_METHOD_LABELS[m]}</td>
                  <td className="text-right tabular-nums">{formatEuro(s.byMethod[m] ?? '0')}</td>
                </tr>
              ))}
              <tr>
                <td>Encaissements hors ventes en espèces</td>
                <td className="text-right tabular-nums">{formatEuro(s.cashOther)}</td>
              </tr>
              <tr>
                <td>Fond initial</td>
                <td className="text-right tabular-nums">{formatEuro(s.openingFloat)}</td>
              </tr>
              <tr>
                <td>Espèces théoriques</td>
                <td className="text-right tabular-nums">{formatEuro(report.expectedCash)}</td>
              </tr>
              <tr>
                <td>Espèces comptées</td>
                <td className="text-right tabular-nums">{formatEuro(report.countedCash)}</td>
              </tr>
              <tr>
                <td className="font-medium">Écart</td>
                <td className="text-right font-semibold tabular-nums">
                  {formatEuro(report.difference)}
                </td>
              </tr>
              <tr>
                <td>Dépôt en banque</td>
                <td className="text-right tabular-nums">{formatEuro(report.bankDeposit)}</td>
              </tr>
              <tr>
                <td>Nouveau fond</td>
                <td className="text-right tabular-nums">{formatEuro(report.nextFloat)}</td>
              </tr>
            </tbody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer /> Imprimer
        </Button>
      </div>
    </div>
  );
}
