// RGAA 8.5: every page has its own title, « Page – nom du logiciel ». The title follows the address:
// the first line that matches wins, so the specific addresses come before the general ones.

const TITLES: [RegExp, string][] = [
  [/^\/connexion/, 'Connexion'],
  [/^\/mot-de-passe-oublie/, 'Mot de passe oublié'],
  [/^\/mot-de-passe/, 'Nouveau mot de passe'],
  [/^\/caisse\/operations/, 'Opérations de caisse'],
  [/^\/caisse\/cloture/, 'Clôture de caisse'],
  [/^\/caisse/, 'Caisse'],
  [/^\/membres\/nouveau/, 'Nouvel adhérent'],
  [/^\/membres\/[^/]+/, 'Fiche adhérent'],
  [/^\/membres/, 'Adhérents'],
  [/^\/foyers\//, 'Fiche foyer'],
  [/^\/mon-foyer/, 'Mon foyer'],
  [/^\/boutique/, 'Boutique'],
  [/^\/precommandes/, 'Précommandes'],
  [/^\/stats/, 'Statistiques'],
  [/^\/imports/, 'Imports'],
  [/^\/catalogue\/nouveau/, 'Nouveau produit'],
  [/^\/catalogue\/etiquettes/, 'Étiquettes'],
  [/^\/catalogue\/prix/, 'Grille de prix'],
  [/^\/catalogue\/rayons/, 'Rayons'],
  [/^\/catalogue\/avis/, 'Avis sur les produits'],
  [/^\/catalogue\/[^/]+/, 'Fiche produit'],
  [/^\/catalogue/, 'Produits'],
  [/^\/appros\/commandes\/[^/]+/, 'Commande fournisseur'],
  [/^\/appros\/commandes/, 'Commandes fournisseurs'],
  [/^\/appros\/fournisseurs\/nouveau/, 'Nouveau fournisseur'],
  [/^\/appros\/fournisseurs\/[^/]+/, 'Fiche fournisseur'],
  [/^\/appros\/fournisseurs/, 'Fournisseurs'],
  [/^\/appros\/factures\/nouvelle/, 'Nouvelle facture fournisseur'],
  [/^\/appros\/factures\/[^/]+/, 'Facture fournisseur'],
  [/^\/appros\/factures/, 'Factures fournisseurs'],
  [/^\/appros\/stock/, 'Stock'],
  [/^\/appros\/inventaires\/[^/]+/, 'Inventaire'],
  [/^\/appros\/inventaires/, 'Inventaires'],
  [/^\/appros/, 'Approvisionnements'],
  [/^\/compta\/ecritures\/nouvelle/, 'Nouvelle écriture'],
  [/^\/compta\/ecritures\/[^/]+/, 'Écriture comptable'],
  [/^\/compta\/ecritures/, 'Écritures comptables'],
  [/^\/compta\/banque\/[^/]+/, 'Relevé bancaire'],
  [/^\/compta\/banque/, 'Banque'],
  [/^\/compta\/editions/, 'Éditions comptables'],
  [/^\/compta\/plan/, 'Plan comptable'],
  [/^\/compta\/propositions/, 'Propositions d’écritures'],
  [/^\/compta\/budget/, 'Budget'],
  [/^\/compta\/clotures-z/, 'Clôtures Z et archive fiscale'],
  [/^\/compta\/cloture/, 'Clôture de l’exercice'],
  [/^\/compta/, 'Comptabilité'],
  [/^\/admin\/parametres/, 'Paramètres'],
  [/^\/admin\/utilisateurs/, 'Utilisateurs'],
  [/^\/admin\/journal/, 'Journal des actions'],
  [/^\/admin\/aide/, 'Aide'],
  [/^\/admin\/signalements\/gestion/, 'Gestion des signalements'],
  [/^\/admin\/signalements\/[^/]+/, 'Signalement'],
  [/^\/admin\/signalements/, 'Signalements'],
  [/^\/admin\/adhesions/, 'Types d’adhésion'],
  [/^\/admin\/courriels/, 'Modèles de courriels'],
  [/^\/admin\/documents/, 'Modèles de documents'],
  [/^\/admin\/caisse/, 'Réglages de la caisse'],
  [/^\/admin\/controles/, 'Contrôles d’intégrité'],
  [/^\/admin\/connexions/, 'Connexions'],
  [/^\/admin/, 'Administration'],
  [/^\/aide/, 'Aide'],
  [/^\/signalements\/gestion/, 'Gestion des signalements'],
  [/^\/signalements\/[^/]+/, 'Signalement'],
  [/^\/signalements/, 'Signalements'],
  [/^\/surveillance\/erreurs/, 'Erreurs du serveur'],
  [/^\/surveillance\/courriels/, 'Courriels envoyés'],
  [/^\/surveillance\/activite/, 'Activité'],
  [/^\/surveillance\/sauvegardes/, 'Sauvegardes'],
  [/^\/surveillance\/controles/, 'Contrôles d’intégrité'],
  [/^\/surveillance\/connexions/, 'Connexions'],
  [/^\/surveillance/, 'À surveiller'],
  [/^\/$/, 'Accueil'],
];

/** The name of the page at this address, or null when it is not known. */
export function pageNameOfPath(pathname: string): string | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [re, title] of TITLES) if (re.test(p)) return title;
  return null;
}

/** « Page – nom du logiciel »; the name of the software alone when the page is not known. */
export function documentTitle(pathname: string, appName: string): string {
  const page = pageNameOfPath(pathname);
  return page ? `${page} – ${appName}` : appName;
}
