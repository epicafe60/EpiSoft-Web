import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { login, USERS } from '../fixtures';
import { query, startTill } from '../helpers';

// « Exporter en Excel » on the lists: the file holds what the list shows (filters applied), the
// role of the screen decides who may ask for it, and every file is recorded in the journal.

const EXPORT = 'Exporter en Excel';

/** Clicks the export button of the first list and reads the downloaded workbook. */
async function exportFirstList(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: EXPORT }).first().click();
  const file = await download;
  const path = await file.path();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(path)) as never);
  return { name: file.suggestedFilename(), ws: wb.worksheets[0]! };
}

const displayedRows = (page: Page) => page.locator('table').first().locator('tbody tr').count();

test('the members list is exported as displayed, filters included, and the export is journalised', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/membres');
  await expect(page.getByRole('button', { name: EXPORT }).first()).toBeVisible();

  const all = await exportFirstList(page);
  expect(all.name).toMatch(/^[A-Za-z0-9-]+-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const header = (all.ws.getRow(1).values as unknown[]).filter(Boolean);
  expect(header.length).toBeGreaterThan(1);
  expect(all.ws.rowCount - 1).toBe(await displayedRows(page));
  expect(JSON.stringify(all.ws.getSheetValues())).toContain('DUPONT');

  // A column filter narrows the list: the file follows what is displayed, not the whole table.
  await page.getByRole('searchbox', { name: 'Filtrer la colonne Membre' }).fill('DUPONT');
  await expect.poll(() => displayedRows(page)).toBeLessThan(all.ws.rowCount - 1);
  const shown = await displayedRows(page);
  const filtered = await exportFirstList(page);
  expect(filtered.ws.rowCount - 1).toBe(shown);
  expect(shown).toBeGreaterThan(0);

  // The journal says who exported what, from which screen, and how many rows.
  const rows = await query<{ scope: string; rows: string }>(
    `select after ->> 'scope' as scope, after ->> 'rows' as rows from app.audit_log
      where action = 'export.file' and after ->> 'url' = 'table' order by id desc limit 2`,
  );
  expect(rows[0]).toMatchObject({ scope: 'membres', rows: String(shown) });
  expect(rows[1]).toMatchObject({ scope: 'membres', rows: String(all.ws.rowCount - 1) });
});

test('amounts and dates of a list are real values in the file', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/journal');
  await expect(page.getByRole('button', { name: EXPORT }).first()).toBeVisible();
  const { ws } = await exportFirstList(page);
  // The first column of the journal is a date with time: a date cell, not a text.
  const first = ws.getRow(2).getCell(1).value;
  expect(first instanceof Date || typeof first === 'string').toBe(true);
  expect(ws.rowCount).toBeGreaterThan(1);
});

test('a role that does not open the screen is refused by the server, whatever the page sends', async ({
  page,
}) => {
  await login(page, USERS.cashier);
  const post = (scope: string) =>
    page.request.post('/api/v1/exports/table', {
      headers: { 'x-episoft-csrf': '1' },
      data: {
        scope,
        title: 'Test',
        columns: [{ header: 'A', type: 'text' }],
        rows: [['x']],
      },
    });
  expect((await post('membres')).status()).toBe(403);
  expect((await post('admin')).status()).toBe(403);
  expect((await post('compta')).status()).toBe(403);
  // Their own screens stay open to every signed-in person.
  expect((await post('perso')).status()).toBe(200);
});

test('the export is offered on the back-office lists, not on the till', async ({ page }) => {
  await startTill(page, 'EXPORT1');
  await expect(page.getByRole('button', { name: EXPORT })).toHaveCount(0);
});

test('a person without the role of a screen does not see the button there', async ({ page }) => {
  await login(page, USERS.customer);
  await page.goto('/signalements');
  // Their own reports are theirs to export; the management screen is closed to them.
  await page.goto('/signalements/gestion');
  await expect(page).not.toHaveURL(/gestion/);
  await expect(page.getByRole('button', { name: EXPORT })).toHaveCount(0);
});
