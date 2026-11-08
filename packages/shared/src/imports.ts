// R-IMP-01..04 — pure helpers of the import wizard: CSV parsing, column mapping, row normalisation.

export const IMPORT_KINDS = ['products', 'members'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Splits a CSV text into rows. Delimiter (; , or tab) is detected on the first line; quotes, BOM and CRLF are handled. */
export function parseImportCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const delimiter = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** "1 234,56 €" → 1234.56; null when it is not a number. */
export function parseFrNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = raw
    .replace(/[\s\u00A0\u202F\u20AC%]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

export const normalizeHeader = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Normalised header spellings recognised automatically. */
  synonyms: string[];
}

export const PRODUCT_IMPORT_FIELDS: ImportField[] = [
  {
    key: 'code',
    label: 'Code produit',
    required: true,
    synonyms: ['code', 'code produit', 'reference', 'ref'],
  },
  {
    key: 'name',
    label: 'Nom',
    required: true,
    synonyms: ['nom', 'designation', 'libelle', 'produit'],
  },
  {
    key: 'ean',
    label: 'Code-barres (EAN)',
    synonyms: ['ean', 'code barres', 'code barre', 'gtin'],
  },
  { key: 'supplierName', label: 'Fournisseur', synonyms: ['fournisseur'] },
  {
    key: 'supplierRef',
    label: 'Réf. fournisseur',
    synonyms: ['ref fournisseur', 'reference fournisseur'],
  },
  {
    key: 'purchasePrice',
    label: "Prix d'achat",
    synonyms: ['prix fournisseur', 'prix achat', 'prix d achat', 'pa'],
  },
  { key: 'priceType', label: 'Type de prix (HT/TTC)', synonyms: ['type de prix', 'type prix'] },
  { key: 'vatRate', label: 'TVA %', synonyms: ['taux tva', 'tva'] },
  { key: 'salePrice', label: 'Prix de vente', synonyms: ['prix de vente', 'prix vente', 'pv'] },
  { key: 'stock', label: 'Stock', synonyms: ['stock', 'quantite'] },
  { key: 'description', label: 'Description', synonyms: ['description'] },
];

export const MEMBER_IMPORT_FIELDS: ImportField[] = [
  { key: 'lastName', label: 'Nom', required: true, synonyms: ['nom'] },
  { key: 'firstName', label: 'Prénom', required: true, synonyms: ['prenom'] },
  { key: 'email', label: 'Courriel', synonyms: ['courriel', 'email', 'e mail', 'mail'] },
  { key: 'phone', label: 'Téléphone', synonyms: ['telephone', 'tel', 'mobile'] },
  { key: 'username', label: 'Identifiant', synonyms: ['identifiant', 'login'] },
  { key: 'balance', label: 'Solde cagnotte', synonyms: ['solde', 'cagnotte'] },
  {
    key: 'epicerioNumber',
    label: 'N° membre',
    synonyms: ['n membre', 'numero membre', 'numero', 'n'],
  },
];

export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  products: PRODUCT_IMPORT_FIELDS,
  members: MEMBER_IMPORT_FIELDS,
};

/** Annexe D — fixed column positions of the Epicerio exports (0-based). */
export const EPICERIO_COLUMNS: Record<ImportKind, Record<string, number>> = {
  products: {
    name: 1,
    code: 2,
    purchasePrice: 4,
    priceType: 5,
    vatRate: 6,
    salePrice: 8,
    description: 13,
    supplierName: 15,
    supplierRef: 16,
    stock: 17,
  },
  members: {
    balance: 1,
    firstName: 2,
    lastName: 3,
    epicerioNumber: 4,
    email: 6,
    username: 7,
    phone: 12,
  },
};

/** Field → column index, from the header names; fields without a match are left out. */
export function autoMapColumns(headers: string[], kind: ImportKind): Record<string, number> {
  const norm = headers.map(normalizeHeader);
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of IMPORT_FIELDS[kind]) {
    const idx = norm.findIndex((h, i) => !used.has(i) && f.synonyms.includes(h));
    if (idx >= 0) {
      mapping[f.key] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

/** True when the first row looks like a header (the Epicerio files start with one). */
export const looksLikeHeader = (row: string[], kind: ImportKind): boolean => {
  const idx = EPICERIO_COLUMNS[kind].code ?? EPICERIO_COLUMNS[kind].balance;
  return idx !== undefined && parseFrNumber(row[idx]) === null;
};

export type ImportRecord = Record<string, string>;

export function toRecords(rows: string[][], mapping: Record<string, number>): ImportRecord[] {
  return rows.map((r) =>
    Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, (r[i] ?? '').trim()])),
  );
}

