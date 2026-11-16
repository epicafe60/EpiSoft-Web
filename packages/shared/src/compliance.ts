import { z } from 'zod';

// Product information and claims that the law makes mandatory: allergens (règlement UE 1169/2011,
// annexe II), ingredients and net quantity, origin of the products for which it is compulsory,
// « bio » (règlement UE 2018/848: the operator holds a valid certificate) and « local » (the claim
// must be justified: DGCCRF). Pure rules, shared by the forms and the API.

/** The 14 allergens that must be declared (INCO, annexe II). */
export const ALLERGENS = [
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOYBEANS',
  'MILK',
  'NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  GLUTEN: 'Céréales contenant du gluten',
  CRUSTACEANS: 'Crustacés',
  EGGS: 'Œufs',
  FISH: 'Poissons',
  PEANUTS: 'Arachides',
  SOYBEANS: 'Soja',
  MILK: 'Lait',
  NUTS: 'Fruits à coque',
  CELERY: 'Céleri',
  MUSTARD: 'Moutarde',
  SESAME: 'Graines de sésame',
  SULPHITES: 'Anhydride sulfureux et sulfites',
  LUPIN: 'Lupin',
  MOLLUSCS: 'Mollusques',
};

export const ALLERGEN_DECISIONS = ['NONE', 'LISTED'] as const;
export type AllergenDecision = (typeof ALLERGEN_DECISIONS)[number];
export const ALLERGEN_DECISION_LABELS: Record<AllergenDecision, string> = {
  NONE: 'Aucun allergène déclaré',
  LISTED: 'Contient des allergènes (à cocher)',
};

/** Families for which the origin is compulsory (règlements UE 1337/2013, 1169/2011, directive « miel »…). */
export const ORIGIN_FAMILIES = [
  'FRUIT_VEG',
  'HONEY',
  'MEAT',
  'FISH',
  'EGGS',
  'OLIVE_OIL',
] as const;
export type OriginFamily = (typeof ORIGIN_FAMILIES)[number];
export const ORIGIN_FAMILY_LABELS: Record<OriginFamily, string> = {
  FRUIT_VEG: 'Fruits et légumes frais',
  HONEY: 'Miel',
  MEAT: 'Viande (bœuf, porc, volaille, ovin)',
  FISH: 'Poissons et produits de la mer',
  EGGS: 'Œufs',
  OLIVE_OIL: 'Huile d’olive vierge',
};

const allergenList = z
  .array(z.enum(ALLERGENS))
  .max(ALLERGENS.length)
  .refine((a) => new Set(a).size === a.length, 'Allergène en double.');

/** The fields of a product sheet that carry the food information. */
export const foodInfoFields = {
  isFood: z.boolean().default(false),
  ingredients: z
    .string()
    .trim()
    .max(2000)
    .transform((s) => (s === '' ? null : s.replace(/\s+/g, ' ')))
    .nullable()
    .default(null),
  allergensDecision: z.enum(ALLERGEN_DECISIONS).nullable().default(null),
  allergens: allergenList.default([]),
  allergenTraces: allergenList.default([]),
  origin: z
    .string()
    .trim()
    .max(200)
    .transform((s) => (s === '' ? null : s.replace(/\s+/g, ' ')))
    .nullable()
    .default(null),
  originFamily: z.enum(ORIGIN_FAMILIES).nullable().default(null),
  localJustification: z
    .string()
    .trim()
    .max(300)
    .transform((s) => (s === '' ? null : s.replace(/\s+/g, ' ')))
    .nullable()
    .default(null),
};

export interface FoodInfo {
  kind?: string;
  isFood?: boolean;
  saleMode?: string;
  unitQty?: string | null;
  unit?: string | null;
  ingredients?: string | null;
  allergensDecision?: string | null;
  allergens?: readonly string[];
  allergenTraces?: readonly string[];
  origin?: string | null;
  originFamily?: string | null;
  qualities?: readonly string[];
  localJustification?: string | null;
}

export interface FoodProblem {
  path: string;
  message: string;
}

/**
 * What is missing or contradictory on a product sheet. A food product (not a service) has its
 * allergen decision explicit (« aucun allergène déclaré » is a choice, never an empty default),
 * its ingredients, its net quantity when it is sold by the piece, and its origin when the family
 * requires one. A product called « local » carries the reason why.
 */
