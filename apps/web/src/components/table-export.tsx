import { useEffect, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { canExport, exportScopeOfPath, typeColumns } from '@episoft/shared';
import { api } from '@/lib/api';
import { meQuery } from '@/lib/auth';
import { readTable } from '@/lib/table-dom';
import { Button } from '@/components/ui/button';

/** The name of a list: the one given, else the title of the page, else the tab's. */
function titleOf(given: string | undefined): string {
  if (given) return given;
  const h1 = document.querySelector('h1')?.textContent?.trim();
  return h1 || document.title || 'Export';
}

/**
 * « Exporter en Excel »: the list as displayed (filters and sort applied) becomes a spreadsheet.
 * Shown only to those whose role opens the screen (the server checks it again), and only when the
 * list has rows. Amounts, numbers and dates are real values in the file, codes stay text.
 */
export function ExportTableButton({
  tableRef,
  name,
}: {
  tableRef: RefObject<HTMLTableElement | null>;
  name?: string | undefined;
}) {
  const { data: me } = useQuery(meQuery);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const scope = exportScopeOfPath(pathname);
  const [hasRows, setHasRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After every render of the list: its rows come and go with the data and the filters. Setting the
  // same value again renders nothing, so this does not loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const rows = tableRef.current ? readTable(tableRef.current).rows.length : 0;
    setHasRows(rows > 0);
  });

  if (!me || !hasRows || !canExport(me.roles, scope)) return null;

  const run = async () => {
    const table = tableRef.current;
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      const { headers, rows } = readTable(table);
      const typed = typeColumns(headers, rows);
      const { blob, filename } = await api.postForFile('/exports/table', {
        scope,
        title: titleOf(name).slice(0, 100),
        ...typed,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-3 px-3 pt-2 print:hidden" data-no-export>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void run()}
        title="Télécharger ce tableau tel qu’il est affiché (filtres et tri compris)"
      >
        <Download /> {busy ? 'Export…' : 'Exporter en Excel'}
      </Button>
    </div>
  );
}
