# ADR 0009 — Une caisse par jour, partagée

Date: 2026-10-25. Status: implemented.

Request: several people use the till, from any browser; the first one of the day opens it, the others
join it, anyone can close it (in practice the last one to leave). The notion of « poste » must not be
the cashier's concern. Before: one open session per device, a « Rejoindre cette session » button the
cashier could ignore, a device named by hand, and a ticket list that read only the browser's own queue:
tickets made on another till did not appear.

## Decisions

- **One open session for the whole shop** (R-SES-05): partial unique index
  `cash_session_one_open`. The merge of sessions already open is done by migration 0025 (the oldest is
  kept; sales and payments of the others are moved to it, the id of each is kept in
  `cash_session_alias`).
- **Joining, also offline.** `SESSION_OPEN` of a till while a session is open does not create one: the id
  the till generated becomes an alias, the answer carries `sessionId` (the real one) and the till
  adopts it. Sales already made under the alias are found through it (`sessionOf`, and every
  `/pos/sessions/:id/*` route and the sales list resolve aliases). Nothing is refused.
- **The device is invisible.** The browser declares itself with a generated name (`POSTE-XXXX`); a
  device the server forgot (`DEVICE_UNKNOWN`) is declared again on its own, under its old name when
  free. Tests choose a name with `window.__EPISOFT_DEVICE_NAME`.
- **The session is the day's.** A session opened on a previous Paris day is closed before selling
  (online); the server never refuses a ticket for that, it flags it (`SESSION_PREVIOUS_DAY`). Offline,
  the till keeps selling.
- **Anyone closes** (R-SES-06): the closing screen lists the other cashiers who sold within
  `closingOthersActiveMin` minutes and the silent tills, and asks for a confirmation. No block: the
  last person to leave may have forgotten, and the alert « session open for more than a day » exists.
- **Cashier**: the signed-in user, nothing else (no badge switch, no selector): everyone signs in with
  their own account, also on a shared till.

## Consequences

- A till that never reaches the server for a whole day sells in a session the server may have
  closed (forced closing): the ticket is kept with the warning `SESSION_CLOSED`, as before.
- Before deploying to production: read-only count of open sessions; the migration merges them if
  there are several, but closing them properly first is preferable.
