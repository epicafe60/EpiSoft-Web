import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONSENT_CHANNEL_LABELS,
  CONSENT_PURPOSES,
  CONSENTS,
  type ConsentChannel,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { QueryError } from '../errors';

interface Summary {
  items: {
    purpose: (typeof CONSENT_PURPOSES)[number];
    label: string;
    text: string;
    withdrawable: boolean;
    granted: boolean;
    recorded: boolean;
    since: string | null;
    channel: string | null;
    textVersion: string | null;
  }[];
  history: {
    id: string;
    purpose: string;
    granted: boolean;
    textVersion: string;
    channel: string;
    at: string;
  }[];
}

const channel = (c: string | null) =>
  c ? (CONSENT_CHANNEL_LABELS[c as ConsentChannel] ?? c) : 'valeur par défaut du service';

/**
 * RGPD: what the member agreed to, with date, text version and way collected. `self` is the member's
 * own area: they can withdraw a choice there (art. 7.3); on a sheet, the history is read-only.
 */
export function ConsentsCard({ memberId, self = false }: { memberId?: string; self?: boolean }) {
  const queryClient = useQueryClient();
  const url = self ? '/me/consents' : `/members/${memberId}/consents`;
  const key = ['consents', self ? 'me' : memberId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<Summary>(url) });
  const change = useMutation({
    mutationFn: (v: { purpose: string; granted: boolean }) => api.put<Summary>('/me/consents', v),
    onSuccess: (d) => queryClient.setQueryData(key, d),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Consentements et informations (RGPD)</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {error ? <QueryError error={error} /> : null}
        {change.error ? (
          <p role="alert" className="text-destructive">
            {change.error.message}
          </p>
        ) : null}
        {data?.items.map((i) => (
          <div key={i.purpose} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {i.label}{' '}
                <Badge variant={i.granted ? 'success' : 'muted'}>{i.granted ? 'Oui' : 'Non'}</Badge>
              </p>
              <p className="text-xs text-muted-foreground">{CONSENTS[i.purpose].text}</p>
              <p className="text-xs text-muted-foreground">
                {i.recorded
                  ? `Enregistré le ${formatDate(i.since!)} · ${channel(i.channel)} · texte ${i.textVersion}`
                  : 'Aucun enregistrement : valeur par défaut du service.'}
              </p>
            </div>
            {self && i.withdrawable && i.granted ? (
              <Button
                variant="outline"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({ purpose: i.purpose, granted: false })}
              >
                Retirer
              </Button>
            ) : null}
            {self && i.withdrawable && !i.granted && i.purpose !== 'NOTIFICATIONS' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({ purpose: i.purpose, granted: true })}
              >
                Accepter
              </Button>
            ) : null}
          </div>
        ))}
        {data?.history.length ? (
          <details>
            <summary className="cursor-pointer text-xs font-medium">
              Historique ({data.history.length})
            </summary>
            <Table exportable={false}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Finalité</th>
                  <th>Choix</th>
                  <th>Recueilli</th>
                  <th>Texte</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id}>
                    <td>{formatDate(h.at)}</td>
                    <td>{CONSENTS[h.purpose as keyof typeof CONSENTS]?.label ?? h.purpose}</td>
                    <td>{h.granted ? 'Accepté' : 'Retiré'}</td>
                    <td>{channel(h.channel)}</td>
                    <td>{h.textVersion}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
