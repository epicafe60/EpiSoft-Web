import { eq } from 'drizzle-orm';
import { cashCount, cashSession, type DbOrTx } from '@episoft/db';
import {
  DENOMINATIONS,
  fillZone,
  formatVatRate,
  identityAddress,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  pdfTemplateDef,
  type Values,
} from '@episoft/shared';
import { formatShop } from '../../lib/dates';
import { eur, keyValues, render, table, pdfText } from '../../lib/pdf';
import {
  associationValues,
  drawHeader,
  installFooter,
  loadPdfConfig,
  loadPdfLogo,
} from '../../lib/pdf-template';
import { loadSettings } from '../admin/settings-store';
import { sessionSummary, type SessionSummary } from './closing';
import { sessionVat } from './closing-vat';

/** R-SES-02 step 6: closing report as PDF (sent to the treasurer, downloadable). */
export async function closingPdf(db: DbOrTx, sessionId: string): Promise<Buffer> {
  const s = await db.query.cashSession.findFirst({ where: eq(cashSession.id, sessionId) });
  if (!s) throw new Error('session not found');
  const count = await db.query.cashCount.findFirst({ where: eq(cashCount.sessionId, s.id) });
  const summary = count ? (count.summary as SessionSummary) : await sessionSummary(db, s.id);
  const settings = await loadSettings(db);
  const vat = await sessionVat(db, s.id);
  const def = pdfTemplateDef('cash_closing')!;
  const { config } = await loadPdfConfig(db, 'cash_closing');
  const logo = config.logo ? await loadPdfLogo(db) : null;
  const values: Values = {
    ...associationValues(settings['association.identity']),
    date_session: formatShop(s.openedAt).slice(0, 10),
    ouverture: formatShop(s.openedAt),
    cloture: s.closedAt ? formatShop(s.closedAt) : 'session ouverte',
  };
  return render((doc) => {
    // The header and the footer are the template's; the figures of the session are the report.
    installFooter(doc, fillZone(config.zones.footer ?? '', values, def.variables), 40, 515);
    doc.y = drawHeader(
      doc,
      fillZone(config.zones.header ?? '', values, def.variables),
      logo,
      40,
      40,
      515,
    );
    doc.x = 40;
    doc.moveDown();
    // R-TVA-05: who sold, and the VAT included in the sales by rate.
    const identity = settings['association.identity'];
    keyValues(
      doc,
      [
        ['Association', pdfText(identity.name)],
        ...(identityAddress(identity)
          ? [['Adresse', pdfText(identityAddress(identity)!)] as [string, string]]
          : []),
        ...(identity.siren ? [['SIREN', identity.siren] as [string, string]] : []),
      ],
      { width: 330 },
    );
    doc.moveDown();
    keyValues(
      doc,
      [
        ['Tickets', `${summary.salesCount} (annulations : ${summary.cancellationsCount})`],
        ['Total des ventes', eur(summary.salesTotal)],
        ...PAYMENT_METHODS.map(
          (m) => [PAYMENT_METHOD_LABELS[m], eur(summary.byMethod[m] ?? '0')] as [string, string],
        ),
        ['Encaissements hors ventes en espèces', eur(summary.cashOther)],
        ['Fond initial', eur(summary.openingFloat)],
        // R-EVO-06: shared session, sub-totals by cashier.
        ...((summary.byCashier?.length ?? 0) > 1
          ? summary.byCashier!.map(
              (c) =>
                [`Ventes de ${pdfText(c.name)}`, `${eur(c.total)} (${c.salesCount})`] as [
                  string,
                  string,
                ],
            )
          : []),
      ],
      { width: 330 },
    );
    doc.moveDown();
    // Only the tickets of the LIABLE regime carry a breakdown; the others print their mention.
    if (vat.breakdown.byRate.length > 0) {
      table(
        doc,
        [
          { header: 'TVA incluse', width: 90 },
          { header: 'Ventes TTC', width: 80, align: 'right' },
          { header: 'Montant HT', width: 80, align: 'right' },
          { header: 'TVA', width: 80, align: 'right' },
        ],
        [
          ...vat.breakdown.byRate.map((r) => [
            formatVatRate(r.rate),
            eur(r.inclCents / 100),
            eur(r.exclCents / 100),
            eur(r.vatCents / 100),
          ]),
          [
            'Total',
            eur(vat.breakdown.inclCents / 100),
            eur(vat.breakdown.exclCents / 100),
            eur(vat.breakdown.vatCents / 100),
          ],
        ],
      );
    }
    for (const u of vat.untaxed)
      doc
        .moveDown(0.5)
        .fontSize(10)
        .text(`${u.mention} : ${eur(u.inclCents / 100)} de ventes`);
    if (vat.breakdown.outOfScopeCents !== 0)
      doc
        .moveDown(0.5)
        .fontSize(9)
        .text(`Dons hors champ de la TVA : ${eur(vat.breakdown.outOfScopeCents / 100)}`);
    if (count) {
      doc.moveDown();
      keyValues(
        doc,
        [
          ['Espèces théoriques', eur(count.expectedCash)],
          ['Espèces comptées', eur(count.countedCash)],
          ['Écart', eur(count.difference)],
          ['Dépôt en banque', eur(count.bankDeposit)],
          ['Nouveau fond de caisse', eur(count.nextFloat)],
          [
            'Chèques',
            `${count.chequesCount} · ${eur(count.chequesTotal)} (calculé ${eur(summary.chequesComputed)})`,
          ],
          [
            'Cartes déclarées',
            `${eur(count.cardTotalDeclared)} (calculé ${eur(summary.cardComputed)})`,
          ],
        ],
        { width: 330, bold: ['Écart'] },
      );
      doc.moveDown();
      const counts = count.denominations as Record<string, number>;
      table(
        doc,
        [
          { header: 'Valeur', width: 80 },
          { header: 'Nombre', width: 60, align: 'right' },
          { header: 'Montant', width: 80, align: 'right' },
        ],
        DENOMINATIONS.filter((d) => counts[String(d)]).map((d) => [
          d >= 100 ? `${d / 100} €` : `${d} c`,
          String(counts[String(d)]),
          eur((d * counts[String(d)]!) / 100),
        ]),
      );
      if (count.comment) doc.moveDown().fontSize(10).text(`Commentaire : ${count.comment}`);
    }
  });
}
