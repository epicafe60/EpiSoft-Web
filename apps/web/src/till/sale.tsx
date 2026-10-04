import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Ban,
  Pause,
  Play,
  Printer,
  ShoppingBasket,
  ScanLine,
  Trash2,
  UserRound,
  UserX,
  Wallet,
} from 'lucide-react';
import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  formatQty,
  decodeScaleBarcode,
  lookupProduct,
  productForPlu,
  scaleQuantityMilli,
  membershipState,
  walletAlert,
  normalizeSearch,
  parseAmountToCents,
  parseQtyToMilli,
  percentDiscountCents,
  provisionalNumber,
  sha256Hex,
  UNIT_LABELS,
  type SnapshotMember,
  type SnapshotProduct,
  type SyncOp,
} from '@episoft/shared';
import { todayIso, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { getMeta, tillDb, type Draft, type DraftLine } from './db';
import { useTill } from './context';
import { activeDraft, newDraft, parkDraft, resumeDraft, updateDraft } from './drafts';
import { addProduct, draftTotalCents, lineCents, saleOp } from './logic';
import { PreorderPickupDialog, type PickupOrder } from './preorders';
import { PaymentDialog, type PaymentResult } from './payment';
import { enqueue } from './sync';
import { TopupDialog } from './topup';
import { CashierSwitch } from './cashier';
import { Receipt } from './receipt';

const eur = (c: number) => formatEuro(centsToDecimal(c));

function useDraft(): Draft | undefined {
  // Makes sure a ticket is being entered (creates one if needed).
  useEffect(() => {
    void activeDraft();
  }, []);
  const activeId = useLiveQuery(() => getMeta('activeDraftId'), []);
  const draft = useLiveQuery(
    () => (activeId ? tillDb.drafts.get(activeId) : undefined),
    [activeId],
  );
  return draft && !draft.parked ? draft : undefined;
}

/** R-MBR-06 at the till: name, number or badge, from the local copy. */
function searchMembers(members: SnapshotMember[], q: string): SnapshotMember[] {
  const s = normalizeSearch(q);
  if (!s) return [];
  if (/^\d+$/.test(s)) return members.filter((m) => String(m.number) === s);
  const words = s.split(' ');
  return members
    .filter((m) => {
      const name = normalizeSearch(`${m.firstName} ${m.lastName}`);
      return words.every((w) => name.includes(w));
    })
    .slice(0, 12);
}

export function SalePage() {
  const { meta, settings, engine, cashierId, balanceCents } = useTill();
  const draft = useDraft();
  const products = useLiveQuery(() => tillDb.products.toArray(), []);
  const members = useLiveQuery(() => tillDb.members.toArray(), []);
  const households = useLiveQuery(() => tillDb.households.toArray(), []);
  const tabs = useLiveQuery(() => tillDb.posTabs.toArray(), []);
  const types = useLiveQuery(() => tillDb.membershipTypes.toArray(), []);
  const parked = useLiveQuery(() => tillDb.drafts.filter((d) => d.parked).toArray(), []);

  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState('');
  const [choices, setChoices] = useState<SnapshotProduct[]>([]);
  const [message, setMessage] = useState<{
    kind: 'error' | 'success' | 'info';
    text: string;
  } | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [weighing, setWeighing] = useState<SnapshotProduct | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [paying, setPaying] = useState(false);
  const [topup, setTopup] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [picking, setPicking] = useState(false);
  const [lastSale, setLastSale] = useState<Extract<SyncOp, { kind: 'SALE' }>['payload'] | null>(
    null,
  );

  const sellable = useMemo(
    () => (products ?? []).filter((p) => p.status === 'ACTIVE' || p.status === 'ON_ORDER'),
    [products],
  );
  const member = draft?.memberId
    ? ((members ?? []).find((m) => m.id === draft.memberId) ?? null)
    : null;
  const household = member?.householdId
    ? (households ?? []).find((h) => h.id === member.householdId)
    : undefined;
  const membership = membershipState(household?.membershipEnd ?? null, todayIso());
  const total = draft ? draftTotalCents(draft) : 0;
  const membershipProducts = new Set((types ?? []).map((t) => t.productId).filter(Boolean));
  const hasMembershipLine = !!draft?.lines.some((l) => membershipProducts.has(l.productId));
  const annual = (types ?? []).find((t) => t.code === 'ANNUAL' && t.active);
  const passing = (types ?? []).find((t) => t.code === 'PASSING' && t.active);

  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0);

  const addLine = async (p: SnapshotProduct, qtyMilli = 1000, weighed = false) => {
    if (!draft) return;
    if (p.saleMode !== 'UNIT' && !weighed && !weighing) {
      setWeighing(p);
      return;
    }
    await updateDraft(draft.id, (d) => ({ lines: addProduct(d.lines, p, qtyMilli) }));
    setMessage(null);
    setChoices([]);
    focusScan();
  };

  const selectMember = async (m: SnapshotMember | null) => {
    if (!draft) return;
    if (m && (m.status === 'INACTIVE' || m.status === 'ARCHIVED')) {
      // R-MBR-03: inactive or archived members cannot buy.
      setMessage({
        kind: 'error',
        text: `${m.firstName} ${m.lastName} est ${m.status === 'INACTIVE' ? 'inactif' : 'archivé'} et ne peut pas acheter.`,
      });
      return;
    }
    await updateDraft(draft.id, () => ({ memberId: m?.id ?? null }));
    setMemberQuery('');
    setMessage(null);
    focusScan();
  };

  /** R-VTE-03 + badge: EAN, code, member badge, then a name search to choose from. */
  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const q = scan.trim();
    setScan('');
    if (!q) return;
    if (!/^\d+$/.test(q) && q.length >= 10) {
      const hash = await sha256Hex(q);
      const m = (members ?? []).find((x) => x.qrTokenHash === hash);
      if (m) return selectMember(m);
    }
    if (settings?.scaleBarcodes) {
      const label = decodeScaleBarcode(q, settings.scaleBarcodes);
      if (label) {
        const p = productForPlu(sellable, label.plu);
        const qty = p ? scaleQuantityMilli(label, decimalToCents(p.salePrice), p.unit) : null;
        if (p && qty) return addLine(p, qty, true);
        setMessage({ kind: 'error', text: `Étiquette de balance : article ${label.plu} inconnu.` });
        return;
      }
    }
    const r = lookupProduct(sellable, q);
    if (r.kind === 'found') return addLine(r.product);
    if (r.kind === 'choices') {
      setChoices(r.products);
      return;
    }
    // CA §4.4: an unknown code never adds another product.
    setMessage({ kind: 'error', text: `Code inconnu : ${q}` });
  };

  const validate = async (r: PaymentResult) => {
    if (!draft || !meta.session || !meta.device) return;
    const opId = crypto.randomUUID();
    let number = '';
    const op = await enqueue(
      (deviceSeq) => {
        number = provisionalNumber(meta.device!.name, deviceSeq);
        return saleOp({
          id: opId,
          deviceSeq,
          draft,
          sessionId: meta.session!.id,
          cashierId,
          provisionalNumber: number,
          payments: r.payments,
          emailReceipt: r.emailReceipt,
          overdraftForcedBy: r.overdraftForcedBy,
          now: new Date(),
        });
      },
      // Same transaction: the ticket leaves the screen only once it is in the outbox (R-OFF-06).
      () => tillDb.drafts.delete(draft.id).then(() => undefined),
    );
    if (op.kind === 'SALE') setLastSale(op.payload);
    await newDraft();
    setPaying(false);
    const change = r.payments.reduce(
      (s, p) => s + (p.changeToWallet ? 0 : (p.changeCents ?? 0)),
      0,
    );
    setMessage({
      kind: 'success',
      text: `Ticket ${number} enregistré.${change ? ` Monnaie à rendre : ${eur(change)}.` : ''}`,
    });
    engine.kick();
    focusScan();
  };

  const startPayment = () => {
    if (!draft?.lines.length) return;
    if (!draft.memberId && settings && !settings.sellToNonMembers) {
      setMessage({
        kind: 'error',
        text: 'La vente aux non-adhérents est désactivée : choisissez un adhérent (R-VTE-02).',
      });
      return;
    }
    if (
      member &&
      membership !== 'VALID' &&
      settings?.membershipExpiredBlocking &&
      !hasMembershipLine
    ) {
      setMessage({
        kind: 'error',
        text: 'Adhésion expirée : ajoutez l’adhésion au ticket (R-ADH-03).',
      });
      return;
    }
    setPaying(true);
  };

  /** R-PRE-03: puts a pre-order into the current ticket; the sale then closes the order. */
  const collectPreorder = (order: PickupOrder) => {
    if (!draft) return;
    const missing: string[] = [];
    let lines = draft.lines;
    for (const l of order.lines) {
      const p = sellable.find((x) => x.id === l.productId);
      const qty = parseQtyToMilli(l.qty);
      if (p && qty) lines = addProduct(lines, p, qty);
      else missing.push(l.label);
    }
    void updateDraft(draft.id, () => ({ lines, memberId: order.memberId, preorderId: order.id }));
    setMessage(
      missing.length
        ? { kind: 'error', text: `Produits introuvables en caisse : ${missing.join(', ')}.` }
        : { kind: 'info', text: `Précommande ${order.number} ajoutée au ticket.` },
    );
  };

  // R-VTE-15 keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        scanRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        startPayment();
      } else if (e.key === 'F8') {
        e.preventDefault();
        if (draft?.lines.length) void parkDraft(draft.id);
      } else if (e.key === 'Escape' && document.activeElement === scanRef.current) {
        setScan('');
        setChoices([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!draft || !products || !members || !tabs)
    return <p className="p-6 text-muted-foreground">Chargement…</p>;

  const lastMember = lastSale?.memberId
    ? members.find((x) => x.id === lastSale.memberId)
    : undefined;
  const lastMemberName = lastMember ? `${lastMember.firstName} ${lastMember.lastName}` : null;
  const activeTabs = tabs.filter((t) => t.active).sort((a, b) => a.sort - b.sort);
  const currentTab = tab ?? activeTabs[0]?.id ?? null;
  const tabProducts = sellable
    .filter((p) => p.posTabId === currentTab)
    .sort((a, b) => a.posSort - b.posSort || a.name.localeCompare(b.name));
  const memberResults = searchMembers(members, memberQuery);
  const balance = household ? balanceCents(household.id) : null;
  const alert =
    balance === null
      ? null
      : walletAlert(balance, total, parseAmountToCents(settings?.overdraftLimit ?? '0') ?? 0);

  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[1fr_26rem]">
      {/* Entry zone */}
      <section aria-label="Saisie" className="flex min-h-0 flex-col gap-3">
        <form onSubmit={onScan} className="flex gap-2">
          <div className="relative flex-1">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={scanRef}
              autoFocus
              aria-label="Scanner ou rechercher un produit (F2)"
              placeholder="Scanner un code-barres, saisir un code ou un nom… (F2)"
              className="h-12 pl-10 text-lg"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="lg" className="h-12">
            OK
          </Button>
        </form>

        {message ? (
          <Alert
            variant={message.kind}
            className="flex flex-wrap items-center justify-between gap-2 text-base"
          >
            <span>{message.text}</span>
            {message.kind === 'success' && lastSale ? (
              <Button size="sm" variant="outline" onClick={() => window.print()}>
                <Printer /> Imprimer le ticket
              </Button>
            ) : null}
          </Alert>
        ) : null}

        {choices.length ? (
          <div
            className="grid gap-2 rounded-lg border bg-card p-2"
            role="listbox"
            aria-label="Produits trouvés"
          >
            <p className="px-1 text-sm text-muted-foreground">Choisissez le produit :</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {choices.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => void addLine(p)}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent"
                >
                  <span>{p.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatEuro(p.salePrice)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeTabs.length ? (
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
            <div
              className="flex gap-1 overflow-x-auto border-b p-1"
              role="tablist"
              aria-label="Onglets de caisse"
            >
              {activeTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={currentTab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'min-h-11 whitespace-nowrap rounded-md px-4 text-sm font-medium',
                    currentTab === t.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <div
              className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 overflow-y-auto p-2"
              role="tabpanel"
            >
              {tabProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void addLine(p)}
                  className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border bg-background p-2 text-center text-sm hover:border-primary hover:bg-accent"
                >
                  {p.imageId ? (
                    <img
                      src={`/api/v1/media/${p.imageId}`}
                      alt=""
                      className="size-12 object-contain"
                      loading="lazy"
                    />
                  ) : null}
                  <span className="line-clamp-2 font-medium leading-tight">
                    {p.posLabel || p.name}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatEuro(p.salePrice)}
                    {p.saleMode !== 'UNIT' && p.unit ? `/${UNIT_LABELS[p.unit]}` : ''}
                  </span>
                </button>
              ))}
              {tabProducts.length === 0 ? (
                <p className="col-span-full p-4 text-sm text-muted-foreground">
                  Aucun bouton dans cet onglet.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {parked && parked.length ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">En attente :</span>
            {parked.map((d) => (
              <Button key={d.id} variant="outline" size="sm" onClick={() => void resumeDraft(d.id)}>
                <Play /> {members.find((m) => m.id === d.memberId)?.lastName ?? 'Sans adhérent'} ·{' '}
                {eur(draftTotalCents(d))}
              </Button>
            ))}
          </div>
        ) : null}
      </section>

      {/* Ticket zone */}
      <section
        aria-label="Ticket en cours"
        className="flex min-h-0 flex-col gap-3 rounded-lg border bg-card p-3"
      >
        <div className="grid gap-2">
          {member ? (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  <UserRound className="mr-1 inline size-4" />
                  {member.firstName} {member.lastName}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    n° {member.number}
                  </span>
                </p>
                <p className="text-sm">
                  Cagnotte :{' '}
                  <strong
                    className={cn(
                      'tabular-nums',
                      balance !== null && balance < 0 && 'text-destructive',
                    )}
                  >
                    {balance !== null ? eur(balance) : '—'}
                  </strong>
                  {' · '}
                  {membership === 'VALID' ? (
                    <span className="text-success">
                      adhésion jusqu’au {formatDate(household?.membershipEnd)}
                    </span>
                  ) : (
                    <span className="font-medium text-destructive">
                      {membership === 'EXPIRED'
                        ? `adhésion expirée le ${formatDate(household?.membershipEnd)}`
                        : 'pas d’adhésion'}
                    </span>
                  )}
                </p>
                {alert ? (
                  <p
                    className="mt-1 text-sm font-medium text-warning"
                    data-testid="wallet-alert"
                  >
                    {alert === 'NEGATIVE'
                      ? 'Cagnotte négative : proposez un versement.'
                      : alert === 'INSUFFICIENT'
                        ? 'Cagnotte insuffisante pour ce ticket : proposez un versement ou un autre paiement.'
                        : 'Cagnotte basse : proposez un versement.'}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-1">
                {household ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Versement sur la cagnotte"
                    onClick={() => setTopup(true)}
                  >
                    <Wallet />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Retirer l’adhérent"
                  onClick={() => void selectMember(null)}
                >
                  <UserX />
                </Button>
              </div>
            </div>
          ) : (
            <div className="relative">
              <Input
                aria-label="Adhérent : nom, numéro ou badge"
                placeholder="Adhérent : nom, n° ou badge…"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              {memberResults.length ? (
                <ul
                  className="absolute z-10 mt-1 grid w-full gap-0.5 rounded-md border bg-card p-1 shadow-lg"
                  role="listbox"
                  aria-label="Adhérents trouvés"
                >
                  {memberResults.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => void selectMember(m)}
                        className={cn(
                          'flex min-h-11 w-full items-center justify-between rounded px-2 text-left text-sm hover:bg-accent',
                          (m.status === 'INACTIVE' || m.status === 'ARCHIVED') &&
                            'text-muted-foreground line-through',
                        )}
                      >
                        <span>
                          {m.lastName} {m.firstName}
                        </span>
                        <span className="text-xs text-muted-foreground">n° {m.number}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {member && membership !== 'VALID' && annual?.productId && !hasMembershipLine ? (
            <Alert variant="info" className="flex items-center justify-between gap-2">
              <span>Adhésion à renouveler (R-ADH-03).</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const p = products.find((x) => x.id === annual.productId);
                  if (p) void addLine(p);
                }}
              >
                Ajouter {annual.label.toLowerCase()} ({formatEuro(annual.price)})
              </Button>
            </Alert>
          ) : null}
          {!member &&
          draft.lines.length > 0 &&
          passing?.productId &&
          !hasMembershipLine &&
          settings?.sellToNonMembers ? (
            <Alert variant="info" className="flex items-center justify-between gap-2">
              <span>Client sans adhésion.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const p = products.find((x) => x.id === passing.productId);
                  if (p) void addLine(p);
                }}
              >
                Adhésion de passage ({formatEuro(passing.price)})
              </Button>
            </Alert>
          ) : null}
        </div>

        <ol
          className="min-h-0 flex-1 divide-y overflow-y-auto rounded-md border"
          aria-label="Lignes du ticket"
        >
          {draft.lines.length === 0 ? (
            <li className="p-4 text-center text-sm text-muted-foreground">
              Ticket vide. Scannez un produit.
            </li>
          ) : null}
          {draft.lines.map((l, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setEditing(i)}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate">{l.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatQty(l.qtyMilli)} × {eur(l.unitPriceCents)}
                    {l.unitPriceCents !== l.catalogPriceCents ? ' (prix modifié)' : ''}
                    {l.discountCents ? ` − remise ${eur(l.discountCents)}` : ''}
                  </span>
                </span>
                <span className="font-medium tabular-nums">{eur(lineCents(l))}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="flex items-baseline justify-between">
          <span className="text-lg">Total</span>
          <span className="text-3xl font-bold tabular-nums" data-testid="ticket-total">
            {eur(total)}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => void parkDraft(draft.id)}
            disabled={!draft.lines.length}
            title="F8"
          >
            <Pause /> Attente
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              if (window.confirm('Annuler ce ticket ?'))
                void updateDraft(draft.id, () => ({ lines: [], memberId: null, preorderId: null }));
            }}
            disabled={!draft.lines.length && !draft.memberId}
          >
            <Ban /> Annuler
          </Button>
          <Button size="lg" onClick={startPayment} disabled={!draft.lines.length} title="F4">
            Encaisser
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPicking(true)}
          className="justify-self-start"
        >
          <ShoppingBasket /> Précommandes
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSwitching(true)}
          className="justify-self-start"
        >
          Changer de caissier (badge)
        </Button>
      </section>

      <PreorderPickupDialog
        open={picking}
        onClose={() => setPicking(false)}
        onPick={collectPreorder}
      />
      <WeightDialog
        product={weighing}
        onClose={() => {
          setWeighing(null);
          focusScan();
        }}
        onConfirm={async (qty) => {
          const p = weighing!;
          setWeighing(null);
          await updateDraft(draft.id, (d) => ({ lines: addProduct(d.lines, p, qty) }));
          focusScan();
        }}
      />
      <LineDialog
        line={editing !== null ? (draft.lines[editing] ?? null) : null}
        discountsEnabled={!!settings?.discountsEnabled}
        onClose={() => {
          setEditing(null);
          focusScan();
        }}
        onSave={async (l) => {
          const i = editing!;
          setEditing(null);
          await updateDraft(draft.id, (d) => ({
            lines: l ? d.lines.map((x, j) => (j === i ? l : x)) : d.lines.filter((_, j) => j !== i),
          }));
          focusScan();
        }}
      />
      <PaymentDialog
        open={paying}
        totalCents={total}
        member={member}
        onClose={() => {
          setPaying(false);
          focusScan();
        }}
        onConfirm={validate}
      />
      {household && member ? (
        <TopupDialog
          open={topup}
          onClose={() => {
            setTopup(false);
            focusScan();
          }}
          householdId={household.id}
          member={member}
        />
      ) : null}
      <Receipt
        sale={lastSale}
        associationName={settings?.associationName ?? 'Épicafé'}
        memberName={lastMemberName}
      />
      <CashierSwitch
        open={switching}
        onClose={() => {
          setSwitching(false);
          focusScan();
        }}
      />
    </div>
  );
}

/** R-VTE-04: quantity pad for products sold by weight or volume, 3 decimals. */
function WeightDialog({
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
function LineDialog({
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
