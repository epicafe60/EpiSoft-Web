import { expect, test, type Page } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// Administration › Documents PDF: the wording and the columns of the PDF documents are edited in the
// application, with variables and a preview drawn by the server.

// A 1×1 PNG, and a GIF (an image a PDF cannot draw).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

const resetAll = async () => {
  await query(`delete from app.pdf_template`);
  await query(`delete from app.setting where key = 'documents.logo'`);
  await query(`delete from app.email_asset where name in ('logo-pdf.png', 'anim.gif')`);
};
test.afterEach(resetAll);

async function openDocument(page: Page, label: string) {
  await page.goto('/admin/documents');
  await page
    .getByRole('navigation', { name: 'Liste des documents' })
    .getByRole('button', { name: label })
    .click();
  await expect(page.getByRole('heading', { name: label, level: 2 })).toBeVisible();
}

const previewResponse = (page: Page) =>
  page.waitForResponse(
    (r) => r.url().includes('/pdf-templates/') && r.url().endsWith('/preview') && r.ok(),
  );

test('the columns and the wording of the purchase order are chosen, previewed and saved', async ({
  page,
}) => {
  await login(page, USERS.admin);
  const firstPreview = previewResponse(page);
  await openDocument(page, 'Bon de commande fournisseur');
  // The preview is a PDF drawn by the server.
  const res = await firstPreview;
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.locator('iframe[title="Aperçu du PDF"]')).toBeVisible();

  // The designation cannot be taken off; the columns of the paper order are shown.
  await expect(page.getByLabel('Afficher la colonne Désignation du produit')).toBeDisabled();
  await expect(page.getByLabel('Afficher la colonne P.A TTC')).toBeChecked();
  await expect(page.getByLabel('Afficher la colonne Réf. fournisseur')).not.toBeChecked();

  // Another column, another header, another order.
  await page.getByLabel('Afficher la colonne Réf. fournisseur').check();
  await page.getByLabel('En-tête de la colonne Quantité').fill('Qté');
  await page.getByLabel('Monter la colonne Quantité').click();
  const draftPreview = previewResponse(page);
  await page.getByRole('textbox', { name: 'Bas de page' }).fill('Association loi 1901');
  await draftPreview;
  await page.getByLabel('Libellé du total').fill('À régler');

  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Modèle enregistré.')).toBeVisible();
  const [saved] = await query<{
    config: {
      columns: { key: string; label: string }[];
      zones: { footer: string };
      labels: { total: string };
    };
  }>(`select config from app.pdf_template where key = 'purchase_order'`);
  const columns = saved!.config.columns;
  expect(columns.map((c) => c.key)).toContain('ref');
  expect(columns.find((c) => c.key === 'qty')!.label).toBe('Qté');
  // Quantity went up one place: before the unit price it followed.
  expect(columns.map((c) => c.key).indexOf('qty')).toBeLessThan(
    columns.map((c) => c.key).indexOf('unit_incl'),
  );
  expect(saved!.config.zones.footer).toContain('Association loi 1901');
  expect(saved!.config.labels.total).toBe('À régler');

  // It is noted in the journal.
  const journal = await query<{ action: string }>(
    `select action from app.audit_log where entity = 'pdf_template'`,
  );
  expect(journal.map((j) => j.action)).toContain('pdf_template.update');
});

test('the logo of the PDF can be the one of the e-mails or another image of the library', async ({
  page,
}) => {
  const add = async (name: string, type: string, bytes: Buffer) =>
    page.request.post('/api/v1/email-assets', {
      headers: { 'x-episoft-csrf': '1', 'content-type': type, 'x-file-name': name },
      data: bytes,
    });
  await login(page, USERS.admin);
  expect((await add('logo-pdf.png', 'image/png', PNG)).ok()).toBe(true);
  expect((await add('anim.gif', 'image/gif', GIF)).ok()).toBe(true);
  await openDocument(page, 'Bon de commande fournisseur');

  // By default, the same image as the e-mails.
  await expect(page.getByLabel('La même image que les courriels')).toBeChecked();

  // Another image: only the ones a PDF can draw are offered; the preview is drawn again.
  await page.getByLabel('Une autre image de la bibliothèque').check();
  const dialog = page.getByRole('dialog', { name: 'Choisir le logo des PDF' });
  await expect(dialog.getByRole('button', { name: 'Choisir l’image logo-pdf.png' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Choisir l’image anim.gif' })).toHaveCount(0);
  const redrawn = previewResponse(page);
  await dialog.getByRole('button', { name: 'Choisir l’image logo-pdf.png' }).click();
  await expect(page.getByText('Logo des documents enregistré.')).toBeVisible();
  await redrawn;
  const [chosen] = await query<{ value: { source: string; imageId: string } }>(
    `select value from app.setting where key = 'documents.logo'`,
  );
  expect(chosen!.value.source).toBe('IMAGE');
  const [asset] = await query<{ id: string }>(
    `select id from app.email_asset where name = 'logo-pdf.png'`,
  );
  expect(chosen!.value.imageId).toBe(asset!.id);
  await expect(page.getByRole('img', { name: 'Logo des documents PDF' })).toHaveAttribute(
    'src',
    new RegExp(asset!.id),
  );

  // Back to the one of the e-mails.
  await page.getByLabel('La même image que les courriels').check();
  await expect(page.getByLabel('La même image que les courriels')).toBeChecked();
  await expect
    .poll(async () => {
      const [row] = await query<{ value: { source: string } }>(
        `select value from app.setting where key = 'documents.logo'`,
      );
      return row?.value.source;
    })
    .toBe('EMAIL');
});

test('the original comes back, after a confirmation', async ({ page }) => {
  await query(
    `insert into app.pdf_template (key, config) values ('cash_closing', '{"zones":{"header":"<p>Mon en-tête</p>","footer":""},"columns":[],"labels":{},"logo":false}'::jsonb)`,
  );
  await login(page, USERS.admin);
  await openDocument(page, 'Rapport de clôture de caisse');
  await expect(page.getByText('Modifié le')).toBeVisible();
  await page.getByRole('button', { name: 'Rétablir la version d’origine' }).click();
  await page
    .getByRole('dialog', { name: 'Rétablir la version d’origine ?' })
    .getByRole('button', { name: 'Rétablir' })
    .click();
  await expect(page.getByText('Version d’origine rétablie.')).toBeVisible();
  expect(await query(`select 1 from app.pdf_template`)).toHaveLength(0);
});

test('a document without choice of columns shows only its texts', async ({ page }) => {
  await login(page, USERS.admin);
  await openDocument(page, 'Rapports (comptabilité, statistiques)');
  await expect(page.getByText('Colonnes du tableau')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'En-tête' })).toBeVisible();
});

test('the PDF documents are for the administrators only', async ({ page }) => {
  await login(page, USERS.cashier);
  await page.goto('/admin/documents');
  await expect(page).not.toHaveURL(/documents/);
  const res = await page.request.get('/api/v1/pdf-templates');
  expect(res.status()).toBe(403);
});
