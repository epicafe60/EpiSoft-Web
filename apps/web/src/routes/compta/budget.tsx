import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { euro } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, Table } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';
import { useAccounts, useFiscalYears } from './queries';

interface Row {
  number: string;
  label: string;
  budget: string;
  actual: string;
  variance: string;
  percent: number | null;
}
interface BudgetData {
  expenses: Row[];
  income: Row[];
  budgetResult: string;
  actualResult: string;
}

/** R-CPT-20: yearly budget per expense/income account, shown against the books. */
export function BudgetPage() {
  const queryClient = useQueryClient();
  const years = useFiscalYears();
  const accounts = useAccounts();
  const [selected, setSelected] = useState('');
  const year = years.data?.find((y) => y.id === selected) ?? years.data?.[0];
  const budget = useQuery({
    queryKey: ['budget', year?.id],
    queryFn: () => api.get<BudgetData>(`/fiscal-years/${year!.id}/budget`),
    enabled: !!year,
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<{ number: string; label: string }[]>([]);
  useEffect(() => {
    if (!budget.data) return;
    setAmounts(
      Object.fromEntries(
        [...budget.data.expenses, ...budget.data.income].map((r) => [
          r.number,
          Number(r.budget) === 0 ? '' : r.budget,
        ]),
      ),
    );
    setAdded([]);
  }, [budget.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/fiscal-years/${year!.id}/budget`, {
        lines: Object.entries(amounts).map(([number, amount]) => ({
          number,
          amount: amount.trim() === '' ? '0' : amount,
        })),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budget'] }),
  });

  const known = new Set(
    [...(budget.data?.expenses ?? []), ...(budget.data?.income ?? [])].map((r) => r.number),
  );
  const addable = (accounts.data ?? []).filter(
    (a) =>
      /^[67]/.test(a.number) && !known.has(a.number) && !added.some((x) => x.number === a.number),
  );
  const extra = (side: '6' | '7'): Row[] =>
    added
      .filter((a) => a.number.startsWith(side))
      .map((a) => ({ ...a, budget: '0.00', actual: '0.00', variance: '0.00', percent: null }));

  const section = (title: string, rows: Row[]) => (
    <>
      <tr className="bg-muted/50">
        <td colSpan={5} className="font-medium">
          {title}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.number} data-testid="budget-row">
          <td>
            {r.number} {r.label}
          </td>
          <td className="w-36 text-right">
            <Input
              aria-label={`Budget ${r.number}`}
              inputMode="decimal"
              className="text-right"
              value={amounts[r.number] ?? ''}
              onChange={(e) => setAmounts({ ...amounts, [r.number]: e.target.value })}
            />
          </td>
          <td className="text-right tabular-nums">{euro(r.actual)}</td>
          <td className="text-right tabular-nums">{euro(r.variance)}</td>
          <td className="text-right tabular-nums text-muted-foreground">
            {r.percent === null ? '' : `${r.percent} %`}
          </td>
        </tr>
      ))}
    </>
  );

  return (
    <div className="grid gap-4">
      <Field label="Exercice">
        {(p) => (
          <Select
            {...p}
            className="w-72"
            value={year?.id ?? ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            {years.data?.map((y) => (
              <option key={y.id} value={y.id}>
                {y.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {budget.error ? <QueryError error={budget.error} /> : null}
      {budget.data ? (
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <Table>
              <thead>
                <tr>
                  <th>Compte</th>
                  <th className="text-right">Budget</th>
                  <th className="text-right">Réalisé</th>
                  <th className="text-right">Écart</th>
                  <th className="text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {section('Charges', [...budget.data.expenses, ...extra('6')])}
                {section('Produits', [...budget.data.income, ...extra('7')])}
                <tr className="font-medium">
                  <td colSpan={2}>Résultat</td>
                  <td className="text-right tabular-nums">{euro(budget.data.actualResult)}</td>
                  <td colSpan={2} className="text-right text-muted-foreground">
                    prévu {euro(budget.data.budgetResult)}
                  </td>
                </tr>
              </tbody>
            </Table>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Ajouter un compte">
                {(p) => (
                  <Select
                    {...p}
                    className="w-72"
                    value=""
                    onChange={(e) => {
                      const a = addable.find((x) => x.number === e.target.value);
                      if (a) setAdded([...added, { number: a.number, label: a.label }]);
                    }}
                  >
                    <option value="">Choisir…</option>
                    {addable.map((a) => (
                      <option key={a.number} value={a.number}>
                        {a.number} {a.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                Enregistrer le budget
              </Button>
              <a
                className="text-sm text-primary hover:underline"
                href={`/api/v1/reports/budget?fiscalYearId=${year?.id}&format=xlsx`}
              >
                Excel
              </a>
            </div>
            {save.error ? <Alert>{save.error.message}</Alert> : null}
            {save.isSuccess ? <Alert variant="success">Budget enregistré.</Alert> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
