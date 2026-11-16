import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Alert, Input } from '@/components/ui/form';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { QueryError } from '../errors';

interface LotRow {
  id: string;
  code: string;
  name: string;
  supplierName: string | null;
  receiptNumber: string | null;
  lotNumber: string;
  bestBefore: string | null;
  qty: string;
  receivedOn: string;
}

interface Customer {
  id: string;
  number: number;
  name: string;
  email: string | null;
  phone: string | null;
}

interface LotReport {
  lot: LotRow & { supplierCode: string | null };
  soldQty: string;
  otherExitsQty: string;
  remainingQty: string;
  tickets: {
    saleId: string;
    number: string;
    soldAt: string;
    qty: string;
    member: Customer | null;
  }[];
  unexplainedExits: number;
  note: string;
}

interface Recall {
  members: (Customer & { tickets: { number: string; soldAt: string; qty: string }[] })[];
  emails: string[];
  withoutEmail: string[];
  anonymousTickets: number;
  anonymousQty: string;
  advice: string;
}

interface SaleReport {
  sale: { number: string; soldAt: string };
  lines: {
    productId: string;
    code: string;
    name: string;
    qty: string;
    lots: { lotId: string; lotNumber: string; bestBefore: string | null; qty: string }[];
    unexplainedQty: string;
  }[];
  note: string;
}

