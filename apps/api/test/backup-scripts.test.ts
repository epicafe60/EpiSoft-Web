import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupRun } from '@episoft/db';
import { setupTestApp } from './helpers';

// The backup scripts and the API must agree: what deploy/db/lib.sh sends is accepted as is,
// whatever the message holds (a pg_restore error is full of quotes and new lines).

const LIB = join(process.cwd(), '../../deploy/db/lib.sh').replace(/\\/g, '/');

function payload(...args: string[]): string {
  return execFileSync('bash', ['-c', `. "${LIB}"; backup_payload "$@"`, 'payload', ...args], {
    env: { ...process.env, BACKUP_ENV_FILE: '/dev/null', MSYS_NO_PATHCONV: '1' },
    encoding: 'utf8',
  });
}

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
  await t.reset();
});
afterAll(() => t.close());

describe('the report of the backup scripts', () => {
  const nasty =
    'pg_restore: error: ERROR:  insert or update on table "cash_session"\nDETAIL:  Key (device_id)=(x) \\ end\ttab';

  it('is valid JSON whatever the message', () => {
    const body = JSON.parse(payload('RESTORE_TEST', 'false', 'null', '', 'false', 'false', nasty));
    expect(body).toEqual({
      kind: 'RESTORE_TEST',
      ok: false,
      sizeBytes: null,
      checksum: '',
      verified: false,
      offsite: false,
      detail: nasty,
    });
  });

  it('is accepted by the application, and recorded as sent', async () => {
    for (const body of [
      payload('BACKUP', 'true', '1446828', 'abc123', 'true', 'true', '587 éléments'),
      payload('RESTORE_TEST', 'false', 'null', '', 'false', 'false', nasty),
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/internal/backup-report',
        headers: {
          'content-type': 'application/json',
          'x-episoft-csrf': '1',
          authorization: 'Bearer test-backup-token-0123456789',
        },
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(204);
    }
    const rows = await t.db.select().from(backupRun);
    expect(rows.map((r) => [r.kind, r.ok, r.detail])).toEqual(
      expect.arrayContaining([
        ['BACKUP', true, '587 éléments'],
        ['RESTORE_TEST', false, nasty],
      ]),
    );
  });
});

describe('the report without curl (the server has none)', () => {
  const run = promisify(execFile);

  async function reportFrom(client: string, port: number, token: string, detail: string) {
    // execFile, not execFileSync: the application listens in this very process.
    return run(
      'bash',
      ['-c', `. "${LIB}"; report BACKUP true 1234 abc true false "$1"`, 'report', detail],
      {
        env: {
          ...process.env,
          BACKUP_ENV_FILE: '/dev/null',
          MSYS_NO_PATHCONV: '1',
          BACKUP_API_URL: `http://127.0.0.1:${port}`,
          BACKUP_REPORT_TOKEN: token,
          BACKUP_REPORT_CLIENT: client,
        },
      },
    );
  }

  it('reaches the application through Node, and is recorded', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const detail = 'envoi par node : « 587 éléments » avec "guillemets"\net une ligne';
    const { stderr } = await reportFrom('node', port, 'test-backup-token-0123456789', detail);
    expect(stderr).toBe('');
    const rows = await t.db.select().from(backupRun).where(eq(backupRun.detail, detail));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'BACKUP', ok: true, sizeBytes: 1234, offsite: false });
  });

  it('says so, without failing the backup, when the application refuses', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    const { stderr } = await reportFrom('node', port, 'un-mauvais-jeton-0123456789', 'refus');
    expect(stderr).toContain('could not report to the application');
    expect(await t.db.select().from(backupRun).where(eq(backupRun.detail, 'refus'))).toEqual([]);
  });
});
