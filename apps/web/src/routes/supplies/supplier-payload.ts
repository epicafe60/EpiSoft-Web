import type { SupplierInput } from '@episoft/shared';
import type { SupplierDetail } from '@/lib/types-supplies';

// What the supplier form holds and what it sends. Pure, so it is tested against the schema.

export type SupplierFormState = Required<Omit<SupplierInput, 'code' | 'region'>> & {
  code: string;
  region: string;
};

export const EMPTY_SUPPLIER_FORM: SupplierFormState = {
  code: '',
  region: '',
  name: '',
  contact: '',
  street: '',
  postcode: '',
  communeId: null,
  phone: '',
  email: '',
  website: '',
  priceListUrl: '',
  active: true,
  publicNotes: '',
  privateNotes: '',
  referentMemberId: null,
  sendsPo: true,
  accountNumber: '',
  minOrderAmount: null,
  paymentTermsDays: 30,
  payAtMonthEnd: false,
  deliveryDay: '',
};

export function supplierToForm(s: SupplierDetail): SupplierFormState {
  return {
    code: s.code,
    region: s.code.slice(0, 2),
    name: s.name,
    contact: s.contact ?? '',
    street: s.street ?? '',
    postcode: s.postcode ?? '',
    communeId: s.communeId,
    phone: s.phone ?? '',
    email: s.email ?? '',
    website: s.website ?? '',
    priceListUrl: s.priceListUrl ?? '',
    active: s.active,
    publicNotes: s.publicNotes ?? '',
    privateNotes: s.privateNotes ?? '',
    referentMemberId: s.referentMemberId,
    sendsPo: s.sendsPo,
    accountNumber: s.accountNumber ?? '',
    minOrderAmount: s.minOrderAmount,
    paymentTermsDays: s.paymentTermsDays,
    payAtMonthEnd: s.payAtMonthEnd,
    deliveryDay: s.deliveryDay ?? '',
  };
}

/** The body sent to the API: a new supplier sends its region (or code), an existing one its code if changed. */
export function supplierPayload(f: SupplierFormState, existing: { code: string } | null) {
  const { code, region, ...rest } = f;
  return {
    ...rest,
    minOrderAmount: f.minOrderAmount || null,
    ...(existing
      ? code !== existing.code
        ? { code }
        : {}
      : code
        ? { code }
        : { region: region || '99' }),
  };
}
