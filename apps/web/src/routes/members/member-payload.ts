import type { MemberStatus } from '@episoft/shared';
import type { MemberDetail } from '@/lib/types';

// What the member form holds and what it sends. Pure, so it is tested against the shared schema.

export interface MemberFormState {
  lastName: string;
  firstName: string;
  street: string;
  postcode: string;
  communeId: string;
  phone: string;
  email: string;
  status: MemberStatus;
  publicVisible: boolean;
  newsletter: boolean;
  ticketEmailOptOut: boolean;
  imageConsent: boolean;
  username: string;
}

export const EMPTY_MEMBER_FORM: MemberFormState = {
  lastName: '',
  firstName: '',
  street: '',
  postcode: '',
  communeId: '',
  phone: '',
  email: '',
  status: 'NEW',
  publicVisible: false,
  newsletter: false,
  ticketEmailOptOut: false,
  imageConsent: false,
  username: '',
};

export function memberToForm(m: MemberDetail): MemberFormState {
  return {
    lastName: m.lastName,
    firstName: m.firstName,
    street: m.street ?? '',
    postcode: m.postcode ?? '',
    communeId: m.communeId ?? '',
    phone: m.phone ?? '',
    email: m.email ?? '',
    status: m.status,
    publicVisible: m.publicVisible,
    newsletter: m.newsletter,
    ticketEmailOptOut: m.ticketEmailOptOut,
    imageConsent: m.imageConsent,
    username: m.username ?? '',
  };
}

export function memberToPayload(f: MemberFormState) {
  return { ...f, communeId: f.communeId || null };
}
