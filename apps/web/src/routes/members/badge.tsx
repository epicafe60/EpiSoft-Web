import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/form';

/**
 * R-MBR-05: printable member badge. The token is only known right after creation or
 * regeneration (the server keeps its hash), so the badge is printed at that moment.
 */
export function BadgeDialog({
  token,
  name,
  number,
  onClose,
}: {
  token: string | null;
  name: string;
  number: number;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    if (token)
      void QRCode.toString(token, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
        setSvg,
      );
  }, [token]);

  return (
    <Dialog
      open={!!token}
      onClose={onClose}
      title="Badge du membre"
      description="Le code n’est affiché qu’une fois : imprimez le badge maintenant."
    >
      <div className="print-area mx-auto grid w-64 justify-items-center gap-2 rounded-lg border bg-white p-4 text-black">
        <p className="text-sm font-semibold">Épicafé de Montjavoult</p>
        <div
          className="size-40"
          aria-label={`QR code du badge de ${name}`}
          role="img"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="text-center font-medium">{name}</p>
        <p className="text-xs">Membre n° {number}</p>
      </div>
      <Alert variant="info">L’ancien badge de ce membre ne fonctionne plus.</Alert>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
        <Button onClick={() => window.print()}>
          <Printer /> Imprimer
        </Button>
      </div>
    </Dialog>
  );
}
