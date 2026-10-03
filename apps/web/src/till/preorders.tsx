import { useQuery } from '@tanstack/react-query';
import { PREORDER_STATUS_LABELS, type PreorderStatus } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/form';

interface OpenOrder {
  id: string;
  number: string;
  status: PreorderStatus;
  pickupDate: string;
  memberName: string;
  total: string;
}

export interface PickupOrder {
  id: string;
  number: string;
  memberId: string;
  lines: { productId: string; label: string; qty: string }[];
}

/** R-PRE-03: the open pre-orders, to be collected into the current ticket in one click. Needs the network. */
export function PreorderPickupDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (order: PickupOrder) => void;
}) {
  const { data, error, isPending } = useQuery({
    queryKey: ['till-preorders'],
    queryFn: () => api.get<OpenOrder[]>('/preorders?open=true'),
    enabled: open,
    retry: false,
  });
  const pick = async (id: string) => {
    onPick(await api.get<PickupOrder>(`/preorders/${id}`));
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Précommandes à retirer"
      description="Le ticket se remplit avec la commande ; le règlement se fait comme une vente normale."
    >
      {error ? (
        <Alert>Impossible de charger les précommandes (la caisse est-elle en ligne ?).</Alert>
      ) : null}
      {isPending && !error ? <p className="text-sm text-muted-foreground">Chargement…</p> : null}
      {data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune précommande en attente.</p>
      ) : null}
      <ul className="grid gap-2">
        {data?.map((o) => (
          <li key={o.id} className="flex items-center gap-3 rounded-md border p-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {o.memberName} · {o.number}
              </p>
              <p className="text-muted-foreground">
                retrait le {formatDate(o.pickupDate)} · {PREORDER_STATUS_LABELS[o.status]} ·{' '}
                {euro(o.total)}
              </p>
            </div>
            <Button size="sm" onClick={() => void pick(o.id)}>
              Retirer
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
