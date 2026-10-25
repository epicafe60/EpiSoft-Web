# EpiSoft-Web

Rewrite of **EpiSoft**, the management suite of the Epicafé de Montjavoult associative grocery (till, members/households and their prepaid "cagnotte", catalogue, suppliers, orders, stock, inventory, accounting, statistics), as a single responsive web application.

## Golden rules

- **Never modify `C:\Datas\Dev\Episoft`.** It is the production Free Pascal/Lazarus app and it is in daily use. Reading its source and querying its MariaDB database **read-only** (SELECT only) are allowed, for analysis and migration. Never write to it, restart it or change its configuration.
- Everything for v2 lives in this folder.
- Develop and test **locally first**. Deploy to the server only once the app works locally.
- Never commit secrets. `.env` files are git-ignored.

## Key documents

- `docs/specifications.md`: the full functional and technical specification, in French. It is the reference for every feature. It covers:
  - analysis of the existing app, business rules and ~80 anomalies (§2);
  - requirements by domain, with rule IDs `R-XXX-nn` and acceptance criteria (§4);
  - non-functional requirements, including the offline till (§5);
  - the target data model and the mapping from old columns to new ones (§6);
  - the stack (§7), the API and sync protocol (§8), migration (§9), the roadmap (§10) and open questions (§11).
- `README.md`: setup and everyday commands. `docs/adr/`: decisions taken while building (read ADR 0001 for the Lot 0 choices).
- Domain vocabulary is French (adhérent, foyer, cagnotte, clôture, écriture…). Code identifiers are in English and the UI is in French.

## Stack (decided, see spec §7)

- TypeScript strict, in a pnpm monorepo:
  - `apps/web`: React 19 + Vite PWA, TanStack Router/Query/Table, Tailwind + shadcn/ui, Dexie for the offline till;
  - `apps/api`: Node 22 + Fastify;
  - `packages/shared`: Zod schemas and pure business calculations, used by both client and server;
  - `packages/db`: Drizzle schema, migrations, and the legacy migration script.
- PostgreSQL 17. Money is `numeric(12,2)`, quantities `numeric(12,3)`. Primary keys are UUID v7. Every business write runs in one transaction.
- Tests: Vitest; Playwright for end-to-end tests, including offline till scenarios.

## Local database

- Docker Desktop container `episoft-web-postgres`, defined in `deploy/db/compose.yml`, listening on `127.0.0.1:5432`.
- Database `episoft`, schema `app`.
- Roles:
  - `episoft_app`: read/write, used by the application;
  - `episoft_ro`: read-only;
  - `postgres`: admin only.
- Passwords are in `deploy/db/.env`.
- Start with `docker compose up -d` from `deploy/db`. See `deploy/db/README.md`.

## Legacy data (read-only source for the migration)

- MariaDB 11.8, schemas `epicafe`, `epidatas`, `epicompta` and `prodimg`.
- Connection settings are in `C:\Datas\Dev\Episoft\EpiSoft.config`. Read that file, never write to it.
- `tools/export_excel.py` exports all legacy tables to Excel, read-only, into `exports/`.

## Production server (live since 2026-10-04)

- The MinisForum, Debian 13, at `192.168.1.10`, public name `epicafe.ddns.net` (https). **It also hosts the production MariaDB** (port 6382, FTP on 21). Anything installed there must stay isolated from it.
- EpiSoft-Web runs **natively, not in Docker**: systemd unit `episoft-web`, PostgreSQL 17 installed on the machine, code in `/opt/episoft-web/src`, settings in `/etc/episoft/`. The Docker files in `docker/` and `deploy/db/compose.yml` are for local development.
- Backups: `deploy/db/backup.sh` and `restore-test.sh` with `PG_MODE=native` on the server (see `docs/maintenance.md`).
- Every action on the server (deploy, restart, even a database read) needs the user's explicit go-ahead, each time. Database reads are done in a read-only transaction.

## Roadmap (spec §10)

| Lot | Scope |
|---|---|
| 0 | Foundations: monorepo, CI, Docker, auth and roles, settings, audit log, UI shell, migration of reference data and members |
| 1 | Members, households, memberships, cagnotte, offline PWA till, cash sessions and closing |
| 2 | Catalogue, suppliers, purchase orders and receipts, supplier invoices, stock ledger, inventory |
| 3 | Accounting |
| 4 | Dashboards, statistics, exports, imports, pre-orders |

## Working conventions

- Write business rules as pure functions in `packages/shared`, with unit tests, before using them in the UI or API.
- Reference spec rule IDs (e.g. `R-VTE-10`) in tests and commit messages.
- Use parameterized queries only, through Drizzle. Never build SQL by concatenating strings.
- Everything is audited (ADR 0008): every write calls `audit()` in the same transaction as the change; a new action gets a sentence in `audit-sentences.ts` and an undo decision in `admin/revert/policies.ts`; a migration that adds a table ends with `select app.attach_change_capture();`.
- Open questions Q1–Q10 (spec §11) are still undecided. Use the documented default and flag it.
