import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// Audit KV2, C07: deploy/db/backup.sh run for real, with stand-ins for what the machine provides
// (docker/pg_dump, age, rsync, mountpoint). What is proved here is the behaviour of the script:
// what leaves the server is encrypted, never in clear; a dump that is empty, a missing `age` or an
// unmounted disk stop the script with exit 1 and send nothing out.

const SCRIPT = join(process.cwd(), '../../deploy/db/backup.sh').replace(/\\/g, '/');
const posix = (p: string) => p.replace(/\\/g, '/');

let work: string;
let bin: string;
let serverDir: string; // the backup folder of the server
let offsite: string; // what the « other machine » receives

const script = (name: string, body: string) => {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'episoft-drill-'));
  bin = join(work, 'bin');
  serverDir = join(work, 'server');
  offsite = join(work, 'offsite');
  for (const d of [bin, serverDir, offsite]) mkdirSync(d);
  // « docker exec <container> <program> … »: the programs of the PostgreSQL container.
  script(
    'docker',
    `shift 2 # exec <container>
prog="$1"; shift
case "$prog" in
  pg_dump) while [ $# -gt 0 ]; do [ "$1" = -f ] && out="$2"; shift; done
           file="\${BACKUP_DIR}/$(basename "$out")"
           if [ "\${FAKE_DUMP:-}" = empty ]; then : >"$file"; else echo "PGDMP fake dump of the database" >"$file"; fi ;;
  pg_restore) for i in $(seq 1 40); do echo "$i; 1259 table app t$i"; done ;;
esac`,
  );
  script(
    'age',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2";; esac; in="$1"; shift; done\n{ echo AGE-ENCRYPTED; cat "$in"; } >"$out"',
  );
  script(
    'rsync',
    'args=("$@"); dest="${args[-1]}"; unset "args[-1]"; args=("${args[@]:1}"); cp "${args[@]}" "$dest"',
  );
  script('mountpoint', '[ "${FAKE_MOUNTED:-0}" = 1 ]');
});

function backup(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: `${posix(bin)}:${process.env.PATH}`,
      HOME: process.env.HOME ?? work,
      BACKUP_ENV_FILE: '/dev/null',
      PG_MODE: 'docker',
      BACKUP_DIR: posix(serverDir),
      BACKUP_RSYNC_DEST: `${posix(offsite)}/`,
      MSYS_NO_PATHCONV: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const names = (d: string) => readdirSync(d).sort();

describe('backup.sh (audit KV2, C07)', () => {
  it('sends out only the encrypted copy, with the checksums, and keeps its clear dump at home', () => {
    const r = backup({ BACKUP_AGE_RECIPIENT: 'age1testrecipient' });
    expect(r.code, r.out).toBe(0);
    const sent = names(offsite);
    expect(sent.some((n) => n.endsWith('.dump.age'))).toBe(true);
    expect(sent.some((n) => n.endsWith('.dump.age.sha256'))).toBe(true);
    // Never the dump in clear: no « .dump » file, and nothing of its text, leaves.
    expect(sent.filter((n) => /\.dump$/.test(n))).toEqual([]);
    expect(r.out).toMatch(/copies encrypted: yes/);
    // At home: the clear dump stays (the monthly restore test reads it), the travelling copy goes.
    expect(names(serverDir).some((n) => /\.dump$/.test(n))).toBe(true);
    expect(names(serverDir).some((n) => n.endsWith('.age'))).toBe(false);
  });

  it('refuses to send anything when encryption is asked for and fails', () => {
    // `age` that fails (a bad key, a missing program: the same for the script).
    script('age', 'exit 1');
    const r = backup({ BACKUP_AGE_RECIPIENT: 'age1testrecipient' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/chiffrement|age/i);
    expect(names(offsite)).toEqual([]);
  });

  it('stops on a dump that is empty, and sends nothing', () => {
    const r = backup({ FAKE_DUMP: 'empty', BACKUP_AGE_RECIPIENT: 'age1testrecipient' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vide|absent/);
    expect(names(offsite)).toEqual([]);
  });

  it('says so, and fails, when the external disk is not mounted', () => {
    const disk = join(work, 'disk');
    mkdirSync(disk);
    const r = backup({ BACKUP_DISK_MOUNT: posix(disk), FAKE_MOUNTED: '0', BACKUP_RSYNC_DEST: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not mounted/);
    expect(existsSync(join(disk, 'EpiSoft-Backups'))).toBe(false);
  });

  it('copies to the external disk, encrypted, when it is mounted', () => {
    const disk = join(work, 'disk');
    mkdirSync(disk);
    const r = backup({
      BACKUP_DISK_MOUNT: posix(disk),
      FAKE_MOUNTED: '1',
      BACKUP_RSYNC_DEST: '',
      BACKUP_AGE_RECIPIENT: 'age1testrecipient',
    });
    expect(r.code, r.out).toBe(0);
    const copied = names(join(disk, 'EpiSoft-Backups'));
    expect(copied.some((n) => n.endsWith('.dump.age'))).toBe(true);
    expect(copied.filter((n) => /\.dump$/.test(n))).toEqual([]);
  });

  it('without a key, the copies are not encrypted, and the report says so', () => {
    const r = backup();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/copies encrypted: no/);
  });
});
