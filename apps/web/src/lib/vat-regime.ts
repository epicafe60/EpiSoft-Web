import { useQuery } from '@tanstack/react-query';
import { regimeAt, type VatRegime, type VatRegimeChange } from '@episoft/shared';
import { api } from './api';

export interface VatRegimeInfo {
  current: VatRegime;
  changes: VatRegimeChange[];
}

/** R-TVA-07: the VAT regime of the association and its history (effective dates). */
export function useVatRegime() {
  return useQuery({
    queryKey: ['vat-regime'],
    queryFn: () => api.get<VatRegimeInfo>('/vat-regime'),
  });
}

/** The regime in force on a date; LIABLE while the history is loading (the default). */
export function regimeOnDate(info: VatRegimeInfo | undefined, date: string): VatRegime {
  return info ? regimeAt(info.changes, date) : 'LIABLE';
}
