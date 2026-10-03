import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { QueryError } from './errors';

interface SalesBlock {
  key: 'day' | 'week' | 'month' | 'year';
  cents: number;
  previousCents: number;
  variationPercent: number | null;
  tickets: number;
  averageBasketCents: number;
}

interface DashboardData {
  sales?: SalesBlock[];
  payments?: { method: string; cents: number }[];
  topProducts?: { productId: string; label: string; qty: string; cents: number }[];
  lowStock?: { id: string; code: string; name: string; stock: string; min: string }[];
  labelsToPrint?: number;
  invoicesDue?: {
    id: string;
    supplier: string;
    pieceRef: string;
    dueDate: string;
    cents: number;
    late: boolean;
  }[];
  membershipsExpiring?: { householdId: string; number: number; name: string; endDate: string }[];
}

const PERIOD_LABELS = {
  day: 'Aujourd’hui',
  week: 'Semaine',
  month: 'Mois',
  year: 'Année',
} as const;
const METHOD_LABELS: Record<string, string> = {
  CASH: 'Espèces',
  CHEQUE: 'Chèques',
  CARD: 'Carte',
  WALLET: 'Cagnotte',
  TRANSFER: 'Virement',
};
const cents = (c: number) => euro(c / 100);

/** R-STA-02: the figures of the day, shown to the roles that use them. */
export function Dashboard() {
  const { data, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/stats/dashboard'),
    refetchInterval: 5 * 60_000,
  });
  if (error) return <QueryError error={error} />;
  if (!data) return null;
  return (
    <div className="mb-6 grid gap-4">
      {data.sales ? (
        <section
          aria-label="Chiffre d’affaires"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {data.sales.map((s) => (
            <Card key={s.key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {PERIOD_LABELS[s.key]}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">{cents(s.cents)}</p>
                <p className="text-xs text-muted-foreground">
                  {s.tickets} ticket{s.tickets > 1 ? 's' : ''} · panier moyen{' '}
                  {cents(s.averageBasketCents)}
                </p>
                <p className="text-xs text-muted-foreground">
                  N−1 : {cents(s.previousCents)}
                  {s.variationPercent !== null ? (
                    <span className={s.variationPercent >= 0 ? ' text-green-700' : ' text-red-700'}>
                      {' '}
                      ({s.variationPercent > 0 ? '+' : ''}
                      {String(s.variationPercent).replace('.', ',')} %)
                    </span>
                  ) : null}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.payments ? (
          <Panel title="Ventes du mois par mode de paiement" empty={data.payments.length === 0}>
            {data.payments.map((p) => (
              <tr key={p.method}>
                <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                <td className="text-right tabular-nums">{cents(p.cents)}</td>
              </tr>
            ))}
          </Panel>
        ) : null}
        {data.topProducts ? (
          <Panel title="Meilleures ventes du mois" empty={data.topProducts.length === 0}>
            {data.topProducts.map((p) => (
              <tr key={p.productId}>
                <td>{p.label}</td>
                <td className="text-right tabular-nums">{p.qty.replace(/\.?0+$/, '')}</td>
                <td className="text-right tabular-nums">{cents(p.cents)}</td>
              </tr>
            ))}
          </Panel>
        ) : null}
        {data.lowStock ? (
          <Panel
            title="Produits sous le stock minimum"
            empty={data.lowStock.length === 0}
            extra={
              data.labelsToPrint ? (
                <Link to="/catalogue/etiquettes">
                  <Badge variant="muted">{data.labelsToPrint} étiquette(s) à imprimer</Badge>
                </Link>
              ) : null
            }
          >
            {data.lowStock.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to="/catalogue/$id" params={{ id: p.id }} className="hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="text-right tabular-nums">
                  {p.stock.replace(/\.?0+$/, '')} / {p.min.replace(/\.?0+$/, '')}
                </td>
              </tr>
            ))}
          </Panel>
        ) : null}
        {data.invoicesDue ? (
          <Panel title="Factures à payer (7 jours)" empty={data.invoicesDue.length === 0}>
            {data.invoicesDue.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.supplier} · {i.pieceRef}
                </td>
                <td className={i.late ? 'font-medium text-red-700' : ''}>
                  {formatDate(i.dueDate)}
                </td>
                <td className="text-right tabular-nums">{cents(i.cents)}</td>
              </tr>
            ))}
          </Panel>
        ) : null}
        {data.membershipsExpiring ? (
          <Panel
            title="Adhésions qui se terminent (30 jours)"
            empty={data.membershipsExpiring.length === 0}
          >
            {data.membershipsExpiring.map((m) => (
              <tr key={m.householdId}>
                <td>
                  <Link to="/foyers/$id" params={{ id: m.householdId }} className="hover:underline">
                    Foyer {m.number} · {m.name}
                  </Link>
                </td>
                <td className="text-right">{formatDate(m.endDate)}</td>
              </tr>
            ))}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Panel({
  title,
  empty,
  extra,
  children,
}: {
  title: string;
  empty: boolean;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {extra}
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">Rien à signaler.</p>
        ) : (
          <Table>
            <tbody>{children}</tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
