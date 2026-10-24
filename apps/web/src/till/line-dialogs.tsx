import { useEffect, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  formatQty,
  parseAmountToCents,
  parseQtyToMilli,
  percentDiscountCents,
  UNIT_LABELS,
  type SnapshotProduct,
} from '@episoft/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { type DraftLine } from './db';
import { lineCents } from './logic';

const eur = (c: number) => formatEuro(centsToDecimal(c));

export function WeightDialog({
  product,
  onClose,
  onConfirm,
}: {
  product: SnapshotProduct | null;
  onClose: () => void;
  onConfirm: (qtyMilli: number) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue('');
    setError(null);
  }, [product]);
  const unit = product?.unit ? UNIT_LABELS[product.unit] : '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = parseQtyToMilli(value);
    if (q === null || q <= 0) return setError('Quantité invalide (3 décimales au plus).');
    onConfirm(q);
  };
  return (
    <Dialog
      open={!!product}
      onClose={onClose}
      title={product?.name ?? ''}
      description={product ? `${formatEuro(product.salePrice)} / ${unit || 'unité'}` : undefined}
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label={`Quantité${unit ? ` (${unit})` : ''}`} error={error ?? undefined}>
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              autoFocus
              className="h-12 text-xl"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        {product && parseQtyToMilli(value) ? (
          <p className="text-lg">
            Montant :{' '}
            <strong>
              {eur(
                lineCents({
                  qtyMilli: parseQtyToMilli(value)!,
                  unitPriceCents: decimalToCents(product.salePrice),
                  discountCents: 0,
                  productId: '',
                  label: '',
                  catalogPriceCents: 0,
                }),
              )}
            </strong>
          </p>
        ) : null}
        <Button type="submit" size="lg">
          Ajouter au ticket
        </Button>
      </form>
    </Dialog>
  );
}

/** R-VTE-06 / R-VTE-07: quantity, price (traced as different from the catalogue) and discount. */
export function LineDialog({
  line,
  discountsEnabled,
  onClose,
  onSave,
}: {
  line: DraftLine | null;
  discountsEnabled: boolean;
  onClose: () => void;
  onSave: (l: DraftLine | null) => void;
}) {
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [discount, setDiscount] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (line) {
      setQty(formatQty(line.qtyMilli));
      setPrice(centsToDecimal(line.unitPriceCents).replace('.', ','));
      setDiscount(line.discountCents ? centsToDecimal(line.discountCents).replace('.', ',') : '');
      setError(null);
    }
  }, [line]);
  if (!line) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = parseQtyToMilli(qty);
    const p = parseAmountToCents(price);
    let d = 0;
    if (discount.trim().endsWith('%')) {
      const pct = Number(discount.replace('%', '').replace(',', '.'));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setError('Remise invalide.');
      d = percentDiscountCents({ qtyMilli: q ?? 0, unitPriceCents: p ?? 0 }, pct);
    } else if (discount.trim()) {
      d = parseAmountToCents(discount) ?? -1;
    }
    if (q === null || q <= 0) return setError('Quantité invalide.');
    if (p === null || p < 0) return setError('Prix invalide.');
    if (d < 0) return setError('Remise invalide.');
    const next = { ...line, qtyMilli: q, unitPriceCents: p, discountCents: d };
    if (lineCents(next) < 0) return setError('La remise dépasse le montant de la ligne.');
    onSave(next);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={line.label}
      description={`Prix catalogue : ${eur(line.catalogPriceCents)}`}
    >
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantité">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoFocus
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          <Field label="Prix unitaire (€)">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            )}
          </Field>
        </div>
        {discountsEnabled ? (
          <Field label="Remise" hint="En euros (2,50) ou en pourcentage (10 %).">
            {(p) => <Input {...p} value={discount} onChange={(e) => setDiscount(e.target.value)} />}
          </Field>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-between gap-2">
          <Button variant="outline" className="text-destructive" onClick={() => onSave(null)}>
            <Trash2 /> Supprimer la ligne
          </Button>
          <Button type="submit">Valider</Button>
        </div>
      </form>
    </Dialog>
  );
}
