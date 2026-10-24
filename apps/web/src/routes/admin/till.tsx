import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw } from 'lucide-react';
import {
  formatEuro,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { confirmNow, promptNow } from '@/components/confirm';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Input, Label } from '@/components/ui/form';
import type { MembershipTypeRow } from '@/lib/types';
import { QueryError } from '../errors';

interface DeviceRow {
  id: string;
  name: string;
  active: boolean;
  lastSyncAt: string | null;
  openSessionId: string | null;
}

interface SessionRow {
  id: string;
  deviceName: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  difference: string | null;
  salesCount: number;
  salesTotal: string;
}

interface SessionReport {
  session: {
    id: string;
    deviceName: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
    openingFloat: string;
  };
  summary: {
    salesCount: number;
    cancellationsCount: number;
    salesTotal: string;
    byMethod: Record<PaymentMethod, string>;
    cashOther: string;
    chequesComputed: string;
    cardComputed: string;
  };
  count: {
    countedCash: string;
    expectedCash: string;
    difference: string;
    bankDeposit: string;
    nextFloat: string;
    chequesCount: number;
    chequesTotal: string;
    cardTotalDeclared: string;
    comment: string | null;
  } | null;
}

/** R-ADM-03 devices, R-SES-03 sessions (reports, ADMIN reopening). */
export function TillAdminPage() {
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<DeviceRow[]>('/pos/devices'),
  });
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<SessionRow[]>('/pos/sessions?limit=60'),
  });
  const [reportId, setReportId] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ['session-report', reportId],
    queryFn: () => api.get<SessionReport>(`/pos/sessions/${reportId}/report`),
    enabled: !!reportId,
  });
  const forceClose = useMutation({
    mutationFn: (v: { id: string; comment: string }) =>
      api.post(`/pos/sessions/${v.id}/force-close`, { comment: v.comment }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
  const reopen = useMutation({
    mutationFn: (id: string) => api.post(`/pos/sessions/${id}/reopen`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Postes de caisse</CardTitle>
        </CardHeader>
        {devices.error ? <QueryError error={devices.error} /> : null}
        <Table>
          <thead>
            <tr>
              <th>Poste</th>
              <th>Dernier envoi</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody>
            {(devices.data ?? []).map((d) => (
              <tr key={d.id}>
                <td className="font-medium">
                  {d.name} {!d.active ? <Badge variant="muted">historique</Badge> : null}
                </td>
                <td className="tabular-nums">
                  {d.lastSyncAt ? formatDateTime(d.lastSyncAt) : '—'}
                </td>
                <td>
                  {d.openSessionId ? (
                    <Badge variant="success">ouverte</Badge>
                  ) : (
                    <span className="text-muted-foreground">fermée</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 pb-4 text-xs text-muted-foreground">
          Les ventes en attente d’envoi sont visibles sur chaque poste (indicateur de la caisse) :
          le serveur ne les connaît qu’une fois reçues.
        </p>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sessions de caisse</CardTitle>
        </CardHeader>
        {reopen.error ? <Alert className="mx-5">{reopen.error.message}</Alert> : null}
        {forceClose.error ? <Alert className="mx-5">{forceClose.error.message}</Alert> : null}
        <Table>
          <thead>
            <tr>
              <th>Ouverture</th>
              <th>Poste</th>
              <th className="text-right">Tickets</th>
              <th className="text-right">Ventes</th>
              <th className="text-right">Écart</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(sessions.data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap tabular-nums">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setReportId(s.id)}
                  >
                    {formatDateTime(s.openedAt)}
                  </button>
                  {s.status === 'OPEN' ? (
                    <Badge variant="success" className="ml-2">
                      ouverte
                    </Badge>
                  ) : null}
                </td>
                <td>{s.deviceName}</td>
                <td className="text-right tabular-nums">{s.salesCount}</td>
                <td className="text-right tabular-nums">{euro(s.salesTotal)}</td>
                <td
                  className={`text-right tabular-nums ${s.difference && s.difference !== '0.00' ? 'text-destructive' : ''}`}
                >
                  {s.difference !== null ? euro(s.difference) : '—'}
                </td>
                <td className="text-right">
                  {s.status === 'OPEN' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const comment = await promptNow({
                          title: 'Clôturer sans comptage',
                          message:
                            'La session sera clôturée sans compter le tiroir : le fond de caisse attendu est retenu. Le motif est conservé dans le journal.',
                          input: { label: 'Motif', minLength: 3 },
                          confirmLabel: 'Clôturer la session',
                          destructive: true,
                        });
                        if (comment) forceClose.mutate({ id: s.id, comment });
                      }}
                    >
                      <Lock /> Clôturer
                    </Button>
                  ) : null}
                  {s.status === 'CLOSED' && s.difference !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (
                          await confirmNow({
                            title: 'Rouvrir cette session ?',
                            message:
                              'Le comptage de la clôture sera supprimé. L’action est journalisée.',
                            impact: ['La caisse pourra de nouveau y encaisser des ventes.'],
                            confirmLabel: 'Rouvrir la session',
                            destructive: true,
                          })
                        )
                          reopen.mutate(s.id);
                      }}
                    >
                      <RotateCcw /> Rouvrir
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Dialog
        open={!!reportId}

        onClose={() => setReportId(null)}
        title="Rapport de session"
        className="max-w-xl"
      >
        {report.data ? (
          <div className="print-area grid gap-3 text-sm">
            <p className="text-muted-foreground">
              {report.data.session.deviceName} · du {formatDateTime(report.data.session.openedAt)}
              {report.data.session.closedAt
                ? ` au ${formatDateTime(report.data.session.closedAt)}`
                : ' (ouverte)'}
            </p>
            <Table>
              <tbody>
                <tr>
                  <td>Tickets</td>
                  <td className="text-right">
                    {report.data.summary.salesCount} (annulations :{' '}
                    {report.data.summary.cancellationsCount})
                  </td>
                </tr>
                <tr>
                  <td>Total des ventes</td>
                  <td className="text-right tabular-nums">
                    {formatEuro(report.data.summary.salesTotal)}
                  </td>
                </tr>
                {PAYMENT_METHODS.map((m) => (
                  <tr key={m}>
                    <td>{PAYMENT_METHOD_LABELS[m]}</td>
                    <td className="text-right tabular-nums">
                      {formatEuro(report.data!.summary.byMethod[m] ?? '0')}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>Encaissements hors ventes en espèces</td>
                  <td className="text-right tabular-nums">
                    {formatEuro(report.data.summary.cashOther)}
                  </td>
                </tr>
                <tr>
                  <td>Fond initial</td>
                  <td className="text-right tabular-nums">
                    {formatEuro(report.data.session.openingFloat)}
                  </td>
                </tr>
                {report.data.count ? (
                  <>
                    <tr>
                      <td>Espèces théoriques</td>
                      <td className="text-right tabular-nums">
                        {formatEuro(report.data.count.expectedCash)}
                      </td>
                    </tr>
                    <tr>
                      <td>Espèces comptées</td>
                      <td className="text-right tabular-nums">
                        {formatEuro(report.data.count.countedCash)}
                      </td>
                    </tr>
                    <tr>
                      <td className="font-medium">Écart</td>
                      <td className="text-right font-semibold tabular-nums">
                        {formatEuro(report.data.count.difference)}
                      </td>
                    </tr>
                    <tr>
                      <td>Dépôt en banque</td>
                      <td className="text-right tabular-nums">
                        {formatEuro(report.data.count.bankDeposit)}
                      </td>
                    </tr>
                    <tr>
                      <td>Nouveau fond</td>
                      <td className="text-right tabular-nums">
                        {formatEuro(report.data.count.nextFloat)}
                      </td>
                    </tr>
                    <tr>
                      <td>Chèques</td>
                      <td className="text-right tabular-nums">
                        {report.data.count.chequesCount} ·{' '}
                        {formatEuro(report.data.count.chequesTotal)} (calculé{' '}
                        {formatEuro(report.data.summary.chequesComputed)})
                      </td>
                    </tr>
                    <tr>
                      <td>Cartes déclarées</td>
                      <td className="text-right tabular-nums">
                        {formatEuro(report.data.count.cardTotalDeclared)} (calculé{' '}
                        {formatEuro(report.data.summary.cardComputed)})
                      </td>
                    </tr>
                  </>
                ) : null}
              </tbody>
            </Table>
            {report.data.count?.comment ? (
              <p className="whitespace-pre-line rounded bg-muted p-2">
                {report.data.count.comment}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => window.print()}>
                Imprimer
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">Chargement…</p>
        )}
      </Dialog>
    </div>
  );
}

/** R-ADH-01: membership types and prices, editable without code. */
export function MembershipTypesPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['membership-types'],
    queryFn: () => api.get<MembershipTypeRow[]>('/membership-types'),
  });
  const [edits, setEdits] = useState<
    Record<string, { label: string; price: string; durationMonths: string; active: boolean }>
  >({});
  const save = useMutation({
    mutationFn: ({
      id,
      v,
    }: {
      id: string;
      v: { label: string; price: string; durationMonths: string; active: boolean };
    }) => api.put(`/membership-types/${id}`, { ...v, durationMonths: Number(v.durationMonths) }),
    onSuccess: (_r, { id }) => {
      setEdits(({ [id]: _drop, ...rest }) => rest);
      void queryClient.invalidateQueries({ queryKey: ['membership-types'] });
    },
  });
  if (error) return <QueryError error={error} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Types d’adhésion</CardTitle>
        <p className="text-sm text-muted-foreground">
          Une durée de 0 mois vaut pour le jour même (adhésion de passage).
        </p>
      </CardHeader>
      {save.error ? <Alert className="mx-5">{save.error.message}</Alert> : null}
      <Table>
        <thead>
          <tr>
            <th>Libellé</th>
            <th className="w-32">Prix (€)</th>
            <th className="w-32">Durée (mois)</th>
            <th className="w-20">Actif</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((t) => {
            const v = edits[t.id] ?? {
              label: t.label,
              price: t.price,
              durationMonths: String(t.durationMonths),
              active: t.active,
            };
            const set = (patch: Partial<typeof v>) =>
              setEdits({ ...edits, [t.id]: { ...v, ...patch } });
            return (
              <tr key={t.id}>
                <td>
                  <Input
                    aria-label="Libellé"
                    value={v.label}
                    onChange={(e) => set({ label: e.target.value })}
                  />
                </td>
                <td>
                  <Input
                    aria-label="Prix"
                    inputMode="decimal"
                    value={v.price}
                    onChange={(e) => set({ price: e.target.value })}
                  />
                </td>
                <td>
                  <Input
                    aria-label="Durée en mois"
                    inputMode="numeric"
                    value={v.durationMonths}
                    onChange={(e) => set({ durationMonths: e.target.value.replace(/\D/g, '') })}
                  />
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`active-${t.id}`}
                      checked={v.active}
                      onChange={(e) => set({ active: e.target.checked })}
                    />
                    <Label htmlFor={`active-${t.id}`} className="sr-only">
                      Actif
                    </Label>
                  </div>
                </td>
                <td className="text-right">
                  <Button
                    size="sm"
                    disabled={!edits[t.id] || save.isPending}
                    onClick={() => save.mutate({ id: t.id, v })}
                  >
                    Enregistrer
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
