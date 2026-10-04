import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/form';

/** VAPID keys are url-safe base64; PushManager wants bytes. */
function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(
    b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4),
  );
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Opt-in to "your order is ready" notifications on this device. Hidden when unsupported or not configured. */
export function PushToggle() {
  const [key, setKey] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState('');
  const supported =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  useEffect(() => {
    if (!supported) return;
    void (async () => {
      try {
        const { publicKey } = await api.get<{ publicKey: string | null }>('/push/key');
        setKey(publicKey);
        const reg = await navigator.serviceWorker.ready;
        setOn(!!(await reg.pushManager.getSubscription()));
      } catch {
        /* push stays hidden */
      }
    })();
  }, [supported]);

  if (!supported || !key) return null;

  const enable = async () => {
    setError('');
    try {
      if ((await Notification.requestPermission()) !== 'granted')
        return setError('Les notifications sont bloquées dans votre navigateur.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      });
      await api.post('/push/subscribe', sub.toJSON());
      setOn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Activation impossible.');
    }
  };
  const disable = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    setOn(false);
  };

  return (
    <div className="grid gap-2">
      <Button variant="outline" className="w-fit" onClick={on ? disable : enable}>
        {on ? <BellOff /> : <Bell />}
        {on ? 'Désactiver les notifications' : 'Être prévenu quand ma commande est prête'}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
