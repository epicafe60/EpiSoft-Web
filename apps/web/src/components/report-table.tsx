import { euro } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, Table } from '@/components/ui/card';

export interface ReportTableData {
  title: string;
  subtitle?: string;
  columns: { key: string; label: string; type: 'text' | 'money'; width?: number }[];
  rows: { cells: Record<string, string | null>; bold?: boolean }[];
}

/** A generic report table (same structure as the Excel export). */
export function ReportTableView({ data, busy }: { data: ReportTableData; busy?: boolean }) {
  return (
    <Card className={cn('overflow-x-auto', busy && 'opacity-60')} aria-busy={busy}>
      <Table>
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c.key} className={c.type === 'money' ? 'text-right' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className={r.bold ? 'font-semibold' : ''}>
              {data.columns.map((c) => (
                <td key={c.key} className={cn(c.type === 'money' && 'text-right tabular-nums')}>
                  {c.type === 'money' ? euro(r.cells[c.key]) : (r.cells[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {data.rows.length === 0 ? (
            <tr>
              <td colSpan={data.columns.length} className="text-muted-foreground">
                Aucune donnée sur cette période.
              </td>
            </tr>
          ) : null}
        </tbody>
      </Table>
    </Card>
  );
}
