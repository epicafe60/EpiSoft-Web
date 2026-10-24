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
          'Un bandeau le signale. Clôturez la session depuis la caisse : le comptage se fait sur le tiroir tel qu’il est aujourd’hui, et un commentaire explique le décalage.',
          'Si le poste n’est plus disponible, un administrateur peut clôturer la session dans Administration › Caisse.',
        ],
      },
      {
        question: 'Une session est déjà ouverte sur une autre caisse',
        answer: [
          'À l’ouverture, « Rejoindre cette session » vous met dans la même session : un seul tiroir, une seule clôture, les ventes de chacun sont comptées par caissier.',
          'N’ouvrez une session séparée que si ce poste a son propre tiroir.',
        ],
      },
    ],
  },
  {
    title: 'Approvisionnements et stock',
    roles: ['APPROS', 'PRODUITS'],
    topics: [
      {
        question: 'À la réception, l’application signale un prix d’achat qui change',
        answer: [
          'Le prix d’achat reçu remplace l’ancien (et sert au calcul de la marge). Une ligne en rouge indique « ancien prix → nouveau prix ».',
          'Comparez avec le bon de livraison ou la facture. Si le prix est juste, cochez « J’ai vérifié » : pensez alors à ajuster le prix de vente. Sinon, corrigez le prix avant de valider.',
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
