import { Link } from '@tanstack/react-router';
import { hasAnyRole } from '@episoft/shared';
import { useMe } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from './shell';

interface Topic {
  question: string;
  answer: string[];
}

interface Section {
  title: string;
  /** Roles that care about it (empty: everybody). */
  roles: Parameters<typeof hasAnyRole>[1];
  topics: Topic[];
}

const SECTIONS: Section[] = [
  {
    title: 'Modifier les courriels de l’application',
    roles: ['ADMIN'],
    topics: [
      {
        question: 'Où changer le texte des courriels (ticket, mot de passe, rappels…) ?',
        answer: [
          'Administration › Courriels. À gauche, la liste des courriels ; choisissez-en un pour modifier son objet et son message. L’aperçu, à droite ou en dessous, montre le résultat avec des valeurs d’exemple.',
          '« M’envoyer un essai » envoie le courriel enregistré à votre propre adresse, pour le voir dans une vraie boîte. « Rétablir la version d’origine » remet le texte de l’application.',
        ],
      },
      {
        question: 'Que sont les variables entre accolades ?',
        answer: [
          'Des mots comme {{prenom}} ou {{numero}} sont remplacés au moment de l’envoi par le prénom de la personne, le numéro du ticket… Utilisez « Insérer une variable » plutôt que de les taper : chaque courriel n’en connaît que certaines, la liste est sous le message.',
          'Certaines sont indispensables : le courriel « mot de passe » doit contenir {{lien}}, sinon la personne ne pourrait pas se connecter.',
        ],
      },
      {
        question: 'Comment mettre un logo, un en-tête ou un pied de page ?',
        answer: [
          'L’onglet « Mise en page commune » règle l’en-tête (une image, par exemple le logo), le pied de page et la couleur : ils s’appliquent à tous les courriels.',
          'Les images se gèrent dans l’onglet « Images » (PNG, JPEG, WebP ou GIF, 500 Ko au plus) et s’insèrent aussi dans un message avec le bouton « Insérer une image ». Elles partent dans le courriel lui-même : elles s’affichent sans connexion au serveur.',
        ],
      },
      {
        question: 'Puis-je écrire du code HTML ?',
        answer: [
          'Oui : le bouton « Voir le code HTML » de l’éditeur. Par sécurité, l’application ne garde que ce dont un courriel a besoin (texte, listes, liens, tableaux, vos images) : scripts, formulaires et images venues d’ailleurs sont retirés à l’enregistrement.',
        ],
      },
    ],
  },
  {
    title: 'Modifier les documents PDF de l’application',
    roles: ['ADMIN'],
    topics: [
      {
        question: 'Où changer le texte et les colonnes du bon de commande ?',
        answer: [
          'Administration › Documents PDF. Choisissez un document : le bon de commande fournisseur, le rapport de clôture de caisse ou les rapports comptables et statistiques.',
          'Chaque bloc de texte (en-tête, fournisseur, bas de page…) se modifie comme un courriel, avec des variables comme {{numero}} ou {{fournisseur_nom}}. L’aperçu en dessous montre le PDF avec des valeurs d’exemple, avant d’enregistrer.',
        ],
      },
      {
        question: 'Comment choisir les colonnes du tableau ?',
        answer: [
          'Pour le bon de commande, cochez les colonnes à imprimer (référence fournisseur, prix HT, TVA, prix TTC, quantité, totaux), changez leur en-tête et leur ordre avec les flèches. La désignation du produit ne peut pas être retirée.',
          'Les colonnes des rapports (journal, bilan…) dépendent de chaque rapport et ne se choisissent pas encore.',
        ],
      },
      {
        question: 'Comment changer le logo des PDF ?',
        answer: [
          'En haut de la page Administration › Documents PDF : « Logo des documents PDF ». Par défaut, c’est la même image que l’en-tête des courriels ; vous pouvez aussi choisir une autre image de la bibliothèque (PNG ou JPEG) ou en ajouter une nouvelle.',
          'Le logo s’imprime en haut à droite de chaque document ; chaque document peut le masquer (case « Imprimer le logo »). Les courriels gardent leur propre image d’en-tête, réglée dans Courriels › Mise en page commune.',
        ],
      },
      {
        question: 'Que devient une ligne dont la variable est vide ?',
        answer: [
          'Elle disparaît : si l’association n’a pas de SIREN dans les paramètres, la ligne « SIREN : » n’est pas imprimée. « Rétablir la version d’origine » remet le texte et les colonnes de l’application.',
        ],
      },
    ],
  },
  {
    title: 'Exporter une liste en Excel',
    roles: [],
    topics: [
      {
        question: 'Comment télécharger une liste dans Excel ?',
        answer: [
          'Au-dessus de chaque liste, le bouton « Exporter en Excel » télécharge le tableau tel qu’il est affiché : si vous avez filtré une colonne ou trié, le fichier suit ce que vous voyez.',
          'Les montants et les dates sont de vrais nombres et de vraies dates dans le fichier (vous pouvez les additionner et les trier) ; les codes et numéros restent du texte, pour garder leurs zéros.',
        ],
      },
      {
        question: 'Pourquoi n’ai-je pas le bouton sur certains écrans ?',
        answer: [
          'L’export suit vos droits : vous exportez les listes des écrans que vous pouvez ouvrir, pas les autres. La caisse n’en propose pas.',
          'Chaque fichier téléchargé est noté dans le journal (qui, depuis quel écran, combien de lignes).',
        ],
      },
    ],
  },
  {
    title: 'Signaler un problème ou une idée',
    roles: [],
    topics: [
      {
        question: 'Comment signaler un problème ou proposer une amélioration ?',
        answer: [
          'Dans le menu, cliquez sur « Signaler un problème » : la fenêtre s’ouvre déjà réglée sur le module où vous êtes. Choisissez « Problème » ou « Idée », donnez un titre et décrivez.',
          'Pour un problème, indiquez les étapes pour le reproduire (1. j’ouvre… 2. je clique…) : c’est ce qui permet de le retrouver. Votre nom et la date sont ajoutés tout seuls.',
        ],
      },
      {
        question: 'Où voir la suite donnée à mon signalement ?',
        answer: [
          'Dans « Signalements » : l’état (nouveau, en cours, terminé…) et les réponses de l’équipe s’y trouvent. Vous êtes aussi prévenu par courriel.',
          'Vous seul et les administrateurs voyez vos signalements. Vous pouvez répondre dans la conversation ; répondre à un signalement terminé le rouvre.',
        ],
      },
    ],
  },
  {
    title: 'À la caisse',
    roles: ['CAISSE'],
    topics: [
      {
        question: 'Le réseau est coupé : puis-je continuer à vendre ?',
        answer: [
          'Oui. Le bandeau « Hors ligne » s’affiche, mais les ventes continuent : elles sont gardées sur le poste et envoyées toutes seules au retour du réseau.',
          'Ne fermez pas la page et ne videz pas les données du navigateur. En haut, « N en attente d’envoi » doit revenir à « Tout est envoyé ».',
          'Au moment de clôturer, il faut le réseau : attendez que tout soit envoyé.',
        ],
      },
      {
        question: 'Un ticket apparaît « refusé » en haut de l’écran',
        answer: [
          'Le serveur n’a pas pu l’enregistrer : le stock et la cagnotte n’ont pas bougé. Les responsables sont prévenus.',
          'Cliquez sur « refusé(s) : voir », ouvrez le ticket : « Ressaisir ce ticket » le remet dans un nouveau ticket, à vérifier et à encaisser de nouveau.',
          'Si le client est déjà passé en caisse autrement, choisissez « Classer sans suite ».',
        ],
      },
      {
        question: 'Où voir ce qui a été encaissé depuis l’ouverture de la caisse ?',
        answer: [
          'Dans « Opérations du jour » : une ligne par opération de la session, la plus récente en haut. Ce sont les tickets et les versements faits hors ticket (rechargement de cagnotte, adhésion, don). Cliquez sur le numéro pour ouvrir le ticket.',
          'Les colonnes disent l’heure, le type, qui a encaissé (avec le nom du poste s’il s’agit d’un autre), l’adhérent, le paiement (espèces, chèque, carte, cagnotte…), le montant total, ce qu’il contient de don et d’adhésion, et le mouvement de cagnotte : en vert ce qui s’ajoute (rechargement, monnaie versée sur la cagnotte), en orange ce qui est retiré (achat payé par cagnotte). Le pied du tableau donne les totaux par moyen de paiement.',
          'Un ticket annulé reste affiché, barré, et n’entre dans aucun total. Cochez « Toute la journée (tous les postes) » pour voir aussi les autres sessions du jour. Les filtres (type, caissier, moyen de paiement, recherche) s’appliquent au tableau et aux totaux. Hors ligne, seules les opérations de ce poste sont visibles.',
          '« Exporter en Excel » enregistre le tableau tel qu’il est affiché, filtres compris ; la colonne « État » garde l’information des tickets annulés ou en attente.',
        ],
      },
      {
        question: 'L’application me demande de vérifier avant d’encaisser',
        answer: [
          'Quelque chose sort de l’ordinaire : une grosse quantité (un 100 tapé au lieu d’un 10 ?), un prix très différent du prix habituel, une grosse remise.',
          '« Corriger le ticket » revient au ticket. « C’est correct, encaisser » continue : rien ne vous empêche de vendre.',
        ],
      },
      {
        question: 'Il y a un écart dans le tiroir à la clôture',
        answer: [
          'Recomptez les pièces et les billets, et vérifiez que tous les tickets sont envoyés.',
          'Si l’écart dépasse quelques euros, un commentaire est demandé : écrivez ce que vous pensez être la cause (rendu de monnaie, billet mal compté…). La trésorerie le lit dans le compte rendu.',
        ],
      },
      {
        question: 'J’ai oublié de clôturer hier',
        answer: [
          'La caisse est celle de la journée : à la première connexion du lendemain, elle vous demande de clôturer celle de la veille avant de vendre. Comptez le tiroir tel qu’il est aujourd’hui ; un commentaire explique le décalage.',
          'N’importe quel caissier peut le faire. Sinon, un administrateur peut clôturer la session dans Administration › Caisse.',
        ],
      },
      {
        question: 'Plusieurs personnes utilisent la caisse en même temps',
        answer: [
          'Le premier caissier qui arrive ouvre la caisse de la journée ; les suivants la rejoignent tout seuls, d’où qu’ils se connectent. Il n’y a qu’un tiroir et qu’une clôture.',
          'Les ventes sont comptées au nom du caissier affiché en haut de la caisse (« Encaissé par »). Les opérations de tous sont dans « Opérations du jour ».',
          'N’importe quel caissier peut clôturer ; la clôture indique si un autre caissier a vendu il y a peu.',
        ],
      },
      {
        question: 'Je prends la caisse après quelqu’un d’autre',
        answer: [
          'Pas besoin de déconnecter le poste : touchez « Changer de caissier » (ou le nom affiché en haut), puis votre nom. Si l’association le demande, tapez votre code caissier de 4 chiffres (sans réseau, il ne peut pas être vérifié : vos ventes sont alors signalées « non vérifié »).',
          'La première fois, choisissez votre code : 4 chiffres, puis votre mot de passe pour confirmer. Code oublié : un administrateur l’efface, vous en choisissez un autre.',
          'Tant qu’un autre caissier tient la caisse, le reste de l’application est fermé : la personne connectée retape son mot de passe (« Revenir à mon compte ») pour y accéder.',
          'Après un quart d’heure sans ticket, la caisse redemande qui encaisse.',
        ],
      },
    ],
  },
  {
    title: 'Approvisionnements et stock',
    roles: ['APPROS', 'PRODUITS'],
    topics: [
      {
        question: 'Je prépare une commande fournisseur',
        answer: [
          'La commande démarre à zéro sur toutes les références du fournisseur : tapez la quantité voulue dans « Qté Commande ». « Stock », « Mini » et « Quantité dernière commande » (celle de la commande précédente à ce fournisseur) sont là pour vous guider. Une ligne laissée à zéro n’est pas commandée.',
          '« PA HT unitaire en € » se modifie dans la commande : ce prix est celui de la ligne et du bon de commande imprimé. La fiche du produit ne change jamais à l’enregistrement d’une commande.',
        ],
      },
      {
        question: 'À la réception, l’application signale un prix d’achat qui change',
        answer: [
          'Pour chaque ligne, l’écran montre le prix de la fiche, le prix commandé et le prix reçu, avec l’écart en euros et en pourcentage. Le prix reçu sert au coût réel du stock et de la marge, mais la fiche produit n’est pas modifiée toute seule.',
          'Comparez avec le bon de livraison ou la facture. Si le nouveau prix doit devenir le prix habituel, cochez « Mettre à jour la fiche produit » sur la ligne (HT, TVA et TTC sont recalculés au taux du produit) et pensez à ajuster le prix de vente. Sinon, laissez décoché ; si le prix est faux, corrigez-le avant de valider.',
        ],
      },
      {
        question: 'J’ai validé une réception avec une erreur de quantité ou de prix',
        answer: [
          'Ouvrez la commande : « Corriger » à côté de la réception permet de changer les quantités et les prix. Le stock suit tout seul.',
          'Impossible une fois qu’une facture réglée inclut cette réception : il faut alors passer par un inventaire ou un avoir du fournisseur.',
        ],
      },
      {
        question: 'Un produit a un stock négatif',
        answer: [
          'Cela veut dire qu’il s’est vendu plus que ce qui est enregistré : une livraison oubliée, ou un inventaire en retard.',
          'Enregistrez la réception manquante, ou faites un inventaire du produit.',
        ],
      },
      {
        question: 'Que fait un inventaire ?',
        answer: [
          'Il remplace le stock théorique par ce que vous avez compté. Avant de valider, l’application montre les produits très écartés de la théorie et la valeur des écarts : recomptez-les.',
          'Vous pouvez suspendre les ventes en caisse pendant le comptage. Les produits non comptés restent inchangés, sauf si vous choisissez de les mettre à zéro.',
        ],
      },
    ],
  },
  {
    title: 'Adhérents et cagnotte',
    roles: ['ADHERENTS', 'COMPTA'],
    topics: [
      {
        question: 'Cette personne a déjà une fiche',
        answer: [
          'En créant une fiche, l’application signale les fiches de même nom ou de même téléphone. Ouvrez-la plutôt que d’en créer une seconde : la cagnotte et l’historique ne se mélangent pas entre deux fiches.',
        ],
      },
      {
        question: 'La cagnotte d’un foyer paraît fausse',
        answer: [
          'Ouvrez le foyer : toutes les opérations (versements, achats, corrections) y sont, avec leur date. Le solde est toujours la somme de ces opérations.',
          'Un rapport Excel de toutes les cagnottes se télécharge dans Administration › Contrôles. Pour rétablir un montant, utilisez « Correction » avec un motif : elle est journalisée.',
        ],
      },
      {
        question: 'Un adhérent ne reçoit pas ses tickets par courriel',
        answer: [
          'Vérifiez l’adresse sur sa fiche (l’application propose une correction quand elle ressemble à une faute de frappe) et que « Ne plus recevoir les tickets » n’est pas coché.',
          'Les courriels qui n’ont pas pu partir sont dans Surveillance › Courriels, avec un bouton pour les renvoyer.',
        ],
      },
    ],
  },
  {
    title: 'Pour les responsables',
    roles: ['ADMIN', 'COMPTA'],
    topics: [
      {
        question: 'Que signifie le bloc « À surveiller » de l’accueil ?',
        answer: [
          'Il rassemble ce qui mérite un coup d’œil : tickets refusés, tickets enregistrés avec un avertissement, courriels en échec, sauvegarde en retard, stock ou cagnotte négatifs, session oubliée, contrôles de cohérence.',
          'Chaque ligne mène à l’endroit où traiter le point. Un courriel de synthèse arrive chaque matin ; les cas graves sont signalés tout de suite.',
        ],
      },
      {
        question: 'Un écran affiche « Référence 3FA9C2 »',
        answer: [
          'Une erreur inattendue s’est produite. Dans Surveillance › Erreurs du serveur, la référence retrouve la page, le message et le nombre de fois. Classez-la une fois traitée.',
        ],
      },
      {
        question: 'Comment sait-on que la sauvegarde a bien eu lieu ?',
        answer: [
          'Surveillance › Sauvegardes montre la dernière sauvegarde réussie, sa vérification, sa copie hors du serveur et le dernier test de restauration. Une sauvegarde en retard apparaît dans « À surveiller ».',
        ],
      },
      {
        question: 'Où régler ce qui est considéré comme « inhabituel » ?',
        answer: [
          'Administration › Paramètres › Seuils d’alerte : quantité, montant, écart de prix, remise, écart de caisse, variation du prix d’achat, gros versement… Un bouton remet les valeurs par défaut.',
        ],
      },
    ],
  },
];

