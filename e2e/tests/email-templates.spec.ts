import { expect, test, type Page } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// Administration › Courriels: the wording of each e-mail is edited in the application, with
// variables, a visual editor and its HTML, a layout common to all and images inside the messages.

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

async function openTemplate(page: Page, label: string) {
  await page.goto('/admin/courriels');
  await page
    .getByRole('navigation', { name: 'Liste des courriels' })
    .getByRole('button', { name: label })
    .click();
  await expect(page.getByRole('heading', { name: label, level: 2 })).toBeVisible();
}

const resetAll = async () => {
  await query(`delete from app.email_template`);
  await query(`delete from app.email_layout`);
  await query(`delete from app.email_asset`);
};

test.afterEach(resetAll);

test('the wording of an e-mail is edited with variables, previewed, saved and then used when it is sent', async ({
  page,
}) => {
  const tag = unique();
  await login(page, USERS.admin);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('link', { name: 'Administration' })
    .click();
  await page.getByRole('link', { name: 'Courriels' }).click();
  await expect(page).toHaveURL(/\/admin\/courriels$/);
  await openTemplate(page, 'Mot de passe : lien pour le définir');

  // The subject: some words and a variable inserted from the list.
  await page.getByLabel('Objet', { exact: true }).fill(`Bienvenue ${tag} `);
  await page.getByLabel('Insérer une variable dans l’objet').selectOption({ label: 'Prénom' });
  await expect(page.getByLabel('Objet', { exact: true })).toHaveValue(
    `Bienvenue ${tag} {{prenom}}`,
  );

  // The message, in the visual editor.
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Salut ');
  await page.getByLabel('Insérer une variable', { exact: true }).selectOption('prenom');
  await page.keyboard.type(' ! Votre lien : ');
  await page.getByLabel('Insérer une variable', { exact: true }).selectOption('lien');

  // The preview follows, with the samples of the variables.
  await expect(page.getByTestId('preview-subject')).toHaveText(`Bienvenue ${tag} Marie`);
  const frame = page.frameLocator('iframe[title="Aperçu du courriel"]');
  await expect(frame.getByText('Salut Marie !')).toBeVisible();

  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Courriel enregistré.')).toBeVisible();
  const saved = await query<{ subject: string; body_html: string }>(
    `select subject, body_html from app.email_template where key = 'password_link'`,
  );
  expect(saved).toHaveLength(1);
  expect(saved[0]!.subject).toBe(`Bienvenue ${tag} {{prenom}}`);
  expect(saved[0]!.body_html).toContain('{{lien}}');

  // The next « mot de passe oublié » is written with it.
  const res = await page.request.post('/api/v1/auth/password/forgot', {
    headers: { 'x-episoft-csrf': '1' },
    data: { username: USERS.customer.username },
  });
  expect(res.status()).toBe(204);
  const [mail] = await query<{ subject: string; html: string; text: string }>(
    `select subject, html, text from app.email_outbox
      where "to" = '${USERS.customer.username.toLowerCase()}@example.org' order by created_at desc limit 1`,
  );
  expect(mail!.subject).toBe(`Bienvenue ${tag} Dora`);
  expect(mail!.html).toContain('Salut Dora !');
  expect(mail!.html).toMatch(/\/mot-de-passe\?jeton=/);
  expect(mail!.html).toContain('<!doctype html>');
  expect(mail!.text).toMatch(/Salut Dora ! Votre lien : \S*\/mot-de-passe\?jeton=/);
});

test('the original wording comes back, after a confirmation', async ({ page }) => {
  await query(
    `insert into app.email_template (key, subject, body_html) values ('wallet_low', 'Mon objet', '<p>{{message}}</p>')`,
  );
  await login(page, USERS.admin);
  await openTemplate(page, 'Cagnotte basse');
  await expect(page.getByLabel('Objet', { exact: true })).toHaveValue('Mon objet');
  await page.getByRole('button', { name: 'Rétablir la version d’origine' }).click();
  await page
    .getByRole('dialog', { name: 'Rétablir la version d’origine ?' })
    .getByRole('button', { name: 'Rétablir' })
    .click();
  await expect(page.getByLabel('Objet', { exact: true })).toHaveValue(
    '{{association_court}} : votre cagnotte est basse',
  );
  expect(await query(`select 1 from app.email_template where key = 'wallet_low'`)).toHaveLength(0);
});

test('the HTML can be edited, and what is dangerous in it is removed when saved', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await openTemplate(page, 'Cagnotte basse');
  await page.getByRole('button', { name: 'Voir le code HTML' }).click();
  await page
    .getByLabel('Code HTML : Message')
    .fill(
      '<p>Bonjour {{prenom}}</p><p>{{message}}</p><script>alert(1)</script><img src="https://tracker.example/p.gif">',
    );
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Courriel enregistré.')).toBeVisible();
  const [row] = await query<{ body_html: string }>(
    `select body_html from app.email_template where key = 'wallet_low'`,
  );
  expect(row!.body_html).toBe('<p>Bonjour {{prenom}}</p><p>{{message}}</p>');
});

