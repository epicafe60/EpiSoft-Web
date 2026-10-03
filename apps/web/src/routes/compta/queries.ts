import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AccountRow, FiscalYearRow, JournalRow } from './types';

export const useAccounts = () =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountRow[]>('/accounts?limit=1000'),
  });

export const useJournals = () =>
  useQuery({ queryKey: ['journals'], queryFn: () => api.get<JournalRow[]>('/journals') });

export const useFiscalYears = () =>
  useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => api.get<FiscalYearRow[]>('/fiscal-years'),
  });
