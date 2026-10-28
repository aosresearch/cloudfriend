# Dashboard contract notes

Notes on `design/api-contract.md` from building the dashboard (`src/ui/static/`). The dev mock
(`src/ui/dev/mock-server.ts`) implements the contract plus the two additions below.

## Additions the UI uses

1. **`GET /api/w/:ws/test-event/:queue_id`** → `{ "queue_id", "status": "new" | "done" | "failed", "event": Event | null }`.
   `POST /test-event` returns only a `queue_id`, and nothing else in the contract maps a queue row to its event,
   so the setup page could not watch the test exception without it. `event` is null until the row is parsed.
   *Fallback:* if this returns 404, the UI polls `GET /events?since=<time of click>` and takes the oldest event
   received since then, and says on screen that it did so.

2. **Two fields on `Event`:**
   - `judgment`: `"relevant" | "benign" | "uncertain" | null`, Jev's judgment of this event (from its own call or
     a reused verdict), null when not judged.
   - `flag_id`: `string | null`, the flag the event belongs to.

   Without them the UI can say an event was decided but not what Jev thought or whether it alerted.
   *Fallback:* when the fields are absent (undefined, not null), the event page omits those rows, and the setup
   page finds the flag by opening the flags raised since the test started and checking their events.

## Assumptions where the contract is open

- **`since`** on `/events` and `/stats`: the UI sends durations (`1h`, `24h`, `7d`), as `parseTime` in
  `src/server.ts` accepts, and an ISO time for the test-event fallback.
- **`Event.source`** is assumed to be the `Source.id` (the `/in/:id` path segment). The UI shows the source's
  name when it matches a source id and the raw value otherwise (e.g. `sentry` from the legacy `/in/sentry`
  path). The source filter sends `Source.id`.
- **Sources** have no hard delete: `DELETE /sources/:id` revokes, and revoked sources stay in the list with
  `revoked_at` (shown folded under "Revoked sources"). There is no per-source test; the end-to-end check is the
  workspace's `POST /test-event`. Which source the test event is filed under is not specified (the mock uses
  `cloudfriend-test`).
- **Decisions of a flag** are derived from its events' `decision_id`s, so they disappear once the events pass
  retention. A `decision_ids` field on `Flag` would fix that.
- **Reopen**: `PATCH /flags/:id` allows only `acknowledged` and `resolved`, so the UI offers no reopen.
  Feedback (`confirmed` / `false_positive`) is offered in any status except the one already set.
- **"Report as missed"** has no stored state in `Event`, so after a reload the button is enabled again
  (reporting twice is harmless). A `reported_missed_at` field would let the UI show it.
- **Budget reset time** isn't in `/usage`; the banner says "until the budget resets" and names the `day`.
- **403** means "not a member" for page loads, which show a "No access" page. A 403 from a missing CSRF header
  on a POST shows as an inline error with the server's message; a different status (or message) for CSRF
  failures would make that less confusing.
- **OIDC**: the sign-in page links to `auth/oidc/login`. After the callback the server redirects to `/`; the URL
  hash the person had open isn't sent to the server, so they land on their last workspace, not the exact page.

## What the server needs to do for the UI

- Serve `src/ui/static/` at `/`, and `index.html` for unknown non-API GET paths. All routing is in the URL hash.
- All asset and API URLs in the UI are relative to the static root (`api/...`, `auth/oidc/login`), so the app
  also works under a path prefix if the API is mounted under the same prefix.
- No inline scripts or styles: the UI runs under a strict CSP, which the mock sends and the real server should too:
  `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
- `Delivery.destination_name` should still be filled for a deleted destination (the mock says "(deleted destination)").
