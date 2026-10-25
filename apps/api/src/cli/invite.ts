/**
 * Bootstrap and support tool: prints a one-hour link for a member to set their password
 * (also e-mailed when the member has an address), and optionally grants the ADMIN role,
 * which is needed once, for the very first administrator.
 * No password is ever typed or passed on the command line.
 *
 * Usage: pnpm --filter @episoft/api user:invite <username> [--grant-admin]
 */
import { sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { auditLog, createDb, createPool, loadEnv, member, userRole } from '@episoft/db';
import { loadConfig } from '../config';
import { sendPasswordLink } from '../modules/auth/routes';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: { 'grant-admin': { type: 'boolean', default: false } },
});
const username = positionals[0];
if (!username) {
  console.error('Usage : user:invite <identifiant> [--grant-admin]');
  process.exit(2);
}

loadEnv();
const config = loadConfig();
const pool = createPool(config.DATABASE_URL, 1, 'cli:invite');
const db = createDb(pool);
try {
  const link = await db.transaction(async (tx) => {
    const user = await tx.query.member.findFirst({
      where: sql`lower(${member.username}) = lower(${username})`,
      columns: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!user) throw new Error(`Aucun membre avec l’identifiant ${username}.`);
    if (values['grant-admin']) {
      await tx
        .insert(userRole)
        .values({ memberId: user.id, roleCode: 'ADMIN' })
        .onConflictDoNothing();
      await tx.insert(auditLog).values({
        action: 'member.roles',
        entity: 'member',
        entityId: user.id,
        after: { granted: 'ADMIN', by: 'cli user:invite' },
      });
      console.log(`Rôle ADMIN accordé à ${user.firstName} ${user.lastName}.`);
    }
    return sendPasswordLink(tx, config, user);
  });
  console.log(`Lien de définition du mot de passe (valable 1 heure) :\n${link}`);
} finally {
  await pool.end();
}