export interface ProductImport {
  code: string;
  name: string;
  ean: string | null;
  supplierName: string | null;
  supplierRef: string | null;
  /** Purchase price excl. VAT, in ten-thousandths of an euro (price4), or null. */
  purchaseExcl4: number | null;
  /** Sale price in cents, or null. */
  salePriceCents: number | null;
  vatRate: number | null;
  /** Stock in thousandths, or null. */
  stockMilli: number | null;
  description: string | null;
}

export interface RowIssue {
  message: string;
}

/** Cleans a product row: prices in HT, comma decimals, empty strings as null. */
export function normalizeProduct(r: ImportRecord): { value?: ProductImport; error?: string } {
  const code = (r.code ?? '').trim();
  const name = (r.name ?? '').trim();
  if (!code) return { error: 'Code produit manquant.' };
  if (!name) return { error: 'Nom manquant.' };
  const vat = parseFrNumber(r.vatRate);
  const purchase = parseFrNumber(r.purchasePrice);
  const isIncl = /ttc/i.test(r.priceType ?? '');
  const factor = vat !== null && isIncl ? 1 + vat / 100 : 1;
  const sale = parseFrNumber(r.salePrice);
  const stock = parseFrNumber(r.stock);
  if (r.salePrice && sale === null) return { error: 'Prix de vente invalide.' };
  if (r.purchasePrice && purchase === null) return { error: "Prix d'achat invalide." };
  if (sale !== null && sale < 0) return { error: 'Prix de vente négatif.' };
  return {
    value: {
      code,
      name,
      ean: (r.ean ?? '').replace(/\s/g, '') || null,
      supplierName: (r.supplierName ?? '').trim() || null,
      supplierRef: (r.supplierRef ?? '').trim() || null,
      purchaseExcl4: purchase === null ? null : Math.round((purchase / factor) * 10_000),
      salePriceCents: sale === null ? null : Math.round(sale * 100),
      vatRate: vat,
      stockMilli: stock === null ? null : Math.round(stock * 1000),
      description: (r.description ?? '').trim() || null,
    },
  };
}

export interface MemberImport {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  balanceCents: number | null;
}

export function normalizeMember(r: ImportRecord): { value?: MemberImport; error?: string } {
  const firstName = (r.firstName ?? '').trim();
  const lastName = (r.lastName ?? '').trim();
  if (!firstName || !lastName) return { error: 'Nom ou prénom manquant.' };
  // The limits of the member form (memberFields): a file cannot store what the form refuses.
  if (firstName.length > 100 || lastName.length > 100) return { error: 'Nom ou prénom trop long.' };
  const email = (r.email ?? '').trim().toLowerCase();
  if (email && (email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))
    return { error: 'Courriel invalide.' };
  const phone = (r.phone ?? '').replace(/\s/g, '');
  if (phone.length > 30) return { error: 'Téléphone trop long.' };
  // A user name never looks like an e-mail: the sign-in accepts both, they must not collide.
  const username = (r.username ?? '').trim();
  if (username && (username.length > 100 || !/^[\p{L}0-9_.-]+$/u.test(username)))
    return { error: 'Identifiant invalide (lettres, chiffres, _ . - seulement).' };
  const balance = parseFrNumber(r.balance);
  if (r.balance && balance === null) return { error: 'Solde invalide.' };
  return {
    value: {
      firstName,
      lastName,
      email: email || null,
      phone: phone || null,
      username: username || null,
      balanceCents: balance === null ? null : Math.round(balance * 100),
    },
  };
}

/** Which of the optional update fields the user may choose for an existing product (R-IMP-01). */
export const PRODUCT_UPDATE_FIELDS = ['purchasePrice', 'salePrice', 'stock'] as const;
export type ProductUpdateField = (typeof PRODUCT_UPDATE_FIELDS)[number];
