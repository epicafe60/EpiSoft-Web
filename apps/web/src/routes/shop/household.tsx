import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WALLET_ENTRY_KIND_LABELS, type WalletEntryKind } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert } from '@/components/ui/form';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import { PushToggle } from './push-toggle';
import { TicketDialog } from './ticket-dialog';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';

interface Mine {
  household: {
    balance: string;
    members: { id: string; firstName: string; lastName: string }[];
    membership: { endDate: string; typeName: string } | null;
    spentLast12Months: string;
    wallet: {
      id: string;
      at: string;
      amount: string;
      kind: WalletEntryKind;
      comment: string | null;
      saleId: string | null;
    }[];
    tickets: { id: string; number: string; soldAt: string; total: string }[];
  } | null;
}

type Wallet = NonNullable<Mine['household']>['wallet'][number];
type Ticket = NonNullable<Mine['household']>['tickets'][number];
const WALLET_SORT = {
  at: (w: Wallet) => w.at,
  kind: (w: Wallet) => `${WALLET_ENTRY_KIND_LABELS[w.kind]} ${w.comment ?? ''}`,
  amount: (w: Wallet) => Number(w.amount),
};
const TICKET_SORT = {
  at: (t: Ticket) => t.soldAt,
  number: (t: Ticket) => t.number,
  total: (t: Ticket) => Number(t.total),
};

/** Self-service view of the member's own household: cagnotte, membership, recent purchases. */
export function MyHouseholdPage() {
  const { data, error } = useQuery({
    queryKey: ['my-household'],
    queryFn: () => api.get<Mine>('/me/household'),
  });
  const [ticketId, setTicketId] = useState<string | null>(null);
  const walletSort = useSort(data?.household?.wallet, WALLET_SORT);
  const ticketSort = useSort(data?.household?.tickets, TICKET_SORT);
  const h = data?.household;
  const soon = h?.membership
    ? new Date(h.membership.endDate).getTime() - Date.now() < 30 * 86_400_000
    : false;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Mon foyer"
        description="Votre cagnotte, votre adhésion et vos derniers achats."
      />
      <PushToggle />
      <a href="/api/v1/me/export" className="w-fit text-sm text-primary hover:underline" download>
        Télécharger mes données (RGPD)
      </a>
      {error ? <QueryError error={error} /> : null}
      {data && !h ? <Alert variant="info">Aucun foyer n'est rattaché à votre compte.</Alert> : null}
      {h ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Cagnotte
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tabular-nums">{euro(h.balance)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Adhésion
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {h.membership ? (
                  <>
                    <p className="text-lg font-semibold">{h.membership.typeName}</p>
                    <p>
                      jusqu'au {formatDate(h.membership.endDate)}{' '}
                      {soon ? <Badge variant="destructive">bientôt échue</Badge> : null}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    Aucune adhésion en cours. Renouvelez-la à la caisse.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Achats sur 12 mois
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tabular-nums">{euro(h.spentLast12Months)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Foyer : {h.members.map((m) => m.firstName).join(', ')}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Mouvements de la cagnotte</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <SortTh state={walletSort} sortKey="at">
                      Date
                    </SortTh>
                    <SortTh state={walletSort} sortKey="kind">
                      Opération
                    </SortTh>
                    <SortTh state={walletSort} sortKey="amount" className="text-right">
                      Montant
                    </SortTh>
                  </tr>
                </thead>
                <tbody>
                  {(walletSort.rows ?? []).map((w) => (
                    <tr key={w.id}>
                      <td>{formatDate(w.at)}</td>
                      <td>
                        {WALLET_ENTRY_KIND_LABELS[w.kind]}
                        {w.comment ? (
                          <span className="text-muted-foreground"> — {w.comment}</span>
                        ) : null}
                        {w.saleId ? (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() => setTicketId(w.saleId)}
                            >
                              voir le ticket
                            </button>
                          </>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">{euro(w.amount)}</td>
                    </tr>
                  ))}
                  {h.wallet.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted-foreground">
                        Aucun mouvement.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                <NoMatchRow state={walletSort} total={h.wallet.length} />
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Derniers tickets</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <SortTh state={ticketSort} sortKey="at">
                      Date
                    </SortTh>
                    <SortTh state={ticketSort} sortKey="number">
                      Ticket
                    </SortTh>
                    <SortTh state={ticketSort} sortKey="total" className="text-right">
                      Total
                    </SortTh>
                  </tr>
                </thead>
                <tbody>
                  {(ticketSort.rows ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>{formatDate(s.soldAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setTicketId(s.id)}
                        >
                          {s.number}
                        </button>
                      </td>
                      <td className="text-right tabular-nums">{euro(s.total)}</td>
                    </tr>
                  ))}
                  {h.tickets.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted-foreground">
                        Aucun achat.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                <NoMatchRow state={ticketSort} total={h.tickets.length} />
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
      <TicketDialog id={ticketId} onClose={() => setTicketId(null)} />
    </div>
  );
}
