# cloudfriend

cloudfriend is a live event triage pipeline in one Docker container. Events from any number of sources stream in. A fast classifier scores every one, a stronger model (Jev) judges the few that might matter, and the escalations land in a queue and in Slack. Every Jev verdict and every human correction trains the classifier, so over time less of the stream needs Jev.

```
Sources ──> [ In ──> Classifier ──> Jev ──> Out ] ──> escalation queue, Slack, webhooks, agents
                        │ LightGBM,   │ few examples      ▲
                        │ every event │ per template      │ labels: Jev verdicts,
                        └─────────────┴───────────────────┘ confirmed / false positive / missed
                Postgres: durable queue, events for 7 days, flags and labels kept
```

- **In:** `POST /in/<source>` accepts any JSON. Adapters for Sentry and PostHog pull out ids and grouping hints.
- **Classifier:** a LightGBM model scores each event as it is parsed, about 30,000 events a second on one core. Routine events stop here, at no cost.
- **Jev:** events that pass the classifier are grouped by message template. Recent verdicts are reused, and a few examples per template go to Jev (TypeSafe's Jev router on OpenRouter) in batches. In the benchmarks, Jev read about 1 line in 2,000.
- **Out:** each escalation becomes a flag in the queue (`GET /queue`) and goes to every enabled action: Slack, a webhook, or your own adapter.
- **Learn:** Jev's verdicts, audit samples and people's feedback are stored as labels. The classifier is retrained on them and swapped in only if it beats the current one.

Everything lives in one Postgres database: the queue, events, flags, labels and secrets. There is no Redis and no separate job queue; only trained model files are written to disk, under `/data/models`.

Try it: [cloudfriend.dev/demo](https://cloudfriend.dev/demo) replays real incidents from public benchmarks through the pipeline.

## Quick start

cloudfriend needs a Postgres database (tested with Postgres 14) that its user can create tables in. It creates its schema on first boot and migrates it on later ones.

```bash
docker run -p 8080:8080 -v cloudfriend-models:/data \
  -e CLOUDFRIEND_DATABASE_URL=postgres://cloudfriend:secret@db.internal:5432/cloudfriend \
  -e CLOUDFRIEND_ADMIN_KEY=change-me \
  -e JEV_API_KEY=sk-or-... \
  -e SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
  ghcr.io/aosresearch/cloudfriend
```

On first boot cloudfriend creates an ingest secret and prints it to the logs once:

```
========================================================================
First boot: created an ingest secret named 'default'. It is shown only once:

  cloudfriend_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
...
```

Send an event:

```bash
curl -X POST http://localhost:8080/in/myapp \
  -H "Authorization: Bearer cloudfriend_..." \
  -d '{"level":"error","message":"payment provider timeout","route":"/checkout"}'
# accepted (202)
```

The classifier scores the event at once. If it might matter, it goes to Jev within about 10 seconds. If Jev escalates it, a flag is posted to Slack and appears in `GET /queue`.

Open `http://localhost:8080` for the dashboard. Without `CLOUDFRIEND_ADMIN_EMAIL` and `CLOUDFRIEND_ADMIN_PASSWORD`, the first boot also prints a generated password for `admin@localhost`; see [Dashboard and sign-in](#dashboard-and-sign-in).

To build the image yourself, run `docker build -t cloudfriend .`.

### Point Sentry at it

1. Create a secret for Sentry: `docker exec <container> cloudfriend secrets create sentry-prod --source sentry`.
2. In Sentry, go to **Settings → Developer Settings → Custom Integrations → New Internal Integration**. Set the webhook URL to `https://<your-host>/in/sentry?secret=<secret>`, turn on **Alert Rule Action**, and subscribe to the **issue** and **error** webhooks you want.
3. Optionally set `SENTRY_CLIENT_SECRET` to the integration's client secret. cloudfriend then also checks the `Sentry-Hook-Signature` header.

The legacy **WebHooks** alert plugin works too: use the same URL.

### Point PostHog at it

Create an **HTTP Webhook** destination with URL `https://<your-host>/in/posthog` and add the header `Authorization: Bearer <secret>`. The default `{ event, person }` body works as is. Capture-style payloads and `{ batch: [...] }` also work, and each item becomes one event.

### Anything else

`POST /in/<anything>` accepts any body. A JSON object becomes one event, a JSON array or NDJSON becomes one event per item, and plain text becomes `{ "raw": "..." }`. The `<anything>` part becomes the event's `source`. Senders that can't set headers can pass the secret as `?secret=`.

## Dashboard and sign-in

The server also serves a dashboard at `/`: a setup checklist, the escalation queue, events, sources, destinations and usage. People sign in with a password or with your identity provider (OIDC), and see only the workspaces they are members of.

- **First admin.** Set `CLOUDFRIEND_ADMIN_EMAIL` and `CLOUDFRIEND_ADMIN_PASSWORD` (at least 12 characters) and that account exists with that password at every boot; changing the password in the environment signs its old sessions out. Without them, the first boot of an empty database creates `admin@localhost` with a random password and prints it to the logs once. The first admin becomes the owner of the `default` workspace, the one the admin API and the first-boot ingest secret use.
- **Workspaces.** Anyone signed in can create a workspace and owns it. Sources, destinations, events and flags belong to one workspace, and every dashboard request is checked against the person's membership.
- **Sources** each get an endpoint, `CLOUDFRIEND_PUBLIC_URL/in/<source id>`, and a secret shown once. Events sent there are filed under the source's id and parsed by its kind (`json`, `sentry`, `posthog`). Rotating a secret keeps the old one working for 24 hours; revoking a source stops all its secrets at once. Secrets made with the admin API keep working as before on `/in/<name>`.
- **Destinations** are where alerts go: a Slack incoming webhook or your own webhook, over https. Private and loopback addresses are refused unless `CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS=on`. Their URLs and signing secrets are never shown again, only a masked URL.
- **Setup** sends a test exception through the same path as real events (queued, scored, routed, judged), so you can watch the whole pipeline work.

Sign-in uses an `HttpOnly`, `SameSite=Lax` session cookie (`Secure` when `CLOUDFRIEND_PUBLIC_URL` is https). Sessions expire after `CLOUDFRIEND_SESSION_TTL` without use. Put cloudfriend behind TLS and set `CLOUDFRIEND_PUBLIC_URL` to the address people use.

### Single sign-on (OIDC)

Set `CLOUDFRIEND_OIDC_ISSUER`, `CLOUDFRIEND_OIDC_CLIENT_ID`, `CLOUDFRIEND_OIDC_CLIENT_SECRET` and `CLOUDFRIEND_PUBLIC_URL`, and register this redirect URI with the provider:

```
<CLOUDFRIEND_PUBLIC_URL>/auth/oidc/callback      e.g. https://cloudfriend.example.com/auth/oidc/callback
```

- **Auth0:** create a *Regular Web Application*, add the redirect URI under *Allowed Callback URLs*, and use `https://<tenant>.auth0.com/` (with the trailing slash) as the issuer.
- **Google:** create an *OAuth client ID* of type *Web application* in Google Cloud, add the redirect URI under *Authorized redirect URIs*, and use `https://accounts.google.com` as the issuer. Set `CLOUDFRIEND_OIDC_ALLOWED_DOMAINS=yourcompany.com`, or any Google account can sign in.

People are matched by the provider's subject id, not by email. A first sign-in needs an email the provider says is verified (`email_verified`): it creates the account, or links to an existing account with the same email. Without it, sign-in is refused (`?auth_error=sso_unverified`, and a warning in the logs), so nobody can claim an address for someone else's later sign-in. New accounts are members of no workspace until they create one. `CLOUDFRIEND_ADMIN_EMAIL` can't name an account created by SSO sign-in: boot fails with a message saying so.

## How it works

### Durable intake

An event is committed to Postgres before cloudfriend replies.

1. The request's secret is checked, along with the source adapter's `verify()` if it has one.
2. The raw bytes are appended to a `queue` table. A writer loop collects requests for about 2 ms and inserts them with one multi-row `INSERT` in one transaction, so one commit covers the batch. Each request waits for the commit that holds its row, then gets `202`.
3. If the write fails or the workspace's queue is over its limit, cloudfriend replies `503` with `Retry-After`, so the sender retries.

There is no JSON parsing and no model call in the request path.

### The worker

Three stages run in the background. Each one commits its own result, so a crash at any point loses nothing. Parse and decide run per workspace, in the one worker that holds the workspace's lease; delivery is shared by all workers.

| Stage | Reads | Writes (in one transaction) |
| --- | --- | --- |
| parse | queue rows with status `new` | events with their classifier score, route and feature vector. Dropped events are marked decided. Then the queue row is set to `done` (or `failed` if the adapter threw) |
| decide | undecided events, once 100 are waiting or the oldest has waited 10 s | flags, one pending delivery per destination, training labels, and marks the events decided with Jev's judgment, flag and call |
| deliver | pending deliveries that are due | `ok`, or a retry with backoff (5 s doubling up to 1 h, 15 attempts) |

After a crash or restart, anything not yet done is picked up again. No transaction is held open during a model call or a delivery. Delivery to actions is at-least-once. Each flag has a stable `id`, sent to webhooks as `x-cloudfriend-flag-id`, which receivers can use to ignore repeats. If the decider fails (model down, bad key), its events stay queued and the call is retried with backoff up to 5 minutes.

### Triage

Every parsed event goes through a featurizer: message template, rates, novelty, error signals, service context. A LightGBM model then gives it a score, and the score picks the route:

| Route | When | |
| --- | --- | --- |
| `drop` | score below the model's `drop_below`, and Jev or a person has judged this kind of event benign | done, no cost |
| `jev` | score at or above `drop_below` | Jev decides |
| `review` | a low score, but its kind hasn't earned suppression yet (or it changed: much busier, its service failing), or its escalation expired | Jev looks once; one example per kind |
| `novel` | an error-like event whose template was never seen before | Jev sees it once |
| `known` | its template was escalated (by Jev or a person) in the last 7 days | Jev always sees it; the classifier can't drop a repeat. After 7 days the next one is reviewed, not dropped |
| `audit` | 1% of what would be dropped | Jev checks it, to find what the classifier misses |
| `classifier` | there is no Jev; score at or above the model's `threshold` | escalated by the classifier alone |

Before a batch goes to Jev, events whose template and severity Jev ruled on in the last 15 minutes reuse that verdict. A "yes" adds them to the open flag instead of raising a new one. A "no" is not reused for audit, novel or review events, once the template's rate doubles, or for an event the classifier scores far higher. At most 3 examples per template are sent, each with real counts of how often the template and its service occurred recently. Jev judges every event it reads as relevant, benign or uncertain. [docs/triage.md](docs/triage.md) has the details.

### Training

Each event Jev judges relevant or benign becomes a label with the feature vector the classifier saw. Events Jev calls uncertain, or doesn't judge, get no label. People add labels by confirming flags, marking false positives, flagging missed events, or importing history. `cloudfriend train`, `POST /model/train`, or the daily schedule then:

1. splits the labels by time into fit, calibrate and accept parts (60/20/20), keeping each incident in one part,
2. trains new LightGBM trees on top of the built-in model (`ml/train.py`) on the fit part, and picks its thresholds on the calibrate part,
3. checks on recent live traffic that the candidate won't cut Jev's share by more than half in one step,
4. requires it to still send 99.5% of the accept part's relevant events to Jev (by score, or by the routing rules as they stood), and to pass every regression scenario (`regression/`: event sequences with their history, run through the whole pipeline),
5. runs it in shadow next to the active model and promotes it on evidence: at least 24 hours, and at least 200 judged events it would newly drop, none of them relevant. One relevant one rejects it; without enough evidence it is rejected after 7 days.

[docs/training.md](docs/training.md) has the details.

### Storage

- **Events** are kept for `CLOUDFRIEND_RETENTION` (7 days by default), then deleted by a cleanup job that works in chunks of 1000 rows. Events the decider hasn't seen yet are never deleted.
- **Flags** are kept until you delete them. Each flag lists its `event_ids`, its queue `status` and the `users` found in its events.
- **Labels** and **models** are kept until you delete them. Labels carry their own copy of the event and its features, so they outlive event retention.
- Everything above lives in Postgres, so a replaced container loses nothing. Every row carries a `workspace_id`.
- Trained model files are written under `/data/models`. Mounting a volume at `/data` keeps a promoted model across a replaced container; without one, the built-in model is used until the next promotion. The image runs as the `node` user (uid 1000), so a bind-mounted directory must be writable by that user.

## Configuration

Everything is set through environment variables.

| Variable | Default | |
| --- | --- | --- |
| `CLOUDFRIEND_ADMIN_KEY` | *(unset)* | Key for the admin API. The admin API is disabled until this is set. It can never be used to send events. |
| `CLOUDFRIEND_ROLE` | `all` | `all` runs HTTP and the worker. `web` runs HTTP and intake only. `worker` runs the worker and serves only `/healthz`. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `CLOUDFRIEND_DATABASE_URL` | *(required)* | Postgres connection string, e.g. `postgres://user:password@host:5432/cloudfriend`. `DATABASE_URL` is used if this is unset. cloudfriend exits at boot if neither is set. |
| `CLOUDFRIEND_DB_POOL` | `10` | Connections to Postgres per process. |
| `CLOUDFRIEND_DATA_DIR` | `/data` in the image, `./data` otherwise | Where trained model files are written (`models/`). |
| `CLOUDFRIEND_BATCH_SIZE` | `100` | Events per decider call. |
| `CLOUDFRIEND_BATCH_WAIT` | `10s` | Longest an event waits for its batch to fill. |
| `CLOUDFRIEND_DECIDER` | `jev` | Which decider adapter to use. |
| `CLOUDFRIEND_DECIDER_CONCURRENCY` | `2` | Decider calls in flight at once per worker, shared fairly between workspaces. |
| `CLOUDFRIEND_JEV_DAILY_BUDGET_USD` | *(unset: no cap)* | Decider spend per workspace per UTC day. Once reached, the classifier decides alone until the day ends. A workspace's `jev_budget_usd` setting overrides it. |
| `CLOUDFRIEND_ACTIONS` | *(every configured action)* | Comma-separated list, e.g. `slack,webhook`. |
| `CLOUDFRIEND_RETENTION` | `7d` | How long events are kept. |
| `CLOUDFRIEND_MAX_QUEUE` | `1000000` | Unparsed requests per workspace allowed before ingest replies `503`. |
| `CLOUDFRIEND_MAX_BODY_BYTES` | `1048576` | Larger bodies get `413`. |
| `CLOUDFRIEND_COMMIT_WINDOW` | `2ms` | Group-commit window. |
| `CLOUDFRIEND_ADAPTER_DIR` | *(unset)* | Extra adapters to load without rebuilding the image (see below). |
| `CLOUDFRIEND_LOG` | `info` | `debug`, `info`, `warn`, `error` or `silent`. |
| **Workers** | | |
| `CLOUDFRIEND_LEASE_TTL` | `30s` | How long a worker's hold on a workspace lasts without renewal. After a crash, another worker takes over once it runs out. |
| `CLOUDFRIEND_LEASE_RENEW` | `10s` | How often a worker renews its leases. Must be shorter than the TTL. |
| `CLOUDFRIEND_MAX_WORKSPACES_PER_WORKER` | `200` | Most workspaces one worker holds at once. |
| `CLOUDFRIEND_IDLE_UNLOAD` | `10m` | A workspace with no work for this long is saved, released and dropped from the worker's memory. |
| **Triage** | | |
| `CLOUDFRIEND_TRIAGE` | `on` | `off` sends every event to the decider, as v0 did. |
| `CLOUDFRIEND_MODEL` | | Model file to load. By default the last promoted model (`/data/models/active.json`), else the built-in `models/base.json`. |
| `CLOUDFRIEND_AUDIT_RATE` | `0.01` | Share of dropped events sent to Jev anyway, to find missed escalations. |
| `CLOUDFRIEND_AUDIT_WAIT` | `5m` | Longest a batch of only audit samples waits for other events. |
| `CLOUDFRIEND_NOVEL_ERRORS` | `on` | Send error-like events of a never-seen template to Jev once. |
| `CLOUDFRIEND_ESCALATED_TTL` | `7d` | How long an escalated template keeps going to Jev whatever its score. `off` disables. |
| `CLOUDFRIEND_ESCALATED_MEMORY` | `90d` | After that, how long its next event still gets a review instead of being dropped. |
| `CLOUDFRIEND_SUPPRESSION_TTL` | `30d` | How long a benign judgment lets the classifier drop its kind of event. `off` lets it drop without one. |
| `CLOUDFRIEND_VERDICT_TTL` | `15m` | How long a Jev verdict on a template, at one severity, is reused. |
| `CLOUDFRIEND_EXAMPLES_PER_TEMPLATE` | `3` | Examples of one template per Jev batch. |
| **Training** | | |
| `CLOUDFRIEND_RETRAIN_INTERVAL` | `24h` | How often to retrain if enough labels arrived. `off` disables. Only runs while there is one workspace, since the model serves all of them. |
| `CLOUDFRIEND_RETRAIN_MIN_LABELS` | `200` | New labels needed before a scheduled run. |
| `CLOUDFRIEND_HUMAN_LABEL_WEIGHT` | `5` | Weight of a person's label relative to Jev's. |
| `CLOUDFRIEND_RECALL_TARGET` | `0.995` | Share of held-out relevant events a new model must still send to Jev. |
| `CLOUDFRIEND_SHADOW_PERIOD` | `24h` | The least time a new model runs in shadow before it can replace the active one. `off` promotes at once. |
| `CLOUDFRIEND_SHADOW_MIN_EVIDENCE` | `200` | Judged events it would newly drop, none relevant, before it is promoted. |
| `CLOUDFRIEND_SHADOW_MAX` | `7d` | How long it may collect that evidence before it is rejected. |
| `CLOUDFRIEND_REGRESSION_SUITE` | | A directory of your own regression scenarios, run with the built-in ones at every promotion. |
| `CLOUDFRIEND_SAFETY_SET` | | Directory with a labelled `candidates.csv` and `candidates.features.csv`. How many `must_reach` rows a new model sends to Jev by score is reported, as a diagnostic. |
| `CLOUDFRIEND_INCIDENT_WINDOW` | `30m` | Labels of one template within this window stay in the same training split. |
| `CLOUDFRIEND_PYTHON` | `python3` | Interpreter with LightGBM, for training. |
| **Jev decider** | | |
| `JEV_API_KEY` | `OPENROUTER_API_KEY` | OpenRouter key for Jev. Without any key, the classifier decides alone. |
| `JEV_MODEL` | `typesafe/jev-router` | Any OpenRouter model id. |
| **OpenRouter decider** (`CLOUDFRIEND_DECIDER=openrouter`) | | |
| `OPENROUTER_API_KEY` | | |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-5.5` | Any OpenRouter model id. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. Used by both deciders. |
| `CLOUDFRIEND_DECIDER_INSTRUCTIONS` | | Extra context for the model, e.g. "Checkout and billing matter most; ignore staging." |
| `CLOUDFRIEND_EVENT_CHARS` | `1500` | Most characters of each event shown to the model. |
| **Slack action** | | |
| `SLACK_WEBHOOK_URL` | | Slack incoming webhook. On first boot it becomes a destination of the default workspace, if that has none yet. |
| `SLACK_MIN_SEVERITY` | `low` | Only post flags at or above this severity. |
| **Webhook action** | | |
| `WEBHOOK_URL` | | Receives `POST {"flag": ..., "events": [...]}`. Becomes a destination of the default workspace like `SLACK_WEBHOOK_URL`. |
| `WEBHOOK_SECRET` | | Adds `x-cloudfriend-signature: sha256=<HMAC of body>`. |
| **Dashboard and sign-in** | | |
| `CLOUDFRIEND_PUBLIC_URL` | *(the request's address)* | The address people and senders use, e.g. `https://cloudfriend.example.com`. Used for source endpoint URLs, the OIDC redirect URI and `Secure` cookies. Required for OIDC. |
| `CLOUDFRIEND_ADMIN_EMAIL` / `CLOUDFRIEND_ADMIN_PASSWORD` | *(unset)* | The first admin, kept in sync at every boot. Set both or neither; the password needs 12 characters or more. Without them, the first boot creates `admin@localhost` and prints its password once. |
| `CLOUDFRIEND_SESSION_TTL` | `30d` | How long a session lasts without use (5m to 400d). |
| `CLOUDFRIEND_OIDC_ISSUER` | | The provider's issuer URL, e.g. `https://example.auth0.com/`. OIDC is on when the issuer, client id and secret are all set. |
| `CLOUDFRIEND_OIDC_CLIENT_ID` / `CLOUDFRIEND_OIDC_CLIENT_SECRET` | | The client registered with the provider. Its redirect URI is `CLOUDFRIEND_PUBLIC_URL/auth/oidc/callback`. |
| `CLOUDFRIEND_OIDC_ALLOWED_DOMAINS` | *(any)* | Comma-separated email domains allowed to sign in, e.g. `example.com`. |
| `CLOUDFRIEND_OIDC_LABEL` | `Sign in with SSO` | The sign-in button's label. |
| `CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS` | `off` | `on` lets destinations use http and private or loopback addresses (self-hosted, e.g. a webhook on your network). |
| **Sentry source** | | |
| `SENTRY_CLIENT_SECRET` | | When set, the `Sentry-Hook-Signature` header is required and checked. |

Durations accept `ms`, `s`, `m`, `h` and `d`.

## API

Ingest uses an ingest secret. The admin API below uses `Authorization: Bearer $CLOUDFRIEND_ADMIN_KEY` and works on the `default` workspace, for scripts and the CLI. The dashboard's own API (`/api/...`, signed-in sessions, every workspace) is described in [design/api-contract.md](design/api-contract.md).

### Ingest

| | |
| --- | --- |
| `POST /in/:source` | `202` once stored. `401` for a bad secret, `413` if the body is too large, `503` to retry later. `:source` is a source id from the dashboard (its secret works only there), or any name for secrets made with the admin API. |
| `GET /healthz` | `{ "ok": true, "queued": <unparsed requests> }`. Needs no auth. |

### Secrets

Ingest secrets are created and revoked at runtime. Only a SHA-256 hash is stored, and the plain secret is shown once.

| | |
| --- | --- |
| `POST /secrets` | Body `{"name": "sentry-prod", "source": "sentry"}`. `source` is optional and limits the secret to `/in/sentry`. Returns the secret once. |
| `GET /secrets` | Name, scope, prefix, created, last used, revoked. |
| `DELETE /secrets/:id` | Revokes the secret immediately. |

The same operations work from the CLI inside the container, which needs no admin key:

```bash
docker exec <container> cloudfriend secrets create sentry-prod --source sentry
docker exec <container> cloudfriend secrets list
docker exec <container> cloudfriend secrets revoke sec_1a2b3c4d5e6f7a8b
docker exec <container> cloudfriend train [--dry-run]
docker exec <container> cloudfriend model
docker exec <container> cloudfriend regression [--model file]
docker exec <container> cloudfriend labels import history.ndjson
```

To rotate a secret, create a new one, update the sender, then revoke the old one.

### Flags, the queue and events

| | |
| --- | --- |
| `GET /queue?status=&limit=` | Flags waiting on a person (`open` and `acknowledged`), most severe first, then newest. |
| `GET /flags?since=&until=&severity=&status=&limit=&before=` | Newest first. To get the next page, pass the response's `next` as `before`. |
| `GET /flags/:id` | `{ flag, events, deliveries }`. The events are the ones still within retention. |
| `PATCH /flags/:id` | `{"status": "acknowledged" \| "resolved" \| "open", "note": "..."}` |
| `POST /flags/:id/feedback` | `{"verdict": "confirmed" \| "false_positive"}`. Labels the flag's events for training. |
| `DELETE /flags/:id` | |
| `GET /events?source=&user=&route=&since=&until=&type=&group_key=&limit=&before=` | Newest first, paged the same way. `user` links events from every source that mention the same user. |
| `GET /events/:id` | Includes the classifier's `score` and `route`. |
| `POST /events/:id/feedback` | `{"escalate": true}` for a missed escalation (or `false`). Returns the kind of mistake. |

### Labels, the model and stats

| | |
| --- | --- |
| `GET /labels` | Label counts by source (`jev`, `human`) and verdict. |
| `POST /labels` | `[{"source", "data", "received_at", "escalate"}]`: import labelled history. |
| `GET /decisions/:id` | One decider call that produced labels: the exact prompt, the raw reply, the model and the events. Labels point to it by `decision_id`. |
| `GET /model` | The active classifier, the one in shadow if any with its evidence so far, and the last training runs with their reports. |
| `GET /model/shadow/review` | Events the model in shadow would newly drop that a person should look at: judged relevant, or not judged at all. |
| `POST /model/train?dry_run=1` | Train now. Returns the run's report. |
| `GET /stats?since=24h` | Events per route, share past the classifier, flags by status, Jev calls since start, the model. |

`since` and `until` take ISO 8601, epoch milliseconds, or a relative duration such as `since=1h`. `limit` defaults to 100 and caps at 1000.

```bash
curl -H "Authorization: Bearer $CLOUDFRIEND_ADMIN_KEY" "localhost:8080/events?source=sentry&since=1h"
```

A flag looks like this:

```json
{
  "id": "flg_8c1d0e4f2a7b9c3d5e6f",
  "reason": "Checkout TypeError started after deploy, 14 events in 2 minutes",
  "severity": "high",
  "event_ids": ["1041", "1042", "1057"],
  "created_at": "2026-10-25T17:30:12.000Z",
  "decider": "jev",
  "status": "open",
  "event_count": 14,
  "users": ["u_4417"],
  "updated_at": "2026-10-25T17:31:40.000Z",
  "note": null
}
```

An event looks like this:

```json
{
  "id": "1041",
  "source": "sentry",
  "received_at": "2026-10-25T17:30:00.000Z",
  "data": { "...": "the raw payload" },
  "external_id": "4711",
  "type": "issue.created",
  "group_key": "issue:4711"
}
```

`external_id`, `type` and `group_key` are optional hints set by source adapters.

## Writing an adapter

An adapter is one TypeScript file with one default export, and its name is the file name. Built-in adapters live in `src/adapters/{sources,deciders,actions}/`. To add your own without rebuilding the image, put files in the same layout under a directory and set `CLOUDFRIEND_ADAPTER_DIR`:

```bash
docker run ... -v ./my-adapters:/adapters -e CLOUDFRIEND_ADAPTER_DIR=/adapters ghcr.io/aosresearch/cloudfriend
# my-adapters/sources/stripe.ts      -> POST /in/stripe
# my-adapters/deciders/rules.ts      -> CLOUDFRIEND_DECIDER=rules
# my-adapters/actions/pagerduty.ts   -> on when its enabled() says so
```

A file in `CLOUDFRIEND_ADAPTER_DIR` overrides a built-in adapter with the same name. Node runs TypeScript directly, so there is nothing to compile. Use type-only imports and avoid `enum` and other non-erasable syntax. The interfaces are in [`src/types.ts`](src/types.ts).

### Source: `parse(body) → events[]`

```ts
// sources/stripe.ts
import type { SourceAdapter } from "../../src/types.ts"; // types only; erased at runtime

export default {
  // Optional. Runs in the request path, so keep it cheap: no network, no JSON parsing.
  verify(req) {
    return Boolean(req.headers["stripe-signature"]);
  },
  // Runs later, in the worker. Return [] to drop the request.
  parse(body) {
    const evt = JSON.parse(new TextDecoder().decode(body));
    if (evt.type?.startsWith("customer.")) return [];
    return [{ data: evt, id: evt.id, type: evt.type, group_key: evt.data?.object?.id }];
  },
} satisfies SourceAdapter;
```

Only `data` is required. The hints `id`, `type` and `group_key` are optional, and deciders must work without them. Requests to a source with no adapter of that name use `json`.

### Decider: `decide(events[]) → flags[]`

```ts
// deciders/rules.ts
import type { DeciderAdapter } from "../../src/types.ts";

export default {
  async decide(events) {
    const fatal = events.filter((e) => (e.data as any)?.level === "fatal");
    return fatal.length
      ? [{ reason: `${fatal.length} fatal errors`, severity: "critical", event_ids: fatal.map((e) => e.id) }]
      : [];
  },
} satisfies DeciderAdapter;
```

Each event has `id`, `source`, `received_at` and `data`. Return flags with `reason`, `severity` (`low`, `medium`, `high` or `critical`) and the `event_ids` from this batch. cloudfriend assigns flag ids and ignores ids that aren't in the batch. Throw to have the batch retried later. A decider can be a model, plain rules, or both, for example rules first and the model for the rest.

### Action: `run(flag) → ok`

```ts
// actions/pagerduty.ts
import type { ActionAdapter } from "../../src/types.ts";

export default {
  enabled: (env) => Boolean(env.PAGERDUTY_ROUTING_KEY),
  async run(flag, { env, events, signal }) {
    if (flag.severity !== "critical") return;
    const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: env.PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        dedup_key: flag.id, // at-least-once delivery: dedupe on the flag id
        payload: { summary: flag.reason, severity: "critical", source: events[0]?.source ?? "cloudfriend" },
      }),
    });
    if (!res.ok) throw new Error(`pagerduty ${res.status}`); // retried with backoff
  },
} satisfies ActionAdapter;
```

`ctx.events` holds up to 50 of the flag's events. If `run` throws or returns `false`, the delivery is retried. Each run times out after 15 seconds. Slow work, like an agent investigating the flag, belongs downstream of an action: send the flag somewhere and return.

## Development

cloudfriend needs Node 22.18 or later and a Postgres database. It runs the TypeScript directly, so there is no build step and no native module.

```bash
npm install
CLOUDFRIEND_DATABASE_URL=postgres://localhost/cloudfriend npm run dev   # restarts on change
npm test             # unit tests, plus an end-to-end run with mock OpenRouter and Slack
npm run test:docker  # builds the image and tests it in Docker (needs a running Docker daemon)
npm run typecheck
npm run cloudfriend -- secrets list
python3 -m pip install lightgbm numpy  # only for training; see ml/README.md
```

`npm test` needs no Docker. With `TEST_DATABASE_URL` set, it uses that server (its user needs `CREATEDB`). Otherwise it starts a throwaway Postgres cluster from the local binaries (`initdb` and `pg_ctl`, from Homebrew or `PG_BIN`) in a temporary directory on a free port, and removes it afterwards. Every test gets a fresh database.

`npm run test:docker` runs the image against a mock OpenRouter and Slack on the host. It has not been updated for Postgres yet (it starts the container without a database), so it fails until it is. It checks that:

- the container runs as a non-root user and reports healthy
- the first-boot secret appears in `docker logs`
- a Sentry webhook becomes a flag in Slack
- the CLI works through `docker exec`
- data survives `docker restart` and container replacement
- no accepted event is lost to a `SIGKILL` while requests are still unparsed
- `docker stop` exits 0 promptly

To test an existing image instead of building one, set `CLOUDFRIEND_IMAGE=ghcr.io/aosresearch/cloudfriend:tag`.

## Benchmarks

The built-in classifier is trained and evaluated on two public datasets with real logs. The data, the labels and the splits are described in [docs/benchmarks.md](docs/benchmarks.md), and [ml/README.md](ml/README.md) has the commands to reproduce everything.

- **RCAEval RE3** (90 cases, MIT): code-level faults injected into Online Boutique, Sock Shop and Train Ticket. It measures whether the fault was escalated, how fast, and how much of the stream reached Jev.
- **GAIA MicroSS** (two weeks, about 50M log lines): normal operation with occasional injected faults. It measures how many of its 385 incidents reach Jev, and what quiet days cost.

Each case is replayed causally, as the server would run it, and results are per incident, keeping apart **withheld** (stage 1 never sent the incident to Jev) from **dismissed** (Jev saw it and didn't alert). The labels are heuristics, so every number is weak, and each comes with an exact bound:

- Leaving each RE3 fault group out in turn, stage 1 withheld none of 90 incidents (at most 3.3% at 95%), with Jev reading 0.84% of events.
- On two GAIA days, it withheld 8 of 47 incidents. All 8 left only one to three labelled events; of the 30 incidents with more, it withheld none.
- With live Jev on a small sample (6 RE3 faults, 4 GAIA incidents, $6.54), every incident was detected, none dismissed, with a median of 30 seconds to an alert on RE3.

Samples of Jev's judgments and of what stage 1 drops are in `benchmarks/review/` for people to label, since neither the weak labels nor Jev are ground truth. See [docs/benchmarks.md](docs/benchmarks.md).

## Left out on purpose

These are left out on purpose: a rules engine, roles beyond a workspace's owner and members, and retraining the classifier per workspace. They can be added when people ask for them.
