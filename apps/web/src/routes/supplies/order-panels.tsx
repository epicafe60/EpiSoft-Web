import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, PackageCheck, Pencil, Send, Trash2 } from 'lucide-react';
import {
  centsToDecimal,
  formatQty,
  inclFromExcl4,
  margin,
  orderTotals,
  parsePrice4,
  parseQtyToMilli,
  purchasePriceFlag,
  salePriceForMarkup,
  type MailSender,
  type PriceRounding,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { MailPreview } from '@/components/mail-preview';
import { useThresholds } from '@/lib/thresholds';
import { euro, todayIso } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/confirm';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Textarea } from '@/components/ui/inputs';
import { ProductPicker } from '@/components/product-picker';
import { type OrderDetail } from '@/lib/types-supplies';

interface EditLine {
  productId: string;
  code: string;
  name: string;
  qty: string;
  unitPriceExcl: string;
  vatRate: string;
}

/** R-EVO-10: what the supplier's reference list says about a product (stock, suggestion). */
interface SupplierProduct {
  productId: string;
  code: string;
  name: string;
  unit: string | null;
  stockQty: string;
  minStock: string | null;
  purchasePriceExcl: string;
  vatRate: string;
  suggestedQty: string;
}

const trimPrice = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

export function Totals({
  ht,
  vat,
  ttc,
  span,
}: {
  ht: string;
  vat: string;
  ttc: string;
  span: number;
}) {
  return (
    <tfoot className="text-sm">
      <tr className="border-t">
        <td colSpan={span} className="text-right text-muted-foreground">
          Total HT
        </td>
        <td className="text-right tabular-nums">{euro(ht)}</td>
      </tr>
      <tr>
        <td colSpan={span} className="text-right text-muted-foreground">
          TVA
        </td>
        <td className="text-right tabular-nums">{euro(vat)}</td>
      </tr>
      <tr className="font-semibold">
        <td colSpan={span} className="text-right">
          Total TTC
        </td>
        <td className="text-right tabular-nums">{euro(ttc)}</td>
      </tr>
    </tfoot>
  );
}

/** R-CMD-01/02: editable quantities and purchase prices, totals per line then cumulated. */
export function DraftEditor({
  order,
  onSaved,
}: {
  order: OrderDetail;
  onSaved: () => Promise<unknown>;
}) {
  const [lines, setLines] = useState<EditLine[]>([]);
  const [comment, setComment] = useState(order.comment ?? '');
  const [onlyOrdered, setOnlyOrdered] = useState(false);
  // R-EVO-10: all the supplier's references are listed, with their stock, to type a quantity.
  const supplierProducts = useQuery({
    queryKey: ['order-supplier-products', order.id],
    queryFn: () => api.get<SupplierProduct[]>(`/purchase-orders/${order.id}/supplier-products`),
  });
  const info = useMemo(
    () => new Map((supplierProducts.data ?? []).map((p) => [p.productId, p])),
    [supplierProducts.data],
  );
  useEffect(() => {
    const ordered: EditLine[] = order.lines.map((l) => ({
      productId: l.productId,
      code: l.code,
      name: l.name,
      qty: formatQty(parseQtyToMilli(l.qtyOrdered)!),
      unitPriceExcl: trimPrice(l.unitPriceExcl),
      vatRate: l.vatRate,
    }));
    const have = new Set(ordered.map((l) => l.productId));
    const others: EditLine[] = (supplierProducts.data ?? [])
      .filter((p) => !have.has(p.productId))
      .map((p) => ({
        productId: p.productId,
        code: p.code,
        name: p.name,
        qty: '',
        unitPriceExcl: trimPrice(p.purchasePriceExcl),
        vatRate: p.vatRate,
      }));
    setLines([...ordered, ...others].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    setComment(order.comment ?? '');
  }, [order, supplierProducts.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/purchase-orders/${order.id}`, {
        comment,
        // Lines left empty or at zero are not recorded (R-EVO-10).
        lines: lines
          .filter((l) => (parseQtyToMilli(l.qty || '0') ?? 0) > 0)
          .map((l) => ({
            productId: l.productId,
            qty: l.qty,
            unitPriceExcl: l.unitPriceExcl || '0',
          })),
      }),
    onSuccess: onSaved,
  });
  const totals = useMemo(
    () =>
      orderTotals(
        lines.map((l) => ({
          qtyMilli: parseQtyToMilli(l.qty || '0') ?? 0,
          unitPriceExcl4: parsePrice4(l.unitPriceExcl || '0') ?? 0,
          vatRate: l.vatRate,
        })),
      ),
    [lines],
  );
  const set = (i: number, patch: Partial<EditLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const min = order.supplier?.minOrderAmount;
  const shown = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !onlyOrdered || (parseQtyToMilli(l.qty || '0') ?? 0) > 0);
  const fillSuggested = () =>
    setLines(
      lines.map((l) => {
        const sg = info.get(l.productId)?.suggestedQty;
        return !l.qty && sg && sg !== '0.000' ? { ...l, qty: formatQty(parseQtyToMilli(sg)!) } : l;
      }),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lignes de la commande</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ProductPicker
          onPick={(p) => {
            if (lines.some((l) => l.productId === p.id)) return;
            setLines([
              ...lines,
              {
                productId: p.id,
                code: p.code,
                name: p.name,
                qty: '1',
                unitPriceExcl: '0',
                vatRate: '5.50',
              },
            ]);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={fillSuggested}>
            Remplir les quantités suggérées
          </Button>
          <div className="flex items-center gap-2">
            <Checkbox
              id="only-ordered"
              checked={onlyOrdered}
              onChange={(e) => setOnlyOrdered(e.target.checked)}
            />
            <Label htmlFor="only-ordered" className="font-normal">
              Seulement les lignes commandées
            </Label>
          </div>
        </div>
        <Table className="stack-rows">
          <thead>
            <tr>
              <th>Produit</th>
              <th className="w-20 text-right">Stock</th>
              <th className="w-20 text-right">Mini</th>
              <th className="w-28 text-right">Qté commandée</th>
              <th className="w-32 text-right">PA HT</th>
              <th className="text-right">Total HT</th>
              <th className="w-0" />
            </tr>
          </thead>
          <tbody>
            {shown.map(({ l, i }) => (
              <tr key={l.productId}>
                <td data-wide>
                  <span className="text-muted-foreground">{l.code}</span> {l.name}
                </td>
                <td className="text-right tabular-nums" data-label="Stock">
                  {info.has(l.productId)
                    ? formatQty(parseQtyToMilli(info.get(l.productId)!.stockQty)!)
                    : '—'}
                </td>
                <td className="text-right tabular-nums" data-label="Mini">
                  {info.get(l.productId)?.minStock
                    ? formatQty(parseQtyToMilli(info.get(l.productId)!.minStock!)!)
                    : '—'}
                </td>
                <td data-label="Quantité">
                  <Input
                    aria-label={`Quantité ${l.name}`}
                    inputMode="decimal"
                    className="text-right"
                    value={l.qty}
                    onChange={(e) => set(i, { qty: e.target.value })}
                  />
                </td>
                <td data-label="PA HT">
                  <Input
                    aria-label={`PA HT ${l.name}`}
                    inputMode="decimal"
                    className="text-right"
                    value={l.unitPriceExcl}
                    onChange={(e) => set(i, { unitPriceExcl: e.target.value })}
                  />
                </td>
                <td className="text-right tabular-nums" data-label="Total HT">
                  {euro(
                    centsToDecimal(
                      orderTotals([
                        {
                          qtyMilli: parseQtyToMilli(l.qty || '0') ?? 0,
                          unitPriceExcl4: parsePrice4(l.unitPriceExcl || '0') ?? 0,
                          vatRate: l.vatRate,
                        },
                      ]).exclCents,
                    ),
                  )}
                </td>
                <td data-actions>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Retirer ${l.name}`}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <Totals
            ht={centsToDecimal(totals.exclCents)}
            vat={centsToDecimal(totals.vatCents)}
            ttc={centsToDecimal(totals.inclCents)}
            span={5}
          />
        </Table>
        {min && totals.exclCents < Math.round(Number(min) * 100) ? (
          <Alert variant="info">Minimum de commande du fournisseur : {euro(min)} HT.</Alert>
        ) : null}
        <Field label="Commentaire">
          {(p) => <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </Field>
        {save.error ? <Alert>{save.error.message}</Alert> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Enregistrer
          </Button>
          {save.isSuccess ? <span className="text-sm text-success">Enregistré.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * R-CMD-04, R-EVO-14: « Rédaction d'email » as in the previous application: the recipient, the
 * subject and the text can be changed, then the mail leaves from the application's own account
 * (the server's SMTP) with the order form in PDF attached. No mail client is opened.
 */
export function SendDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const sender = useQuery({
    queryKey: ['mail-sender'],
    queryFn: () => api.get<MailSender>('/mail/sender'),
    enabled: open,
  });
  useEffect(() => {
    if (open) {
      setPreviewing(false);
      setTo(order.supplier?.email ?? '');
      setSubject(`Commande ${order.number} d’Épicafé de Montjavoult`);
      // Like the window of the previous application: the text can be edited before it leaves.
      const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      setMessage(
        `Bonjour,\nVeuillez trouver ci-joint notre commande ${order.number} du ${now}.\n\n\nBien cordialement !\nL’équipe Épicafé de Montjavoult`,
      );
    }
  }, [open, order]);
  const confirm = useConfirm();
  /** Under the supplier's minimum order the delivery may be refused or charged: ask first. */
  const confirmSend = async () => {
    const min = order.supplier?.minOrderAmount;
    if (min && Number(order.totalExcl) < Number(min)) {
      const ok = await confirm({
        title: 'Commande sous le minimum du fournisseur',
        message: `Cette commande fait ${euro(order.totalExcl)} HT, le fournisseur demande au moins ${euro(min)} HT. Il peut la refuser ou facturer le transport.`,
        confirmLabel: 'Envoyer quand même',
      });
      if (!ok) return;
    }
    send.mutate();
  };
  const send = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${order.id}/send`, { to, subject, message }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  const warning = sender.data
    ? !sender.data.sendingEnabled
      ? 'L’envoi des courriels est désactivé dans l’administration : ce courriel sera enregistré dans le journal comme « Non envoyé » et ne partira pas.'
      : !sender.data.smtpConfigured
        ? 'Le compte d’envoi (SMTP) n’est pas configuré sur le serveur : le courriel restera « En attente ».'
        : null
    : null;
  if (previewing)
    return (
      <Dialog open={open} onClose={onClose} title="Aperçu du courriel" className="max-w-2xl">
        <div className="grid gap-3">
          <MailPreview
            from={sender.data?.from ?? ''}
            to={to}
            subject={subject}
            text={message}
            attachments={[
              {
                filename: `${order.number}.pdf`,
                contentType: 'application/pdf',
                href: `/api/v1/purchase-orders/${order.id}/pdf`,
              },
            ]}
          />
          {warning ? <Alert variant="info">{warning}</Alert> : null}
          {send.error ? <Alert>{send.error.message}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPreviewing(false)}>
              <Pencil /> Modifier
            </Button>
            <Button onClick={() => void confirmSend()} disabled={!to || send.isPending}>
              <Send /> Envoyer
            </Button>
          </div>
        </div>
      </Dialog>
    );
  return (
    <Dialog open={open} onClose={onClose} title="Rédaction d’email" className="max-w-xl">
      <div className="grid gap-3">
        <Field
          label="Adresse du destinataire"
          hint={
            order.supplier?.email
              ? undefined
              : 'Le fournisseur n’a pas de courriel : saisissez une adresse.'
          }
        >
          {(p) => <Input {...p} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field label="Sujet du message">
          {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}
        </Field>
        <Field label="Message" hint="Le bon de commande (PDF) est joint automatiquement.">
          {(p) => (
            <Textarea
              {...p}
              className="min-h-48"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          )}
        </Field>
        {warning ? <Alert variant="info">{warning}</Alert> : null}
        {send.error ? <Alert>{send.error.message}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="outline" onClick={() => setPreviewing(true)}>
            <Eye /> Aperçu
          </Button>
          <Button onClick={() => void confirmSend()} disabled={!to || send.isPending}>
            <Send /> Envoyer
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface ReceiveLine {
  orderLineId: string | null;
  productId: string;
  name: string;
  /** Last known purchase price of the product, to warn when the new one jumps. */
  previousPrice: string | null;
  remaining: string;
  qty: string;
  unitPriceExcl: string;
  vatRate: string;
  salePrice: string;
  newSalePrice: string;
  bestBefore: string;
}

/**
 * R-CMD-05/06: quantity received prefilled with what is still expected, actual purchase
 * price, unordered products can be added; a new selling price is suggested from the target
 * margin when the purchase price changes.
 */
export function ReceiveDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const pricing = useQuery({
    queryKey: ['pricing'],
    queryFn: () =>
      api.get<{ targetMarkupPct: number; rounding: PriceRounding }>('/catalog/pricing'),
    enabled: open,
  });
  const thresholds = useThresholds(open);
  const [lines, setLines] = useState<ReceiveLine[]>([]);
  const [checked, setChecked] = useState(false);
  const [closeOrder, setCloseOrder] = useState(false);
  const [date, setDate] = useState(todayIso());
  useEffect(() => {
    if (!open) return;
    setDate(todayIso());
    setCloseOrder(false);
    setChecked(false);
    setLines(
      order.lines.map((l) => {
        const remaining = Math.max(
          0,
          parseQtyToMilli(l.qtyOrdered)! - parseQtyToMilli(l.qtyReceived)!,
        );
        return {
          orderLineId: l.id,
          productId: l.productId,
          name: l.name,
          previousPrice: l.purchasePriceExcl,
          remaining: formatQty(remaining),
          qty: remaining ? formatQty(remaining) : '',
          unitPriceExcl: Number(l.unitPriceExcl).toString(),
          vatRate: l.vatRate,
          salePrice: l.salePrice,
          newSalePrice: '',
          bestBefore: '',
        };
      }),
    );
  }, [open, order]);
  const set = (i: number, patch: Partial<ReceiveLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  /** What looks wrong on a line being received: a price that jumped, 0 €, more than ordered. */
  const warningsOf = (l: ReceiveLine): string[] => {
    if ((parseQtyToMilli(l.qty || '0') ?? 0) <= 0) return [];
    const out: string[] = [];
    const next4 = parsePrice4(l.unitPriceExcl || '0') ?? 0;
    if (next4 === 0) out.push('Prix d’achat à 0 €.');
    const flag = purchasePriceFlag(
      l.previousPrice === null ? null : parsePrice4(l.previousPrice),
      next4,
      thresholds,
    );
    if (flag.flagged && l.previousPrice !== null)
      out.push(
        `Prix d’achat ${Number(l.previousPrice)} € → ${l.unitPriceExcl} € (${flag.pct! > 0 ? '+' : ''}${Math.round(flag.pct!)} %).`,
      );
    if (l.orderLineId && (parseQtyToMilli(l.qty) ?? 0) > (parseQtyToMilli(l.remaining) ?? 0))
      out.push(`Plus que prévu : ${l.remaining} attendu(s).`);
    return out;
  };
  const anyWarning = lines.some((l) => warningsOf(l).length > 0);
  const receive = useMutation({
    mutationFn: () => {
      const received = lines.filter((l) => (parseQtyToMilli(l.qty || '0') ?? 0) > 0);
      return api.post(`/purchase-orders/${order.id}/receipts`, {
        date,
        closeOrder,
        lines: received.map((l) => ({
          orderLineId: l.orderLineId,
          productId: l.productId,
          qty: l.qty,
          unitPriceExcl: l.unitPriceExcl,
          bestBefore: l.bestBefore || null,
        })),
        newSalePrices: Object.fromEntries(
          received.filter((l) => l.newSalePrice).map((l) => [l.productId, l.newSalePrice]),
        ),
      });
    },
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Réception — ${order.number}`}
      className="max-w-4xl"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Date de réception">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <ProductPicker
            placeholder="Ajouter un produit reçu non commandé…"
            onPick={(p) =>
              setLines([
                ...lines,
                {
                  orderLineId: null,
                  productId: p.id,
                  name: p.name,
                  previousPrice: null,
                  remaining: '—',
                  qty: '1',
                  unitPriceExcl: '0',
                  vatRate: '5.50',
                  salePrice: p.salePrice,
                  newSalePrice: '',
                  bestBefore: '',
                },
              ])
            }
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          <Table className="stack-rows">
            <thead>
              <tr>
                <th>Produit</th>
                <th className="text-right">Attendu</th>
                <th className="w-24 text-right">Reçu</th>
                <th className="w-28 text-right">PA HT réel</th>
                <th className="w-36">DLC (option)</th>
                <th className="w-44">Nouveau PV</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const excl4 = parsePrice4(l.unitPriceExcl || '0') ?? 0;
                const incl4 = inclFromExcl4(excl4, l.vatRate);
                const current = margin(Math.round(Number(l.salePrice) * 100), incl4);
                const suggested = pricing.data
                  ? salePriceForMarkup(incl4, pricing.data.targetMarkupPct, pricing.data.rounding)
                  : null;
                return (
                  <tr key={`${l.productId}-${i}`}>
                    <td data-wide>
                      {l.name}
                      {warningsOf(l).map((w) => (
                        <span key={w} className="block text-xs font-medium text-destructive">
                          {w}
                        </span>
                      ))}
                      <span className="block text-xs text-muted-foreground">
                        PV {euro(l.salePrice)}
                        {current ? ` · marque ${current.ratePct.toLocaleString('fr-FR')} %` : ''}
                      </span>
                    </td>
                    <td className="text-right tabular-nums" data-label="Attendu">
                      {l.remaining}
                    </td>
                    <td data-label="Reçu">
                      <Input
                        aria-label={`Quantité reçue ${l.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={l.qty}
                        onChange={(e) => set(i, { qty: e.target.value })}
                      />
                    </td>
                    <td data-label="PA HT réel">
                      <Input
                        aria-label={`PA HT ${l.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={l.unitPriceExcl}
                        onChange={(e) => set(i, { unitPriceExcl: e.target.value })}
                      />
                    </td>
                    <td data-label="DLC (option)">
                      <Input
                        aria-label={`DLC ${l.name}`}
                        type="date"
                        value={l.bestBefore}
                        onChange={(e) => set(i, { bestBefore: e.target.value })}
                      />
                    </td>
                    <td data-label="Nouveau PV" data-wide>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Nouveau PV ${l.name}`}
                          inputMode="decimal"
                          className="text-right"
                          placeholder="inchangé"
                          value={l.newSalePrice}
                          onChange={(e) => set(i, { newSalePrice: e.target.value })}
                        />
                        {suggested && suggested !== Math.round(Number(l.salePrice) * 100) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Prix suggéré selon la marge cible"
                            onClick={() => set(i, { newSalePrice: centsToDecimal(suggested) })}
                          >
                            {euro(centsToDecimal(suggested))}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="close-order"
            checked={closeOrder}
            onChange={(e) => setCloseOrder(e.target.checked)}
          />
          <Label htmlFor="close-order" className="font-normal">
            Solder la commande : ne pas attendre le reliquat
          </Label>
        </div>
        {anyWarning ? (
          <div className="grid gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
            <p className="font-medium">
              Des lignes sortent de l’ordinaire (en rouge ci-dessus). Le prix d’achat reçu remplace
              l’ancien : vérifiez le bon de livraison.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="receipt-checked"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <Label htmlFor="receipt-checked" className="font-normal">
                J’ai vérifié les prix et les quantités avec le bon de livraison
              </Label>
            </div>
          </div>
        ) : null}
        {receive.error ? <Alert>{receive.error.message}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            onClick={() => receive.mutate()}
            disabled={receive.isPending || (anyWarning && !checked)}
          >
            <PackageCheck /> Valider la réception
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface ReceiptDetail {
  number: string;
  lines: { id: string; name: string; qty: string; unitPriceExcl: string }[];
}

/** R-EVO-11: a manager corrects a validated receipt; the stock follows (CORRECTION movement). */
export function CorrectReceiptDialog({
  id,
  onClose,
  onDone,
}: {
  id: string | null;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { data } = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => api.get<ReceiptDetail>(`/receipts/${id}`),
    enabled: !!id,
  });
  const [rows, setRows] = useState<Record<string, { qty: string; price: string }>>({});
  useEffect(() => {
    if (data)
      setRows(
        Object.fromEntries(
          data.lines.map((l) => [
            l.id,
            { qty: formatQty(parseQtyToMilli(l.qty)!), price: Number(l.unitPriceExcl).toString() },
          ]),
        ),
      );
  }, [data]);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/receipts/${id}/correct`, {
        lines: Object.entries(rows).map(([lineId, r]) => ({
          lineId,
          qty: r.qty || '0',
          unitPriceExcl: r.price || '0',
        })),
      }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog
      open={!!id}
      onClose={onClose}
      title={data ? `Corriger la réception ${data.number}` : 'Corriger la réception'}
      description="Le stock est ajusté de la différence et la correction est journalisée."
      className="max-w-2xl"
    >
      {data ? (
        <div className="grid gap-3">
          <Table>
            <thead>
              <tr>
                <th>Produit</th>
                <th className="w-28 text-right">Qté reçue</th>
                <th className="w-28 text-right">PA HT</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>
                    <Input
                      aria-label={`Qté corrigée ${l.name}`}
                      inputMode="decimal"
                      className="text-right"
                      value={rows[l.id]?.qty ?? ''}
                      onChange={(e) =>
                        setRows({ ...rows, [l.id]: { ...rows[l.id]!, qty: e.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <Input
                      aria-label={`PA HT corrigé ${l.name}`}
                      inputMode="decimal"
                      className="text-right"
                      value={rows[l.id]?.price ?? ''}
                      onChange={(e) =>
                        setRows({ ...rows, [l.id]: { ...rows[l.id]!, price: e.target.value } })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {save.error ? <Alert>{save.error.message}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Enregistrer la correction
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">Chargement…</p>
      )}
    </Dialog>
  );
}
