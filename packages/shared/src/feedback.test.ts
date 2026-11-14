import { describe, expect, it } from 'vitest';
import {
  feedbackCommentSchema,
  feedbackCreateSchema,
  feedbackManageSchema,
  formatFeedbackNumber,
  isFeedbackClosed,
  moduleOfPath,
} from './feedback';

const base = {
  kind: 'EVOLUTION',
  module: 'membres',
  title: 'Filtre par commune',
  description: 'Pouvoir filtrer la liste des membres par commune.',
};

describe('feedbackCreateSchema', () => {
  it('accepts an idea without steps, and trims the text', () => {
    const r = feedbackCreateSchema.parse({ ...base, title: '  Filtre par commune  ' });
    expect(r.title).toBe('Filtre par commune');
    expect(r.steps).toBe('');
    expect(r.context).toEqual({});
  });

  it('asks for the steps to reproduce a bug', () => {
    const bad = feedbackCreateSchema.safeParse({ ...base, kind: 'BUG' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['steps'] });
    expect(
      feedbackCreateSchema.safeParse({
        ...base,
        kind: 'BUG',
        steps: '1. Ouvrir la fiche\n2. Enregistrer',
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown type or module, a short title and an endless text', () => {
    for (const bad of [
      { ...base, kind: 'AUTRE' },
      { ...base, module: 'inconnu' },
      { ...base, title: 'abc' },
      { ...base, description: 'court' },
      { ...base, description: 'x'.repeat(4001) },
    ])
      expect(feedbackCreateSchema.safeParse(bad).success).toBe(false);
  });
});

describe('feedbackManageSchema', () => {
  it('changes one field without filling the other', () => {
    expect(feedbackManageSchema.parse({ status: 'DONE' })).toEqual({ status: 'DONE' });
    expect(feedbackManageSchema.parse({ priority: 'HIGH' })).toEqual({ priority: 'HIGH' });
  });
  it('refuses an empty change and an unknown status', () => {
    expect(feedbackManageSchema.safeParse({}).success).toBe(false);
    expect(feedbackManageSchema.safeParse({ status: 'WHATEVER' }).success).toBe(false);
  });
});

describe('the rest', () => {
  it('numbers continuously: SIG-0007', () => {
    expect(formatFeedbackNumber(7)).toBe('SIG-0007');
    expect(formatFeedbackNumber(12345)).toBe('SIG-12345');
  });
  it('knows which statuses are closed', () => {
    expect(isFeedbackClosed('DONE')).toBe(true);
    expect(isFeedbackClosed('REFUSED')).toBe(true);
    expect(isFeedbackClosed('IN_PROGRESS')).toBe(false);
  });
  it('finds the module of a page, not a lookalike', () => {
    expect(moduleOfPath('/membres/foyers/3?x=1')).toBe('membres');
    expect(moduleOfPath('/caisse')).toBe('caisse');
    expect(moduleOfPath('/mon-foyer')).toBe('foyer');
    expect(moduleOfPath('/caissette')).toBe('autre');
    expect(moduleOfPath('/')).toBe('autre');
  });
  it('refuses an empty comment', () => {
    expect(feedbackCommentSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(feedbackCommentSchema.parse({ body: ' Merci ' }).body).toBe('Merci');
  });
});
