import { useQuery } from '@tanstack/react-query';
import { WALLET_ENTRY_KIND_LABELS, type WalletEntryKind } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert } from '@/components/ui/form';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import { PushToggle } from './push-toggle';

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
    }[];
    tickets: { id: string; number: string; soldAt: string; total: string }[];
  } | null;
}

/** Self-service view of the member's own household: cagnotte, membership, recent purchases. */
export function MyHouseholdPage() {
  const { data, error } = useQuery({
    queryKey: ['my-household'],
    queryFn: () => api.get<Mine>('/me/household'),
  });
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
                    <th>Date</th>
                    <th>Opération</th>
                    <th className="text-right">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {h.wallet.map((w) => (
                    <tr key={w.id}>
                      <td>{formatDate(w.at)}</td>
                      <td>
                        {WALLET_ENTRY_KIND_LABELS[w.kind]}
                        {w.comment ? (
                          <span className="text-muted-foreground"> — {w.comment}</span>
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
                    <th>Date</th>
                    <th>Ticket</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {h.tickets.map((s) => (
                    <tr key={s.id}>
                      <td>{formatDate(s.soldAt)}</td>
                      <td>{s.number}</td>
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
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