function LotDetail({ id }: { id: string }) {
  const [recall, setRecall] = useState(false);
  const report = useQuery({
    queryKey: ['lot', id],
    queryFn: () => api.get<LotReport>(`/traceability/lots/${id}`),
  });
  const list = useQuery({
    queryKey: ['lot-recall', id],
    queryFn: () => api.get<Recall>(`/traceability/lots/${id}/recall`),
    enabled: recall,
  });
  if (report.error) return <QueryError error={report.error} />;
  const r = report.data;
  if (!r) return <p className="text-muted-foreground">Chargement…</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Lot {r.lot.lotNumber} · {r.lot.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          Fournisseur : {r.lot.supplierName ?? '—'} · réception {r.lot.receiptNumber ?? '—'} du{' '}
          {formatDate(r.lot.receivedOn)} · date limite{' '}
          {r.lot.bestBefore ? formatDate(r.lot.bestBefore) : '—'}
        </p>
        <p>
          Reçu : {r.lot.qty} · vendu (estimé) : {r.soldQty} · autres sorties : {r.otherExitsQty} ·
          reste (estimé) : {r.remainingQty}
        </p>
        <Alert variant="info">{r.note}</Alert>
        {r.unexplainedExits ? (
          <Alert>
            {r.unexplainedExits} sortie(s) de stock de ce produit ne sont rattachées à aucun lot
            (stock antérieur à la saisie des lots).
          </Alert>
        ) : null}
        <Table exportName={`lot-${r.lot.lotNumber}`}>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Quantité</th>
              <th>Adhérent</th>
            </tr>
          </thead>
          <tbody>
            {r.tickets.map((t) => (
              <tr key={t.saleId + t.qty}>
                <td>{t.number}</td>
                <td>{formatDate(t.soldAt)}</td>
                <td>{t.qty}</td>
                <td>{t.member ? `${t.member.name} (n° ${t.member.number})` : 'Client de passage'}</td>
              </tr>
            ))}
            {r.tickets.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-muted-foreground">
                  Aucune vente rattachée à ce lot.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
        <div>
          <Button variant="outline" onClick={() => setRecall(true)} disabled={recall}>
            Préparer un rappel (adhérents à prévenir)
          </Button>
        </div>
        {list.error ? <QueryError error={list.error} /> : null}
        {list.data ? (
          <div className="grid gap-2">
            <p>
              {list.data.members.length} adhérent(s) concerné(s), {list.data.emails.length} avec un
              courriel. Consultation enregistrée dans le journal.
            </p>
            {list.data.emails.length ? (
              <label className="grid gap-1 text-xs">
                Courriels (à coller en copie cachée)
                <textarea
                  readOnly
                  className="rounded border p-2"
                  rows={3}
                  value={list.data.emails.join('; ')}
                />
              </label>
            ) : null}
            <Table exportName={`rappel-${r.lot.lotNumber}`}>
              <thead>
                <tr>
                  <th>Adhérent</th>
                  <th>Courriel</th>
                  <th>Téléphone</th>
                  <th>Tickets</th>
                </tr>
              </thead>
              <tbody>
                {list.data.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name} (n° {m.number})
                    </td>
                    <td>{m.email ?? '—'}</td>
                    <td>{m.email ? '' : (m.phone ?? '—')}</td>
                    <td>{m.tickets.map((t) => t.number).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p>
              Clients de passage : {list.data.anonymousTickets} ticket(s), {list.data.anonymousQty}{' '}
              vendu(s).
            </p>
            <Alert variant="info">{list.data.advice}</Alert>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SaleLookup() {
  const [ref, setRef] = useState('');
  const [asked, setAsked] = useState('');
  const q = useQuery({
    queryKey: ['trace-sale', asked],
    queryFn: () => api.get<SaleReport>(`/traceability/sales/${encodeURIComponent(asked)}`),
    enabled: !!asked,
    retry: false,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">D’une vente aux lots</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(ref.trim());
          }}
        >
          <Input
            aria-label="Numéro de ticket"
            placeholder="Numéro de ticket"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <Button type="submit">Chercher</Button>
        </form>
        {q.error ? <QueryError error={q.error} /> : null}
        {q.data ? (
          <>
            <Table exportName={`ticket-${q.data.sale.number}`}>
              <thead>
                <tr>
                  <th>Produit</th>
                  <th>Quantité</th>
                  <th>Lot(s) possible(s)</th>
                </tr>
              </thead>
              <tbody>
                {q.data.lines.map((l) => (
                  <tr key={l.productId}>
                    <td>{l.name}</td>
                    <td>{l.qty}</td>
                    <td>
                      {l.lots
                        .map(
                          (x) =>
                            `${x.lotNumber} (${x.qty}${x.bestBefore ? `, DLC ${formatDate(x.bestBefore)}` : ''})`,
                        )
                        .join(' ; ') || '—'}
                      {Number(l.unexplainedQty) > 0
                        ? ` · ${l.unexplainedQty} sans lot connu`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Alert variant="info">{q.data.note}</Alert>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Règlement CE 178/2002: from a lot to its customers, from a sale to its lots, and the recall helper. */
export function TraceabilityPage() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const lots = useQuery({
    queryKey: ['lots', q],
    queryFn: () => api.get<LotRow[]>(`/traceability/lots?${new URLSearchParams(q ? { q } : {})}`),
  });
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lots reçus</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Input
            aria-label="Rechercher un lot"
            placeholder="N° de lot, produit ou fournisseur"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {lots.error ? <QueryError error={lots.error} /> : null}
          <Table exportName="lots">
            <thead>
              <tr>
                <th>Reçu le</th>
                <th>Produit</th>
                <th>Lot</th>
                <th>DLC / DDM</th>
                <th>Fournisseur</th>
                <th>Quantité</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lots.data?.map((l) => (
                <tr key={l.id}>
                  <td>{formatDate(l.receivedOn)}</td>
                  <td>{l.name}</td>
                  <td>{l.lotNumber}</td>
                  <td>{l.bestBefore ? formatDate(l.bestBefore) : '—'}</td>
                  <td>{l.supplierName ?? '—'}</td>
                  <td>{l.qty}</td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(l.id)}>
                      Qui l’a acheté ?
                    </Button>
                  </td>
                </tr>
              ))}
              {lots.data?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted-foreground">
                    Aucun lot. Les lots s’enregistrent à la réception d’une commande.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </CardContent>
      </Card>
      {selected ? <LotDetail id={selected} /> : null}
      <SaleLookup />
    </div>
  );
}