export function foodInfoProblems(p: FoodInfo): FoodProblem[] {
  const out: FoodProblem[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (p.kind === 'SERVICE' && p.isFood)
    add('isFood', 'Un service n’est pas un produit alimentaire.');
  const food = !!p.isFood && p.kind !== 'SERVICE';
  if (food) {
    const allergens = p.allergens ?? [];
    if (!p.allergensDecision)
      add(
        'allergensDecision',
        'Allergènes : choisissez « Aucun allergène déclaré » ou « Contient des allergènes » (le choix est obligatoire pour un produit alimentaire).',
      );
    else if (p.allergensDecision === 'LISTED' && allergens.length === 0)
      add('allergens', 'Cochez au moins un allergène, ou choisissez « Aucun allergène déclaré ».');
    else if (p.allergensDecision === 'NONE' && allergens.length > 0)
      add(
        'allergens',
        'Des allergènes sont cochés : choisissez « Contient des allergènes », ou décochez-les.',
      );
    if (!p.ingredients || p.ingredients.trim().length < 2)
      add(
        'ingredients',
        'Liste des ingrédients obligatoire pour un produit alimentaire (un seul ingrédient : son nom).',
      );
    if (p.saleMode === 'UNIT' && (!p.unitQty || !p.unit))
      add(
        'unitQty',
        'Quantité nette obligatoire pour un produit alimentaire vendu à la pièce (par exemple 500 g).',
      );
    if (p.originFamily && !p.origin?.trim())
      add(
        'origin',
        `Origine obligatoire pour cette famille de produits (${ORIGIN_FAMILY_LABELS[p.originFamily as OriginFamily] ?? p.originFamily}) : indiquez le pays ou la région.`,
      );
  } else if (p.kind !== 'SERVICE') {
    if (p.originFamily)
      add('originFamily', 'Une famille d’origine obligatoire ne concerne que l’alimentaire.');
  }
  if ((p.qualities ?? []).includes('LOCAL') && (p.localJustification?.trim().length ?? 0) < 8)
    add(
      'localJustification',
      'Un produit « local » doit être justifié : indiquez le producteur et la distance ou le lieu (par exemple « Ferme Durand, Montjavoult, 5 km »).',
    );
  return out;
}

/** The first problem as a sentence, or null. */
export const foodInfoProblem = (p: FoodInfo): string | null =>
  foodInfoProblems(p)[0]?.message ?? null;

/** The fields of a product sheet whose change makes the food information worth checking again. */
export const FOOD_INFO_TRIGGERS = [
  'kind',
  'isFood',
  'saleMode',
  'unitQty',
  'unit',
  'ingredients',
  'allergensDecision',
  'allergens',
  'allergenTraces',
  'origin',
  'originFamily',
  'qualities',
  'localJustification',
  'supplierId',
  'status',
  'shopVisible',
] as const;

// --- Organic claim ---------------------------------------------------------------------------

export interface OrganicCert {
  number: string | null;
  body: string | null;
  /** ISO date of the end of validity. */
  expiry: string | null;
}

export type OrganicState = 'NO_SUPPLIER' | 'MISSING' | 'EXPIRED' | 'VALID';

export function organicState(
  supplier: OrganicCert | null | undefined,
  today: string,
): OrganicState {
  if (!supplier) return 'NO_SUPPLIER';
  if (!supplier.number || !supplier.body || !supplier.expiry) return 'MISSING';
  return supplier.expiry < today ? 'EXPIRED' : 'VALID';
}

/**
 * The « bio » claim is allowed only when the supplier holds a certificate (number, certifying body)
 * that has not expired. Null when the claim is allowed, else the sentence that refuses it.
 */
export function organicClaimProblem(
  supplier: (OrganicCert & { name: string }) | null | undefined,
  today: string,
): string | null {
  switch (organicState(supplier, today)) {
    case 'VALID':
      return null;
    case 'NO_SUPPLIER':
      return 'Un produit « bio » doit avoir un fournisseur dont le certificat bio est enregistré : choisissez d’abord son fournisseur.';
    case 'MISSING':
      return `Qualité « bio » refusée : le fournisseur ${supplier!.name} n’a pas de certificat bio complet (numéro, organisme certificateur, date de fin de validité). Complétez sa fiche.`;
    case 'EXPIRED':
      return `Qualité « bio » refusée : le certificat bio du fournisseur ${supplier!.name} a expiré le ${frDate(supplier!.expiry!)}. Enregistrez le nouveau certificat sur sa fiche.`;
  }
}

/** Day / month / year of an ISO date. */
export const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');
const certText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s.replace(/\s+/g, ' ')))
    .nullable()
    .default(null);