test('an unknown variable is refused with a message that says which one', async ({ page }) => {
  await login(page, USERS.admin);
  await openTemplate(page, 'Cagnotte basse');
  await page.getByRole('button', { name: 'Voir le code HTML' }).click();
  await page.getByLabel('Code HTML : Message').fill('<p>{{message}} {{nimporte}}</p>');
  await expect(
    page.getByText(/Variable\(s\) inconnue\(s\) : \{\{nimporte\}\}/).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  expect(await query(`select 1 from app.email_template`)).toHaveLength(0);
});

test('the layout and an image of the library go inside the message', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/courriels');

  // The image is added to the library.
  await page.getByRole('tab', { name: 'Images' }).click();
  await page
    .getByLabel('Ajouter une image')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('logo.png')).toBeVisible();
  await expect(page.getByText('Pas utilisée')).toBeVisible();

  // An image that is not one is refused.
  await page.getByLabel('Ajouter une image').setInputFiles({
    name: 'faux.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<html><script>x()</script></html>'),
  });
  await expect(page.getByRole('alert')).toContainText('Image PNG, JPEG, WebP ou GIF attendue');

  // It becomes the header, with another colour.
  await page.getByRole('tab', { name: 'Mise en page commune' }).click();
  await page.getByRole('button', { name: 'Choisir une image' }).click();
  await page.getByRole('button', { name: 'Insérer l’image logo.png' }).click();
  await page.getByLabel('Texte de remplacement de l’image').fill('Logo de l’Épicafé');
  await page.getByRole('textbox', { name: 'Couleur principale', exact: true }).fill('#aa3300');
  await page.getByRole('button', { name: 'Enregistrer la mise en page' }).click();
  await expect(page.getByText('Mise en page enregistrée.')).toBeVisible();
  const frame = page.frameLocator('iframe[title="Aperçu de la mise en page"]');
  await expect(frame.getByAltText('Logo de l’Épicafé')).toBeVisible();

  // A test message carries the image inside, not as a link to the server.
  await page.getByRole('tab', { name: 'Courriels' }).click();
  await page
    .getByRole('navigation', { name: 'Liste des courriels' })
    .getByRole('button', { name: 'Cagnotte basse' })
    .click();
  await page.getByRole('button', { name: 'M’envoyer un essai' }).click();
  await expect(page.getByText('Un essai vient d’être mis en file')).toBeVisible();
  const [mail] = await query<{ subject: string; html: string; n: number }>(
    `select subject, html, coalesce(jsonb_array_length(attachments), 0)::int as n
       from app.email_outbox where subject like '[Essai]%' order by created_at desc limit 1`,
  );
  expect(mail!.html).toContain('cid:asset-');
  expect(mail!.html).toContain('#aa3300');
  expect(mail!.html).not.toContain('/api/v1/email-assets/');
  expect(mail!.n).toBe(1);

  // The image is used: it cannot be deleted. Free it, then delete it.
  await page.getByRole('tab', { name: 'Images' }).click();
  await expect(page.getByRole('button', { name: 'Supprimer logo.png' })).toBeDisabled();
  await query(`delete from app.email_layout`);
  await page.reload();
  await page.getByRole('tab', { name: 'Images' }).click();
  await page.getByRole('button', { name: 'Supprimer logo.png' }).click();
  await page
    .getByRole('dialog', { name: 'Supprimer cette image ?' })
    .getByRole('button', { name: 'Supprimer' })
    .click();
  await expect(page.getByText('Aucune image pour l’instant.')).toBeVisible();
});

test('an image is inserted in the message from the library', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/courriels');
  await page.getByRole('tab', { name: 'Images' }).click();
  await page
    .getByLabel('Ajouter une image')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('photo.png')).toBeVisible();
  await page.getByRole('tab', { name: 'Courriels' }).click();
  await page
    .getByRole('navigation', { name: 'Liste des courriels' })
    .getByRole('button', { name: 'Commande prête' })
    .click();
  await page.getByRole('button', { name: 'Insérer une image' }).click();
  await page.getByRole('button', { name: 'Insérer l’image photo.png' }).click();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Courriel enregistré.')).toBeVisible();
  const [row] = await query<{ body_html: string }>(
    `select body_html from app.email_template where key = 'preorder_ready'`,
  );
  expect(row!.body_html).toMatch(/<img src="\/api\/v1\/email-assets\/[0-9a-f-]{36}"/);
});

test('the e-mails are for the administrators only', async ({ page }) => {
  await login(page, USERS.cashier);
  await page.goto('/admin/courriels');
  await expect(page).not.toHaveURL(/courriels/);
  const res = await page.request.get('/api/v1/email-templates');
  expect(res.status()).toBe(403);
});
