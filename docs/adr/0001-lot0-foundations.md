# ADR 0001 — Lot 0 foundations: choices that differ from or refine the specification

Date: 2026-10-03. Status: proposed, to be confirmed.

## 1. Session authentication written in the project instead of Better Auth

Spec §7.2 suggests Better Auth. Lot 0 uses a small session module instead
(`apps/api/src/plugins/auth.ts`, about 150 lines):

- the `member` table is the user table (spec §6.2); Better Auth expects its own `user`,
  `account` and `session` tables, which would duplicate members;
- the lockout rule (R-AUTH-03) and the QR badge cashier switch (R-AUTH-04, lot 1) are
  specific and would have to be built around the library anyway;
- the security properties are those of §5.5: Argon2id, sessions stored server-side
  (only the SHA-256 of the cookie token is in the database), `HttpOnly` +
  `SameSite=Lax` + `Secure` cookies, an 8-hour absolute expiry, a CSRF header on
  every state-changing call, rate limiting, and every session closed when the password
  changes.

## 2. Inactive and archived members cannot log in

R-MBR-03 refuses them at the till; Lot 0 applies the same rule to the back-office.
A member deactivated while connected loses access on the next request.

## 3. Legacy QR codes shared by several members are not migrated

In EpiSoft, 11 groups of members (up to 8 people) share the same QR code. A shared code
cannot identify a cashier (R-AUTH-04) or a buyer, so those members get no QR code in v2
and are listed in the migration report as "badge à régénérer" (R-MBR-05). Unique codes
shorter than 15 characters are kept and also listed.

## 4. Region of communes left empty

All EpiSoft communes have region `0`, which does not exist. `commune.region_id` stays
empty; it can be filled from the department number later if it turns out to be needed.

## 5. E-mail outbox sender

Spec §7.2 plans pg-boss for jobs. Lot 0 only needs to send password links, so a
15-second loop processes `email_outbox` with `FOR UPDATE SKIP LOCKED` and up to five
attempts. It can move to pg-boss when scheduled jobs arrive (lot 1 or later).

## 6. Accent-insensitive search without the `unaccent` extension

`unaccent` must be installed by a superuser. Search uses `translate()` on common
French accented letters for now. If needed, install `unaccent` in `deploy/db/init`.

## 7. Not done in Lot 0 yet

- PWA / service worker (`vite-plugin-pwa`): comes with the offline till, lot 1.
- OpenAPI documentation (`@fastify/swagger`).
- Playwright end-to-end tests.
- Publishing the image to a registry (GHCR) so the server can `docker compose pull`.
- Deployment to the recette server.
