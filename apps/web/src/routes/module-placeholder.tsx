import { MODULES, type ModuleKey } from '@episoft/shared';
import { Alert } from '@/components/ui/form';
import { PageHeader } from './shell';

/** What each module will contain, and in which lot (spec §10). */
export const MODULE_INFO: Record<ModuleKey, { summary: string; lot: number }> = {
  caisse: { summary: 'Vente, cagnotte, sessions et clôture de caisse.', lot: 1 },
  membres: { summary: 'Membres, foyers, adhésions et cagnottes.', lot: 1 },
  catalogue: { summary: 'Produits, prix, étiquettes et images.', lot: 2 },
  appros: {
    summary: 'Fournisseurs, commandes, réceptions, factures, stock et inventaire.',
    lot: 2,
  },
  precommandes: { summary: 'Précommandes des clients.', lot: 4 },
  compta: { summary: 'Écritures, banque, éditions et clôture.', lot: 3 },
  stats: { summary: 'Tableaux de bord, statistiques et exports.', lot: 4 },
  admin: { summary: 'Paramètres, utilisateurs, rôles et journal d’audit.', lot: 0 },
};

export function ModulePlaceholder({ moduleKey }: { moduleKey: ModuleKey }) {
  const m = MODULES.find((x) => x.key === moduleKey)!;
  const info = MODULE_INFO[moduleKey];
  return (
    <>
      <PageHeader title={m.label} description={info.summary} />
      <Alert variant="info">Ce module arrive avec le lot {info.lot} de la feuille de route.</Alert>
    </>
  );
}
