import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// Signalements: a volunteer reports a bug from the screen they are on (module and screen
// pre-filled), the administrator handles it, the author sees the answer.

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

test('a bug is reported from a screen, handled by an administrator and answered', async ({
  browser,
}) => {
  const title = `Bouton muet ${unique()}`;

  // The author, on the members screens.
  const author = await browser.newPage();
  await login(author, USERS.admin);
  await author.goto('/membres');
  await author.getByRole('button', { name: 'Signaler un problème' }).first().click();
  const dialog = author.getByRole('dialog');
  await expect(dialog.getByLabel('Module')).toHaveValue('membres');
  // The screen is the page as it is in the address bar, not the title of the tab.
  await expect(dialog.getByLabel('Écran concerné')).toHaveValue('/membres');
  await dialog.getByLabel('Titre').fill(title);
  // A bug without steps is refused under its field.
  await dialog
    .getByLabel('Ce qui se passe, et ce que vous attendiez')
    .fill('Le bouton ne répond pas.');
  await dialog.getByRole('button', { name: 'Envoyer' }).click();
  await expect(dialog.getByText('Pour un problème, indiquez les étapes')).toBeVisible();
  await dialog
    .getByLabel('Étapes pour reproduire le problème')
    .fill('1. Ouvrir la liste\n2. Cliquer');
  await dialog.getByRole('button', { name: 'Envoyer' }).click();
  await expect(dialog.getByText(/est enregistré/)).toBeVisible();

  const rows = await query<{
    number: number;
    module: string;
    kind: string;
    status: string;
    screen: string;
  }>(
    `select number, module, kind, status, screen from app.feedback_ticket where title = '${title}'`,
  );
  expect(rows).toMatchObject([
    { module: 'membres', kind: 'BUG', status: 'NEW', screen: '/membres' },
  ]);

  // « À surveiller » on the administrator's home page counts it until someone looks at it.
  await author.goto('/');
  await expect(
    author.getByLabel('À surveiller').getByText(/en attente d’une première réponse/),
  ).toBeVisible();

  // The administrator answers and closes it.
  await author.goto('/signalements/gestion');
  await author.getByRole('link', { name: title }).click();
  await author.getByLabel('Votre message').fill('Corrigé, merci de vérifier.');
  await author.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(author.getByText('Corrigé, merci de vérifier.')).toBeVisible();
  await author.getByLabel('État', { exact: true }).selectOption('DONE');
  await expect
    .poll(
      async () =>
        (
          await query<{ status: string }>(
            `select status from app.feedback_ticket where title = '${title}'`,
          )
        )[0]?.status,
    )
    .toBe('DONE');

  // Another person does not see it.
  const other = await browser.newPage();
  await login(other, USERS.customer);
  await other.goto('/signalements');
  await expect(other.getByText(title)).toHaveCount(0);
  await expect(other.getByText('Vous n’avez rien signalé pour l’instant.')).toBeVisible();
  await other.goto('/signalements/gestion');
  await expect(other).not.toHaveURL(/gestion/);
});
