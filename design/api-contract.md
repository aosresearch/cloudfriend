# Dashboard API contract (self-hosted v1)

The dashboard is a static, no-build UI served by the app at `/` (files under `src/ui/static/`). It talks to
the JSON API below. Ingest (`POST /in/:source`) keeps using source secrets and is not part of this API.

All `/api/*` responses are JSON. Errors: `{ "error": "<message>" }` with a 4xx/5xx status. `401` means "not
signed in" (the UI shows the sign-in page); `403` means signed in but not a member of that workspace.

Authentication is a session cookie `cf_session` (HttpOnly, SameSite=Lax, Secure when served over https).
State-changing requests (POST/PATCH/DELETE) must send header `x-cloudfriend-csrf: 1`; the server rejects
them otherwise (simple CSRF guard, the cookie is SameSite=Lax anyway).

Times are ISO 8601 strings. Ids are opaque strings.

## Sign-in

| | |
| --- | --- |
| `GET /api/auth-config` | `{ "password": true, "oidc": false, "oidcLabel": "Sign in with SSO" }`. No auth needed. |
| `POST /api/login` | Body `{ "email", "password" }` → `200 { "user" }` and sets the cookie, or `401`. The bootstrap admin signs in this way. |
| `POST /api/logout` | Clears the session. |
| `GET /auth/oidc/login` | Redirects to the OIDC provider. Shown only when `oidc` is true. |
| `GET /auth/oidc/callback` | Provider redirects here; sets the cookie and redirects to `/`. |
| `GET /api/me` | `{ "user": { "id", "email", "name" }, "workspaces": [{ "id", "name", "role": "owner" \| "member" }] }` or `401`. |

## Workspaces

| | |
| --- | --- |
| `GET /api/workspaces` | `{ "workspaces": [{ "id", "name", "role", "created_at" }] }` |
| `POST /api/workspaces` | Body `{ "name" }` → `201 { "workspace" }`. The creator becomes owner. |

Everything below is scoped: `/api/w/:ws/...` where `:ws` is a workspace id.

## Sources (where events come from)

A source is an ingest endpoint plus its secret. `kind` picks the parser: `json` (anything), `sentry`, `posthog`.

| | |
| --- | --- |
| `GET /api/w/:ws/sources` | `{ "sources": [Source] }` |
| `POST /api/w/:ws/sources` | Body `{ "name", "kind" }` → `201 { "source": Source, "secret": "cloudfriend_…" }`. The secret is shown once. |
| `POST /api/w/:ws/sources/:id/rotate` | `{ "source": Source, "secret": "cloudfriend_…" }`. The old secret keeps working for 24 h. |
| `DELETE /api/w/:ws/sources/:id` | Revokes it. `204`. |

`Source = { "id", "name", "kind", "endpoint_url", "secret_prefix", "created_at", "last_used_at", "revoked_at" }`.
`endpoint_url` is the full URL to POST events to, e.g. `http://localhost:8080/in/src_ab12cd34`.

## Destinations (where alerts go)

| | |
| --- | --- |
| `GET /api/w/:ws/destinations` | `{ "destinations": [Destination] }` |
| `POST /api/w/:ws/destinations` | Body `{ "name", "kind": "slack" \| "webhook", "url", "signing_secret"? }` → `201 { "destination" }`. `400` if the URL is not https (http allowed only for localhost when self-hosted with `CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on`) or resolves to a private address. |
| `DELETE /api/w/:ws/destinations/:id` | `204` |
| `POST /api/w/:ws/destinations/:id/test` | Sends a clearly labelled test message. `{ "ok": true }` or `{ "ok": false, "error": "webhook replied 404" }` (status only, never the response body). |

`Destination = { "id", "name", "kind", "url_display", "has_signing_secret", "created_at", "last_delivery_at", "last_error" }`.
`url_display` hides secrets in the URL, e.g. `https://hooks.slack.com/services/T0…/…`.

## Events, flags and decisions

| | |
| --- | --- |
| `GET /api/w/:ws/events?route=&source=&since=&limit=&before=` | `{ "events": [Event], "next": "<cursor>" \| null }`, newest first. |
| `GET /api/w/:ws/events/:id` | `{ "event": Event }` |
| `POST /api/w/:ws/events/:id/feedback` | Body `{ "escalate": true }` (report a missed event). `200 {}` |
| `POST /api/w/:ws/test-event` | Sends a test exception through the normal intake path for that workspace (not bypassing the sorter). `{ "queue_id" }`. |
| `GET /api/w/:ws/queue` | Open and acknowledged flags, most severe first: `{ "flags": [Flag] }` |
| `GET /api/w/:ws/flags?status=&limit=&before=` | `{ "flags": [Flag], "next" }` |
| `GET /api/w/:ws/flags/:id` | `{ "flag": Flag, "events": [Event], "deliveries": [Delivery] }` |
| `PATCH /api/w/:ws/flags/:id` | Body `{ "status": "acknowledged" \| "resolved" }` → `{ "flag" }` |
| `POST /api/w/:ws/flags/:id/feedback` | Body `{ "verdict": "confirmed" \| "false_positive" }` → `{ "flag" }` |
| `GET /api/w/:ws/decisions/:id` | `{ "decision": { "id", "created_at", "decider", "model", "prompt", "response", "event_ids" } }`. `prompt`/`response` are null after retention. |

- `Event = { "id", "source", "received_at", "data", "score", "route", "template", "severity", "decided", "decision_id" }`.
  `route` is one of `drop`, `review`, `novel`, `known`, `audit`, `jev`, `auto`, `classifier`, or null while pending.
  `decision_id` links to the Jev call that judged it, when there was one.
- `Flag = { "id", "reason", "severity": "low" | "medium" | "high" | "critical", "status": "open" | "acknowledged" | "resolved" | "confirmed" | "false_positive", "event_count", "users", "created_at", "updated_at", "decider" }`.
- `Delivery = { "destination_id", "destination_name", "status": "pending" | "ok" | "failed", "attempts", "last_error", "updated_at" }`.

## Usage and stats

| | |
| --- | --- |
| `GET /api/w/:ws/usage` | `{ "day": "2026-10-27", "events": 1234, "backlog": 0, "jev_calls": 12, "jev_spend_usd": 0.06, "jev_budget_usd": 5, "budget_exhausted": false, "decider": "jev" \| "classifier" \| "none" }` |
| `GET /api/w/:ws/stats?since=1h` | `{ "routes": { "drop": 980, "jev": 12, ... }, "events": 1000, "flags": 2 }` |

## Additions from building the dashboard

See `src/ui/CONTRACT-NOTES.md` for the reasoning. These are part of the contract:

- `GET /api/w/:ws/test-event/:queue_id` → `{ "queue_id", "status": "new" | "done" | "failed", "event": Event | null }`.
- `Event` also has `judgment` (`"relevant" | "benign" | "uncertain" | null`) and `flag_id` (string or null).
- `Event.source` is the `Source.id` the event arrived on (or the legacy `/in/<name>` segment).
- The server serves `src/ui/static/` at `/` with `index.html` for unknown non-API GET paths, and sends the CSP
  listed in the notes.