/** « Que faire si… » : short answers to the situations that worry volunteers (and the way out). */
export function HelpPage() {
  const me = useMe();
  return (
    <>
      <PageHeader
        title="Aide : que faire si…"
        description="Des réponses courtes aux situations qui inquiètent. En cas de doute, ne bloquez pas le magasin : vendez, notez, et prévenez un responsable."
      />
      <div className="grid gap-4">
        {SECTIONS.filter((s) => s.roles.length === 0 || hasAnyRole(me.roles, s.roles)).map((s) => (
          <Card key={s.title}>
            <CardHeader>
              <CardTitle className="text-base">{s.title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {s.topics.map((t) => (
                <details key={t.question} className="rounded-md border px-3 py-2">
                  <summary className="cursor-pointer font-medium">{t.question}</summary>
                  <div className="mt-2 grid gap-2 text-sm text-muted-foreground">
                    {t.answer.map((p) => (
                      <p key={p}>{p}</p>
                    ))}
                  </div>
                </details>
              ))}
            </CardContent>
          </Card>
        ))}
        <p className="text-sm text-muted-foreground">
          Une situation qui n’est pas ici ? Notez ce que vous voyiez à l’écran (et la référence s’il
          y en a une) et{' '}
          <Link to="/" className="underline">
            prévenez un responsable
          </Link>
          .
        </p>
      </div>
    </>
  );
}
