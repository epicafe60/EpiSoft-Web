# EpiSoft-Web

Web rewrite of EpiSoft, the management suite of the Épicafé de Montjavoult.
The functional reference is [docs/specifications.md](docs/specifications.md) (in French).
Decisions taken while building are recorded in [docs/adr/](docs/adr/).

## Layout

| Folder | Content |
|---|---|
| `apps/web` | React 19 + Vite single-page app (TanStack Router/Query, Tailwind, shadcn-style components) |
| `apps/api` | Node + Fastify API; also serves the built web app in production |
| `packages/shared` | Zod schemas and pure business rules, used by both sides |
| `packages/db` | Drizzle schema, SQL migrations (`drizzle/`), legacy migration script |
| `deploy/db` | PostgreSQL 17 container (local and server) |
| `docker` | Application image, full-stack compose file, Caddy |

## Getting started (local)

Requirements: Node 22+, pnpm 10 (`npm i -g pnpm@10`), Docker Desktop.

```sh
cd deploy/db && docker compose up -d && cd ../..   # PostgreSQL, see deploy/db/README.md
cp .env.example .env                                # then put EPISOFT_APP_PASSWORD in DATABASE_URL
pnpm install
pnpm db:migrate                                     # create or upgrade the schema
pnpm legacy:migrate --dry-run                       # optional: preview the legacy import
pnpm legacy:migrate                                 # import members from EpiSoft (read-only on MariaDB)
pnpm --filter @episoft/api user:invite <Identifiant> --grant-admin   # first administrator
pnpm dev                                            # API on :3000, web app on http://localhost:5173
```

`user:invite` prints a link, valid for one hour, to set the password. No password is ever
migrated from EpiSoft (spec §6.3). Without SMTP settings, e-mails are written to the API log.

## Everyday commands

| Command | Does |
|---|---|
| `pnpm dev` | API (watch mode) and web app with hot reload |
| `pnpm test` | Unit tests, and API integration tests on a throwaway PostgreSQL (Docker needed) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code quality |
| `pnpm db:generate` | Generate a migration after editing `packages/db/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm legacy:migrate [--dry-run] [--local\|--remote]` | Re-run the legacy import (idempotent); report in `exports/` |

## Legacy migration (Lot 0 scope)

Regions, communes, households, members, roles, login history and the cash float.
The script only sends `SELECT` statements to MariaDB (the session is also set read-only),
runs in one PostgreSQL transaction and can be replayed: rows are matched on their legacy id.
On a re-run, roles that exist in EpiSoft follow EpiSoft; `STATS` and `ADMIN`, which only
exist in v2, are kept. The Excel report lists counts and anomalies (shared QR codes,
postcode mismatches, unknown permissions…).

## Deployment

`docker/compose.yml` brings up PostgreSQL (from `deploy/db`), the application and Caddy
(HTTPS) with one command; migrations run when the application starts:

```sh
cd docker && cp .env.example .env   # fill it in
docker compose up -d --build
```

Deployment to the MinisForum is not done yet (see CLAUDE.md): it also hosts the production
MariaDB, and the HTTP/HTTPS ports and the address must be chosen first (open question Q9).
