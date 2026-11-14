import { describe, expect, it } from 'vitest';
import { memberCreateSchema } from '@episoft/shared';
import { EMPTY_MEMBER_FORM, memberToPayload, type MemberFormState } from './member-payload';

const form = (over: Partial<MemberFormState> = {}): MemberFormState => ({
  ...EMPTY_MEMBER_FORM,
  ...over,
});
const issues = (f: MemberFormState) => {
  const r = memberCreateSchema.safeParse({ ...memberToPayload(f), householdId: null });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the member form produces a payload the schema accepts', () => {
  it('a first name and a last name are enough', () => {
    expect(issues(form({ lastName: 'Dupont', firstName: 'Marie' }))).toEqual([]);
  });
  it('complete, as typed', () => {
    expect(
      issues(
        form({
          lastName: 'Dupont',
          firstName: 'Marie',
          street: '3 rue du Marais',
          postcode: '60240',
          communeId: '0190a0a0-0000-7000-8000-000000000001',
          phone: '03 44 00 00 00',
          email: 'marie@exemple.fr',
          username: 'marie.d',
          status: 'ACTIVE',
        }),
      ),
    ).toEqual([]);
  });
  it('names the field of each refusal', () => {
    expect(issues(form({ firstName: 'Marie' }))).toEqual(['lastName: Nom requis.']);
    expect(issues(form({ lastName: 'D', firstName: 'M', postcode: '6024' }))).toEqual([
      'postcode: Code postal à 5 chiffres.',
    ]);
    expect(issues(form({ lastName: 'D', firstName: 'M', email: 'pas un mail' }))).toEqual([
      'email: Courriel invalide.',
    ]);
  });
  it('an empty town is sent as null, not as an empty string', () => {
    expect(memberToPayload(form()).communeId).toBeNull();
  });
});
