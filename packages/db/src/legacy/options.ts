import type { VatRegime } from '@episoft/shared';

/**
 * Options of the import that the lots read. The VAT regime of what is taken over: the history of
 * the old software carries no VAT of its own (three totals per invoice, no VAT on the tickets), so it
 * is taken over under one regime, chosen with `--vat-regime`. Default: EXEMPT (exonéré, art. 261
 * du CGI); to be confirmed with the accountant.
 */
export const importOptions: { vatRegime: VatRegime } = { vatRegime: 'EXEMPT' };