export const organicCertFields = {
  organicCertNumber: certText(60),
  organicCertBody: certText(100),
  organicCertExpiry: isoDay.nullable().default(null),
};

/** The three parts of the certificate go together: all of them or none. */
export function organicCertProblem(c: {
  organicCertNumber?: string | null;
  organicCertBody?: string | null;
  organicCertExpiry?: string | null;
}): string | null {
  const filled = [c.organicCertNumber, c.organicCertBody, c.organicCertExpiry].filter(Boolean);
  if (filled.length === 0 || filled.length === 3) return null;
  return 'Certificat bio incomplet : le numéro, l’organisme certificateur et la date de fin de validité vont ensemble.';
}

// --- Display ---------------------------------------------------------------------------------

/** « Contient : lait, œufs. Peut contenir des traces de : fruits à coque. », or null (not decided). */
export function allergenSentence(p: {
  allergensDecision?: string | null;
  allergens?: readonly string[];
  allergenTraces?: readonly string[];
}): string | null {
  if (!p.allergensDecision) return null;
  const names = (a: readonly string[]) =>
    a.map((x) => (ALLERGEN_LABELS[x as Allergen] ?? x).toLowerCase()).join(', ');
  const parts: string[] = [];
  if (p.allergensDecision === 'NONE') parts.push('Aucun allergène déclaré.');
  else if (p.allergens?.length) parts.push(`Contient : ${names(p.allergens)}.`);
  if (p.allergenTraces?.length) parts.push(`Peut contenir des traces de : ${names(p.allergenTraces)}.`);
  return parts.join(' ');
}

/** Parses a typed list (« lait, œufs », « aucun ») into allergen codes; unknown names are returned apart. */
export function parseAllergenList(raw: string): {
  decision: AllergenDecision | null;
  allergens: Allergen[];
  unknown: string[];
} {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/œ/gi, 'oe')
      .toLowerCase()
      .trim();
  const text = fold(raw);
  if (text === '') return { decision: null, allergens: [], unknown: [] };
  if (['aucun', 'aucun allergene', 'non', 'neant', '0'].includes(text))
    return { decision: 'NONE', allergens: [], unknown: [] };
  const byName = new Map<string, Allergen>();
  for (const a of ALLERGENS) {
    byName.set(fold(ALLERGEN_LABELS[a]), a);
    byName.set(a.toLowerCase(), a);
  }
  const extra: Record<string, Allergen> = {
    gluten: 'GLUTEN',
    ble: 'GLUTEN',
    arachide: 'PEANUTS',
    cacahuete: 'PEANUTS',
    cacahuetes: 'PEANUTS',
    oeuf: 'EGGS',
    oeufs: 'EGGS',
    poisson: 'FISH',
    crustace: 'CRUSTACEANS',
    mollusque: 'MOLLUSCS',
    'fruit a coque': 'NUTS',
    'fruits a coque': 'NUTS',
    noix: 'NUTS',
    sulfites: 'SULPHITES',
    sesame: 'SESAME',
  };
  const found = new Set<Allergen>();
  const unknown: string[] = [];
  for (const part of text.split(/[,;/]+/).map((s) => s.trim()).filter(Boolean)) {
    const hit = byName.get(part) ?? extra[part];
    if (hit) found.add(hit);
    else unknown.push(part);
  }
  return {
    decision: found.size ? 'LISTED' : null,
    allergens: ALLERGENS.filter((a) => found.has(a)),
    unknown,
  };
}

/** How the claims of a product are shown to the public (the organic one only while it is valid). */
export function publicClaims(p: {
  qualities: readonly string[];
  organic: OrganicState;
}): { organic: boolean; local: boolean } {
  return {
    organic: p.qualities.includes('ORGANIC') && p.organic === 'VALID',
    local: p.qualities.includes('LOCAL'),
  };
}
