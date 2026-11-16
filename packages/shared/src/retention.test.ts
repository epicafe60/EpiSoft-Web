import { describe, expect, it } from 'vitest';
import {
  auditGroupOf,
  AUDIT_ACTIONS,
  changeClassOf,
  DEFAULT_RETENTION,
  inactivityCutoff,
  LEGAL_RETENTIONS,
  RETENTION_CLASSES,
  retentionCutoff,
  retentionRegister,
  retentionSchema,
  retentionWarnings,
  SETTING_DEFAULTS,
  settingSchemas,
} from './index';

const withDuration = (id: string, value: number | null) => ({
  ...DEFAULT_RETENTION,
  durations: { ...DEFAULT_RETENTION.durations, [id]: value },
});

describe('data.retention: legal floors (spec 5.7, ADR 0017)', () => {
  it('accepts the defaults and an empty object (every key takes its default)', () => {
    expect(retentionSchema.safeParse(DEFAULT_RETENTION).success).toBe(true);
    const parsed = retentionSchema.parse({});
    expect(parsed.durations.audit_accounting).toBe(120);
    expect(parsed.nightly).toBe(false);
    expect(settingSchemas['data.retention'].safeParse(SETTING_DEFAULTS['data.retention']).success).toBe(
      true,
    );
  });

  it('refuses the accounting journals below 10 years, quoting the Code de commerce', () => {
    const r = retentionSchema.safeParse(withDuration('audit_accounting', 119));
    expect(r.success).toBe(false);
    const issue = r.error!.issues[0]!;
    expect(issue.path).toEqual(['durations', 'audit_accounting']);
    expect(issue.message).toContain('Obligation légale');
    expect(issue.message).toContain('L123-22');
    expect(retentionSchema.safeParse(withDuration('data_change_accounting', 60)).success).toBe(false);
  });

  it('refuses the ticket journals below 6 years, quoting the Livre des procédures fiscales', () => {
    const r = retentionSchema.safeParse(withDuration('data_change_sales', 71));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain('L102 B');
    expect(retentionSchema.safeParse(withDuration('audit_sales', 72)).success).toBe(true);
  });

  it('refuses a technical value under its safety minimum, and says it is not a legal one', () => {
    const r = retentionSchema.safeParse(withDuration('sync_receipt', 1));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain('Minimum de sécurité');
  });

  it('lets any class be kept for ever (null), never below zero', () => {
    for (const c of RETENTION_CLASSES) {
      expect(retentionSchema.safeParse(withDuration(c.id, null)).success).toBe(true);
      expect(retentionSchema.safeParse(withDuration(c.id, 0)).success).toBe(false);
      expect(retentionSchema.safeParse(withDuration(c.id, 1.5)).success).toBe(false);
    }
  });

  it('every default respects its own floor', () => {
    for (const c of RETENTION_CLASSES)
      if (c.floor && c.defaultValue !== null) expect(c.defaultValue).toBeGreaterThanOrEqual(c.floor.value);
  });

  it('warns, without refusing, under the recommended minimum of a business class', () => {
    const v = retentionSchema.parse(withDuration('data_change_other', 4));
    expect(retentionWarnings(v).map((w) => w.id)).toContain('data_change_other');
    expect(retentionWarnings(DEFAULT_RETENTION)).toEqual([]);
  });

  it('checks the anonymisation delay and the alert thresholds', () => {
    expect(
      retentionSchema.safeParse({ anonymization: { enabled: true, years: 0 } }).success,
    ).toBe(false);
    expect(retentionSchema.safeParse({ alerts: { dbSizeMb: 10 } }).success).toBe(false);
    expect(retentionSchema.safeParse({ alerts: { dbSizeMb: null, diskFreePct: null } }).success).toBe(
      true,
    );
  });
});

describe('retention dates', () => {
  it('computes cutoffs in days and months without overflowing', () => {
    const now = new Date('2026-03-31T10:00:00Z');
    expect(retentionCutoff(now, 90, 'days')!.toISOString()).toBe('2025-12-31T10:00:00.000Z');
    expect(retentionCutoff(now, 1, 'months')!.toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(retentionCutoff(now, 24, 'months')!.toISOString()).toBe('2024-03-31T10:00:00.000Z');
    expect(retentionCutoff(now, null, 'months')).toBeNull();
    expect(inactivityCutoff(now, 3).toISOString()).toBe('2023-03-31T10:00:00.000Z');
  });
});

describe('classification of the journals', () => {
  it('puts every known action of the audit journal in a group', () => {
    const groups = new Set(AUDIT_ACTIONS.map(auditGroupOf));
    expect(groups).toEqual(new Set(['ACCOUNTING', 'SALES', 'SECURITY', 'OTHER']));
    expect(auditGroupOf('entry.validate')).toBe('ACCOUNTING');
    expect(auditGroupOf('sale.create')).toBe('SALES');
    expect(auditGroupOf('auth.login')).toBe('SECURITY');
    expect(auditGroupOf('member.anonymize')).toBe('SECURITY');
    expect(auditGroupOf('product.update')).toBe('OTHER');
    expect(auditGroupOf('retention.purge')).toBe('SECURITY');
  });

  it('keeps the changes of legal tables under the legal floor', () => {
    expect(changeClassOf('entry_line')).toBe('data_change_accounting');
    expect(changeClassOf('wallet_entry')).toBe('data_change_accounting');
    expect(changeClassOf('sale_line')).toBe('data_change_sales');
    expect(changeClassOf('product')).toBe('data_change_other');
  });
});

describe('processing register (lot E)', () => {
  it('lists the legal records, every class with its duration, and the anonymisation', () => {
    const lines = retentionRegister();
    expect(lines.filter((l) => l.nature === 'LEGAL')).toHaveLength(LEGAL_RETENTIONS.length);
    expect(lines.find((l) => l.id === 'email_body')!.duration).toBe('90 jours');
    expect(lines.find((l) => l.id === 'audit_accounting')!.duration).toBe('10 ans');
    expect(lines.find((l) => l.id === 'sales')!.months).toBe(72);
    expect(lines.at(-1)!.id).toBe('inactive_members');
    expect(lines.at(-1)!.duration).toContain('Illimitée');
    const custom = retentionSchema.parse({ anonymization: { enabled: true, years: 3 } });
    expect(retentionRegister(custom).at(-1)!.duration).toContain('3 ans');
  });
});
