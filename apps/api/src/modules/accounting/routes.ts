import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  account,
  entry,
  entryLine,
  entryTemplate,
  entryTemplateCategory,
  entryTemplateLine,
  fiscalYear,
  journal,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  accountSchema,
  decimalToCents,
  entryInputSchema,
  fiscalYearSchema,
  formatEntryNumber,
  journalSchema,
  reverseSchema,
  templateSchema,
  validateEntriesSchema,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import {
  createEntry,
  entryDetail,
  replaceDraftLines,
  reverseEntry,
  validateEntries,
} from './service';

const idParams = { params: z.object({ id: z.string().uuid() }) };

const isExclusionViolation = (e: unknown) =>
  (e as { cause?: { code?: string } })?.cause?.code === '23P01';

type EntryBody = z.infer<typeof entryInputSchema>;
const toLines = (b: EntryBody) =>
  b.lines.map((l) => ({
    accountId: l.accountId,
    label: l.label || b.label,
    debitCents: decimalToCents(l.debit),
    creditCents: decimalToCents(l.credit),
  }));

export const accountingRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };

  // --- Chart of accounts (R-CPT-01) --------------------------------------------------------

  app.get(
    '/accounts',
    {
      ...compta,
      schema: {
        querystring: z.object({
          q: z.string().max(60).optional(),
          active: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(500),
        }),
      },
    },
    async (req) => {
      const f: SQL[] = [];
      const q = req.query.q?.trim();
      // R-CPT-07: by number (prefix) or label.
      if (q) f.push(or(sql`${account.number} like ${q + '%'}`, ilike(account.label, `%${q}%`))!);
      if (req.query.active) f.push(eq(account.active, req.query.active === 'true'));
      return db
        .select({
          id: account.id,
          number: account.number,
          label: account.label,
          normalSide: account.normalSide,
          active: account.active,
          used: sql<boolean>`exists (select 1 from app.entry_line l where l.account_id = ${account.id})`,
        })
        .from(account)
        .where(and(...f))
        .orderBy(account.number)
        .limit(req.query.limit);
    },
  );

  app.post('/accounts', { ...compta, schema: { body: accountSchema } }, async (req) =>
    db.transaction(async (tx) => {
      if (await tx.query.account.findFirst({ where: eq(account.number, req.body.number) }))
        throw conflict(`Le compte ${req.body.number} existe déjà.`);
      const [a] = await tx.insert(account).values(req.body).returning();
      await audit(tx, req, {
        action: 'account.create',
        entity: 'account',
        entityId: a!.id,
        after: a,
      });
      return a;
    }),
  );

  app.put(
    '/accounts/:id',
    { ...compta, schema: { ...idParams, body: accountSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(account).where(eq(account.id, req.params.id));
        if (!before) throw notFound('Compte introuvable.');
        if (before.number !== req.body.number) {
          const [used] = await tx
            .select({ id: entryLine.id })
            .from(entryLine)
            .where(eq(entryLine.accountId, before.id))
            .limit(1);
          if (used) throw conflict('Le numéro d’un compte déjà utilisé ne peut plus changer.');
          if (await tx.query.account.findFirst({ where: eq(account.number, req.body.number) }))
            throw conflict(`Le compte ${req.body.number} existe déjà.`);
        }
        const [after] = await tx
          .update(account)
          .set(req.body)
          .where(eq(account.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'account.update',
          entity: 'account',
          entityId: before.id,
          before,
          after,
        });
        return after;
      }),
  );

  /** R-CPT-01: an account that has been used cannot be deleted (it can be deactivated). */
  app.delete('/accounts/:id', { ...compta, schema: idParams }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const [a] = await tx.select().from(account).where(eq(account.id, req.params.id));
      if (!a) throw notFound('Compte introuvable.');
      const [used] = await tx
        .select({ id: entryLine.id })
        .from(entryLine)
        .where(eq(entryLine.accountId, a.id))
        .limit(1);
      const [inTemplate] = await tx
        .select({ id: entryTemplateLine.id })
        .from(entryTemplateLine)
        .where(eq(entryTemplateLine.accountId, a.id))
        .limit(1);
      if (used || inTemplate)
        throw conflict('Ce compte est utilisé : désactivez-le plutôt que le supprimer.');
      await tx.delete(account).where(eq(account.id, a.id));
      await audit(tx, req, {
        action: 'account.delete',
        entity: 'account',
        entityId: a.id,
        before: a,
      });
    });
    return reply.status(204).send();
  });

  // --- Journals (R-CPT-02) -------------------------------------------------------------------

  app.get('/journals', compta, async () =>
    db.select().from(journal).orderBy(journal.sort, journal.code),
  );

  app.post('/journals', { ...compta, schema: { body: journalSchema } }, async (req) =>
    db.transaction(async (tx) => {
      if (await tx.query.journal.findFirst({ where: eq(journal.code, req.body.code) }))
        throw conflict('Ce code de journal existe déjà.');
      const [j] = await tx.insert(journal).values(req.body).returning();
      await audit(tx, req, {
        action: 'journal.create',
        entity: 'journal',
        entityId: j!.id,
        after: j,
      });
      return j;
    }),
  );

  app.put(
    '/journals/:id',
    { ...compta, schema: { ...idParams, body: journalSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(journal).where(eq(journal.id, req.params.id));
        if (!before) throw notFound('Journal introuvable.');
        if (before.code !== req.body.code) {
          const [used] = await tx
            .select({ id: entry.id })
            .from(entry)
            .where(eq(entry.journalId, before.id))
            .limit(1);
          if (used) throw conflict('Le code d’un journal utilisé ne peut plus changer.');
        }
        const [after] = await tx
          .update(journal)
          .set(req.body)
          .where(eq(journal.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'journal.update',
          entity: 'journal',
          entityId: before.id,
          before,
          after,
        });
        return after;
      }),
  );

  // --- Fiscal years (R-CPT-03) -----------------------------------------------------------------

  app.get('/fiscal-years', compta, async () =>
    db
      .select({
        id: fiscalYear.id,
        label: fiscalYear.label,
        startDate: fiscalYear.startDate,
        endDate: fiscalYear.endDate,
        status: fiscalYear.status,
        entries: sql<number>`(select count(*)::int from app.entry e where e.fiscal_year_id = ${fiscalYear.id})`,
        drafts: sql<number>`(select count(*)::int from app.entry e where e.fiscal_year_id = ${fiscalYear.id} and e.status = 'DRAFT')`,
      })
      .from(fiscalYear)
      .orderBy(desc(fiscalYear.startDate)),
  );

  app.post('/fiscal-years', { ...compta, schema: { body: fiscalYearSchema } }, async (req) => {
    try {
      return await db.transaction(async (tx) => {
        const [y] = await tx.insert(fiscalYear).values(req.body).returning();
        await audit(tx, req, {
          action: 'fiscal_year.create',
          entity: 'fiscal_year',
          entityId: y!.id,
          after: y,
        });
        return y;
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw conflict('Cet exercice en chevauche un autre.');
      throw e;
    }
  });

  // --- Entries (R-CPT-04..07) --------------------------------------------------------------------

  const listQuery = z.object({
    fiscalYearId: z.string().uuid().optional(),
    journalId: z.string().uuid().optional(),
    status: z.enum(['DRAFT', 'VALIDATED']).optional(),
    accountId: z.string().uuid().optional(),
    q: z.string().max(100).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get('/entries', { ...compta, schema: { querystring: listQuery } }, async (req) => {
    const q = req.query;
    const f: SQL[] = [];
    if (q.fiscalYearId) f.push(eq(entry.fiscalYearId, q.fiscalYearId));
    if (q.journalId) f.push(eq(entry.journalId, q.journalId));
    if (q.status) f.push(eq(entry.status, q.status));
    if (q.from) f.push(sql`${entry.date} >= ${q.from}`);
    if (q.to) f.push(sql`${entry.date} <= ${q.to}`);
    if (q.accountId)
      f.push(
        sql`exists (select 1 from app.entry_line l where l.entry_id = ${entry.id} and l.account_id = ${q.accountId})`,
      );
    if (q.q) f.push(or(ilike(entry.label, `%${q.q}%`), ilike(entry.pieceRef, `%${q.q}%`))!);
    const rows = await db
      .select({
        id: entry.id,
        date: entry.date,
        label: entry.label,
        pieceRef: entry.pieceRef,
        status: entry.status,
        number: entry.number,
        journalCode: journal.code,
        year: sql<string>`extract(year from ${fiscalYear.startDate})::text`,
        sourceType: entry.sourceType,
        total: sql<string>`(select coalesce(sum(debit), 0)::numeric(12,2)::text from app.entry_line l where l.entry_id = ${entry.id})`,
        reverses: entry.reversesEntryId,
      })
      .from(entry)
      .innerJoin(journal, eq(journal.id, entry.journalId))
      .innerJoin(fiscalYear, eq(fiscalYear.id, entry.fiscalYearId))
      .where(and(...f))
      .orderBy(desc(entry.date), desc(entry.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    return rows.map((r) => ({
      ...r,
      displayNumber:
        r.number !== null ? formatEntryNumber(r.journalCode, Number(r.year), r.number) : null,
    }));
  });

  app.get('/entries/:id', { ...compta, schema: idParams }, async (req) => {
    const d = await entryDetail(db, req.params.id);
    if (!d) throw notFound('Écriture introuvable.');
    return d;
  });

  app.post('/entries', { ...compta, schema: { body: entryInputSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const b = req.body;
      const id = await createEntry(tx, {
        journalId: b.journalId,
        date: b.date,
        pieceRef: b.pieceRef,
        label: b.label,
        mode: b.mode,
        lines: toLines(b),
        userId: req.user!.id,
      });
      await audit(tx, req, {
        action: 'entry.create',
        entity: 'entry',
        entityId: id,
        after: { label: b.label, date: b.date, lines: b.lines.length },
      });
      return { id };
    }),
  );

  /** R-CPT-05 / CA: a validated entry cannot be modified by the API (409). */
  app.put(
    '/entries/:id',
    { ...compta, schema: { ...idParams, body: entryInputSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const b = req.body;
        const [before] = await tx
          .select()
          .from(entry)
          .where(eq(entry.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Écriture introuvable.');
        if (before.status === 'VALIDATED')
          throw conflict('Cette écriture est validée : contre-passez-la pour la corriger.');
        const fy = await tx.query.fiscalYear.findFirst({
          where: and(
            sql`${fiscalYear.startDate} <= ${b.date}`,
            sql`${fiscalYear.endDate} >= ${b.date}`,
          ),
        });
        if (!fy) throw badRequest('Aucun exercice ne couvre cette date.');
        if (fy.status !== 'OPEN') throw conflict(`L’exercice ${fy.label} est clôturé.`);
        await replaceDraftLines(tx, before.id, toLines(b));
        await tx
          .update(entry)
          .set({
            journalId: b.journalId,
            fiscalYearId: fy.id,
            date: b.date,
            pieceRef: b.pieceRef,
            label: b.label,
            mode: b.mode,
          })
          .where(eq(entry.id, before.id));
        await audit(tx, req, {
          action: 'entry.update',
          entity: 'entry',
          entityId: before.id,
          before: { label: before.label, date: before.date },
          after: { label: b.label, date: b.date },
        });
        return { id: before.id };
      }),
  );

  app.delete('/entries/:id', { ...compta, schema: idParams }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const [e] = await tx.select().from(entry).where(eq(entry.id, req.params.id)).for('update');
      if (!e) throw notFound('Écriture introuvable.');
      if (e.status === 'VALIDATED')
        throw conflict('Une écriture validée ne se supprime pas : contre-passez-la.');
      await tx.delete(entry).where(eq(entry.id, e.id));
      await audit(tx, req, {
        action: 'entry.delete',
        entity: 'entry',
        entityId: e.id,
        before: { label: e.label, date: e.date, source: e.sourceType },
      });
    });
    return reply.status(204).send();
  });

  /** R-CPT-06 "Dupliquer": a new draft with the same lines. */
  app.post(
    '/entries/:id/duplicate',
    { ...compta, schema: { ...idParams, body: z.object({ date: z.string().date().optional() }) } },
    async (req) =>
      db.transaction(async (tx) => {
        const orig = await entryDetail(tx, req.params.id);
        if (!orig) throw notFound('Écriture introuvable.');
        const id = await createEntry(tx, {
          journalId: orig.journalId,
          date: req.body.date ?? orig.date,
          pieceRef: orig.pieceRef,
          label: orig.label,
          mode: orig.mode,
          userId: req.user!.id,
          lines: orig.lines.map((l) => ({
            accountId: l.accountId,
            label: l.label,
            debitCents: decimalToCents(l.debit),
            creditCents: decimalToCents(l.credit),
          })),
        });
        await audit(tx, req, {
          action: 'entry.duplicate',
          entity: 'entry',
          entityId: id,
          after: { from: orig.id },
        });
        return { id };
      }),
  );

  /** R-CPT-05: bulk validation, by ids or by period. */
  app.post(
    '/entries/validate',
    { ...compta, schema: { body: validateEntriesSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const b = req.body;
        let ids = b.ids ?? [];
        if (!b.ids) {
          if (!b.from || !b.to) throw badRequest('Indiquez les écritures ou la période à valider.');
          const f: SQL[] = [
            eq(entry.status, 'DRAFT'),
            sql`${entry.date} >= ${b.from}`,
            sql`${entry.date} <= ${b.to}`,
          ];
          if (b.journalId) f.push(eq(entry.journalId, b.journalId));
          ids = (
            await tx
              .select({ id: entry.id })
              .from(entry)
              .where(and(...f))
          ).map((r) => r.id);
        }
        const r = await validateEntries(tx, ids, req.user!.id);
        await audit(tx, req, {
          action: 'entry.validate',
          entity: 'entry',
          after: { count: r.validated, from: b.from ?? null, to: b.to ?? null },
        });
        return r;
      }),
  );

  app.post(
    '/entries/:id/reverse',
    { ...compta, schema: { ...idParams, body: reverseSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const id = await reverseEntry(tx, req.params.id, { ...req.body, userId: req.user!.id });
        await audit(tx, req, {
          action: 'entry.reverse',
          entity: 'entry',
          entityId: req.params.id,
          after: { reversal: id },
        });
        return { id };
      }),
  );

  // --- Templates / "guides" (R-CPT-06) ---------------------------------------------------------------

  app.get('/entry-template-categories', compta, async () =>
    db.select().from(entryTemplateCategory).orderBy(entryTemplateCategory.sort),
  );

  const templateRows = async (tx: Db | Tx, id?: string) => {
    const templates = await tx
      .select({ t: entryTemplate, journalCode: journal.code })
      .from(entryTemplate)
      .innerJoin(journal, eq(journal.id, entryTemplate.journalId))
      .where(id ? eq(entryTemplate.id, id) : undefined)
      .orderBy(entryTemplate.label);
    const lines = templates.length
      ? await tx
          .select({ l: entryTemplateLine, number: account.number, accountLabel: account.label })
          .from(entryTemplateLine)
          .innerJoin(account, eq(account.id, entryTemplateLine.accountId))
          .where(
            inArray(
              entryTemplateLine.templateId,
              templates.map((x) => x.t.id),
            ),
          )
          .orderBy(entryTemplateLine.lineNo)
      : [];
    return templates.map(({ t, journalCode }) => ({
      id: t.id,
      categoryCode: t.categoryCode,
      journalId: t.journalId,
      journalCode,
      label: t.label,
      mode: t.mode,
      active: t.active,
      lines: lines
        .filter((x) => x.l.templateId === t.id)
        .map((x) => ({
          id: x.l.id,
          accountId: x.l.accountId,
          accountNumber: x.number,
          accountLabel: x.accountLabel,
          label: x.l.label,
          debit: x.l.debit,
          credit: x.l.credit,
        })),
    }));
  };

  app.get('/entry-templates', compta, async () => templateRows(db));

  const writeTemplate = async (tx: Tx, id: string, b: z.infer<typeof templateSchema>) => {
    await tx.delete(entryTemplateLine).where(eq(entryTemplateLine.templateId, id));
    await tx
      .insert(entryTemplateLine)
      .values(
        b.lines.map((l, i) => ({
          templateId: id,
          lineNo: i + 1,
          accountId: l.accountId,
          label: l.label,
          debit: l.debit,
          credit: l.credit,
        })),
      );
  };

  app.post('/entry-templates', { ...compta, schema: { body: templateSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const { lines: _l, ...head } = req.body;
      const [t] = await tx.insert(entryTemplate).values(head).returning();
      await writeTemplate(tx, t!.id, req.body);
      await audit(tx, req, {
        action: 'template.create',
        entity: 'entry_template',
        entityId: t!.id,
        after: head,
      });
      return { id: t!.id };
    }),
  );

  app.put(
    '/entry-templates/:id',
    { ...compta, schema: { ...idParams, body: templateSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const { lines: _l, ...head } = req.body;
        const [t] = await tx
          .update(entryTemplate)
          .set(head)
          .where(eq(entryTemplate.id, req.params.id))
          .returning();
        if (!t) throw notFound('Guide introuvable.');
        await writeTemplate(tx, t.id, req.body);
        await audit(tx, req, {
          action: 'template.update',
          entity: 'entry_template',
          entityId: t.id,
          after: head,
        });
        return { id: t.id };
      }),
  );

  app.delete('/entry-templates/:id', { ...compta, schema: idParams }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const [t] = await tx
        .delete(entryTemplate)
        .where(eq(entryTemplate.id, req.params.id))
        .returning();
      if (!t) throw notFound('Guide introuvable.');
      await audit(tx, req, {
        action: 'template.delete',
        entity: 'entry_template',
        entityId: t.id,
        before: { label: t.label },
      });
    });
    return reply.status(204).send();
  });

  /** R-CPT-06 "Enregistrer comme guide": from an existing entry; amounts kept only on request. */
  app.post(
    '/entries/:id/save-as-template',
    {
      ...compta,
      schema: {
        ...idParams,
        body: z.object({
          label: z.string().trim().min(1).max(100),
          categoryCode: z.string().max(10).nullable(),
          keepAmounts: z.boolean().default(false),
        }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const e = await entryDetail(tx, req.params.id);
        if (!e) throw notFound('Écriture introuvable.');
        const [t] = await tx
          .insert(entryTemplate)
          .values({
            label: req.body.label,
            categoryCode: req.body.categoryCode,
            journalId: e.journalId,
            mode: e.mode,
          })
          .returning();
        await tx.insert(entryTemplateLine).values(
          e.lines.map((l, i) => ({
            templateId: t!.id,
            lineNo: i + 1,
            accountId: l.accountId,
            label: l.label,
            debit: req.body.keepAmounts && decimalToCents(l.debit) > 0 ? l.debit : null,
            credit: req.body.keepAmounts && decimalToCents(l.credit) > 0 ? l.credit : null,
          })),
        );
        await audit(tx, req, {
          action: 'template.create',
          entity: 'entry_template',
          entityId: t!.id,
          after: { from: e.id },
        });
        return { id: t!.id };
      }),
  );
};
