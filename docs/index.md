---
title: Setup
---

# Setup

cloudfriend is a live event triage pipeline in one Docker container. Your systems send it events: Sentry issues, PostHog events, logs, anything JSON. A fast classifier scores every event, and a stronger model, Jev, judges the few that might matter. Jev flags the ones a person should look at, and each flag goes to the escalation queue, to Slack, to a webhook, or to your own action. Jev's verdicts and your feedback retrain the classifier, so less of the stream needs Jev over time. See [Triage](./triage.md) and [Training](./training.md).

This page gets you from nothing to a flag in Slack or your own webhook, with Docker Compose, and explains what each step does. For how it works inside, see [Architecture](./architecture.md).

## What you need

- **Docker with Compose v2** (Docker Desktop, or Docker Engine 25 or later with the Compose plugin), on any machine that can receive HTTP from the services that will send events. The image builds for `amd64` and `arm64`.
- **An OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) for Jev. cloudfriend uses it to ask Jev about the events the classifier passes on. Without it, the classifier escalates on its own, with less judgment.
- **A Slack incoming webhook URL** ([api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)), or any HTTP endpoint that should receive flags.

The Compose file runs Postgres next to cloudfriend, and everything lives in that one database. The cloudfriend container itself only writes trained model files, under `/data/models`. To use a Postgres you already run, see [Using your own Postgres](#using-your-own-postgres).

## 1. Configure it

From a checkout of the repository:

```bash
cp .env.example .env
```

Then edit `.env`. Every line in it is commented; these are the ones most setups touch:

| Variable | Why |
| --- | --- |
| `POSTGRES_PASSWORD` | Required. The password of the bundled Postgres, e.g. the output of `openssl rand -hex 24`. It is set when the database volume is first created. |
| `JEV_API_KEY` | Turns on Jev, the default decider. `OPENROUTER_API_KEY` works too. |
| `CLOUDFRIEND_PUBLIC_URL` | The https address people and senders use. Source endpoints, the sign-in redirect and `Secure` cookies follow it. |
| `CLOUDFRIEND_ADMIN_EMAIL` / `CLOUDFRIEND_ADMIN_PASSWORD` | The first admin. Leave both unset to get `admin@localhost` with a generated password. |
| `CLOUDFRIEND_JEV_DAILY_BUDGET_USD` | A cap on Jev spend per workspace per day. |
| `CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS` | `on` lets destinations use http and private addresses, e.g. a webhook on your own network. It also lets anyone who can sign in make the server call hosts on that network, so leave it off unless they are all trusted. |

`.env` holds secrets: keep it out of version control (the repository's `.gitignore` already does).

## 2. Start it

```bash
docker compose up -d
```

The first run builds the image from the checkout. Compose starts Postgres, waits until it accepts connections, then starts cloudfriend, which creates its schema. Both restart on their own after a crash or a reboot (`restart: unless-stopped`). To use the published image instead of building one, run `docker compose pull` first.

Check that it is up:

```bash
docker compose ps        # both services "healthy"
curl localhost:8080/healthz
# {"ok":true,"queued":0}
```

Port 8080 is published on every interface; set `CLOUDFRIEND_PORT=127.0.0.1:8080` in `.env` to keep it local, e.g. behind a reverse proxy on the same host. Postgres is not published at all.

## 3. Sign in

On first boot cloudfriend creates the dashboard admin and prints its password once:

```bash
docker compose logs cloudfriend
```

```
========================================================================
First boot: created a dashboard admin. The password is shown only once:

  email:     admin@localhost
  password:  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Sign in at http://localhost:8080/
Set CLOUDFRIEND_ADMIN_EMAIL and CLOUDFRIEND_ADMIN_PASSWORD to choose the admin yourself.
========================================================================
```

Only a hash is stored, so the password cannot be shown again. If you set `CLOUDFRIEND_ADMIN_EMAIL` and `CLOUDFRIEND_ADMIN_PASSWORD`, nothing is printed and that account is used; it is kept in sync with the two variables at every boot, which is also how to reset a lost password. To let people sign in with your identity provider, see *Single sign-on (OIDC)* in the README.

Open `http://localhost:8080` and sign in. The admin owns the `default` workspace.

## 4. Follow the setup checklist

Until a workspace has a source, the dashboard opens on its setup checklist:

1. **Connect a source.** Pick a name and a kind (`json`, `sentry` or `posthog`). The source gets an endpoint, `<public URL>/in/<source id>`, and a secret that is shown once, with a `curl` command that sends it an event.
2. **Add a destination**: a Slack incoming webhook, or your own webhook (with an optional signing secret). A test message checks that alerts reach it.
3. **Send a test exception.** It goes through the same path as real events: stored, scored by the classifier, routed, and judged by Jev. The page follows it step by step; if Jev alerts on it, it shows the flag and its deliveries.

Then look around: the **queue** holds flags waiting on a person, most severe first. A flag's page shows its events, Jev's reason and each delivery, and takes feedback (confirmed, false positive) that trains the classifier. **Events** lists what came in with each event's score, route and judgment, and **Usage** shows events, Jev calls and spend for the day.

A routine event, such as an info log, is dropped by the classifier and never reaches Jev. An error of a kind it has never seen goes to Jev within about 10 seconds.

## 5. Connect your sources

Create one dashboard source per sender, of the kind that matches it. A `sentry` or `posthog` source gets its payload understood: ids, event types and grouping hints are pulled out. A `json` source stores the JSON as is. Each source's secret works only on its own endpoint, so a leaked secret can only send to that one source, and revoking the source stops it.

Scripts can also use secrets made with the CLI, which work on `POST /in/<name>` for any name (or one name, with `--source`); a name with a built-in adapter (`sentry`, `posthog`) is parsed by it:

```bash
docker compose exec cloudfriend cloudfriend secrets create sentry-prod --source sentry
```

### Sentry

1. Create a source of kind `sentry` in the dashboard and copy its secret.
2. In Sentry, go to **Settings → Developer Settings → Custom Integrations → New Internal Integration**.
3. Set the webhook URL to the source's endpoint with the secret added: `https://<your-host>/in/<source id>?secret=<secret>`. Sentry cannot send custom headers, so the secret goes in the query string.
4. Turn on **Alert Rule Action** and subscribe to the **issue** and **error** webhooks you want.
5. Optional: set `SENTRY_CLIENT_SECRET` to the integration's client secret. cloudfriend then also checks the `Sentry-Hook-Signature` header on every request.

The legacy **WebHooks** alert plugin works too, with the same URL.

### PostHog

Create a source of kind `posthog` in the dashboard, then an **HTTP Webhook** destination in PostHog:

- URL: the source's endpoint, `https://<your-host>/in/<source id>`
- Header: `Authorization: Bearer <secret>`

The default `{ event, person }` body works as is. Capture-style payloads and `{ "batch": [...] }` also work, and each item becomes one event.

### Anything else

`POST /in/<name>` accepts any body:

- a JSON object becomes one event
- a JSON array, or newline-delimited JSON, becomes one event per item
- plain text becomes `{ "raw": "..." }`

Senders that cannot set headers can pass the secret as `?secret=`.

## 6. Put it behind HTTPS

cloudfriend speaks plain HTTP. Sentry, PostHog and most SaaS webhooks require an `https://` URL, so run cloudfriend behind something that terminates TLS: a load balancer, Caddy, nginx, Cloudflare Tunnel, or your platform's ingress. Forward everything to port 8080, and set `CLOUDFRIEND_PUBLIC_URL` in `.env` to the https address, so source endpoints and cookies use it.

## Using your own Postgres

cloudfriend needs a Postgres database (tested with Postgres 14 and 17) and a user that can create tables in it. It creates its schema on first boot and migrates it on later ones. Run the image on its own:

```bash
docker run -d --name cloudfriend --restart unless-stopped \
  -p 8080:8080 \
  -v cloudfriend-models:/data \
  -e CLOUDFRIEND_DATABASE_URL=postgres://cloudfriend:secret@db.internal:5432/cloudfriend \
  -e JEV_API_KEY=sk-or-... \
  ghcr.io/aosresearch/cloudfriend
docker logs cloudfriend   # the admin password, on first boot
```

Build it yourself with `docker build -t cloudfriend .`. Every variable in `.env.example` works as `-e`, apart from the Compose ones (`POSTGRES_PASSWORD`, `CLOUDFRIEND_PORT`, `CLOUDFRIEND_VERSION`, `COMPOSE_PROFILES`). A password with characters such as `@`, `/` or `:` must be percent-encoded in the URL, or passed as `PGPASSWORD` with the URL left without one. The other commands on this page work with `docker exec cloudfriend ...` in place of `docker compose exec cloudfriend ...`.

## Managing secrets

The CLI inside the container talks to the database directly and needs no admin key:

```bash
docker compose exec cloudfriend cloudfriend secrets create <name> [--source <source>]
docker compose exec cloudfriend cloudfriend secrets list
docker compose exec cloudfriend cloudfriend secrets revoke <id>
```

The same operations are available over HTTP with the admin key: `POST /secrets`, `GET /secrets`, `DELETE /secrets/:id`.

To rotate a secret, create a new one, update the sender, then revoke the old one. Revoking takes effect immediately. A dashboard source's secret is rotated from its page instead: the old secret keeps working for 24 hours.

## Configuration

Everything is set through environment variables: in `.env` with Compose, or with `-e`. Durations accept `ms`, `s`, `m`, `h` and `d`. The dashboard, sign-in, worker and budget settings are in the README's Configuration table and in `.env.example`.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLOUDFRIEND_ADMIN_KEY` | *(unset)* | Key for the admin API. The admin API is off until this is set. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `CLOUDFRIEND_DATABASE_URL` | *(required)* | Postgres connection string. `DATABASE_URL` is used if this is unset. |
| `CLOUDFRIEND_DB_POOL` | `10` | Connections to Postgres per process. |
| `CLOUDFRIEND_DATA_DIR` | `/data` | Where trained model files are written (`models/`). |
| `CLOUDFRIEND_BATCH_SIZE` | `100` | Events per decider call. |
| `CLOUDFRIEND_BATCH_WAIT` | `10s` | Longest an event waits for its batch to fill. |
| `CLOUDFRIEND_DECIDER_CONCURRENCY` | `2` | Decider calls in flight at once. |
| `CLOUDFRIEND_ACTIONS` | *(every configured action)* | Comma-separated list, e.g. `slack,webhook`. |
| `CLOUDFRIEND_RETENTION` | `7d` | How long events are kept. Flags are kept until deleted. |
| `CLOUDFRIEND_MAX_QUEUE` | `1000000` | Unparsed requests allowed before ingest replies `503`. |
| `CLOUDFRIEND_MAX_BODY_BYTES` | `1048576` | Larger bodies get `413`. |
| `CLOUDFRIEND_COMMIT_WINDOW` | `2ms` | How long intake collects requests before one commit. |
| `CLOUDFRIEND_ADAPTER_DIR` | *(unset)* | Directory of extra adapters to load without rebuilding the image. |
| `CLOUDFRIEND_LOG` | `info` | `debug`, `info`, `warn`, `error` or `silent`. |
| `CLOUDFRIEND_DECIDER` | `jev` | `jev`, `openrouter`, or your own adapter. |
| `JEV_API_KEY` | `OPENROUTER_API_KEY` | Key for Jev. Without any key the classifier decides alone. |
| `JEV_MODEL` | `typesafe/jev-router` | Any OpenRouter model id. |
| `OPENROUTER_API_KEY` | *(unset)* | Key for the `openrouter` decider, and Jev's fallback key. |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-5.5` | Model of the `openrouter` decider. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `CLOUDFRIEND_DECIDER_INSTRUCTIONS` | *(unset)* | Extra context for the model, e.g. "Checkout and billing matter most; ignore staging." |
| `CLOUDFRIEND_EVENT_CHARS` | `1500` | Most characters of each event shown to the model. |
| Triage and training | | See [Triage](./triage.md#configuration) and [Training](./training.md#configuration). |
| `SLACK_WEBHOOK_URL` | *(unset)* | Turns on the Slack action. |
| `SLACK_MIN_SEVERITY` | `low` | Only post flags at or above this severity. |
| `WEBHOOK_URL` | *(unset)* | Turns on the webhook action, which receives `POST {"flag": ..., "events": [...]}`. |
| `WEBHOOK_SECRET` | *(unset)* | Adds `x-cloudfriend-signature: sha256=<HMAC of body>`. |
| `SENTRY_CLIENT_SECRET` | *(unset)* | When set, the `Sentry-Hook-Signature` header is required and checked. |

## Running it in production

- **Back up Postgres.** Everything but model files is there: `docker compose exec postgres pg_dump -U cloudfriend cloudfriend > cloudfriend.sql`. A `202` is as durable as the server's commits (`fsync` and `synchronous_commit` on, the defaults).
- **Keep the volumes.** The Compose file keeps the database in the `postgres` volume and promoted models in `models` (mounted at `/data`). `docker compose down` keeps them; `down -v` deletes them. The image runs as the `node` user (uid 1000), so a bind-mounted `/data` must be writable by that user.
- **Upgrade** with `git pull && docker compose up -d --build`, or `docker compose pull && docker compose up -d` for the published image. Migrations run at boot.
- **One process does a lot.** The all-in-one service handles intake and processing. To run them apart, set `CLOUDFRIEND_ROLE=web` and `COMPOSE_PROFILES=split` in `.env`: the `cloudfriend` service then serves HTTP and intake, and `worker` services (`docker compose up -d --scale worker=N`) process events. Each workspace is processed by one worker at a time, under a lease; when a worker dies, another takes its workspaces over once the lease runs out (`CLOUDFRIEND_LEASE_TTL`, 30 s).
- **Stop with `docker compose stop`, not `kill`.** On `SIGTERM` cloudfriend stops taking requests, gives in-flight work a few seconds to finish, and exits. A hard kill loses nothing that was acknowledged, but in-flight model calls are repeated after restart, and processing waits for the lease to run out. `docker compose restart` stops Postgres at the same moment as the app, which has the same effect; `docker compose restart cloudfriend` does not.
- **Watch `/healthz`.** A `queued` count that keeps growing means the worker is falling behind intake.

## Running from source

cloudfriend needs Node 22.18 or later and a Postgres database.

```bash
npm install
CLOUDFRIEND_DATABASE_URL=postgres://localhost/cloudfriend npm run dev   # restarts on change
npm test             # unit and end-to-end tests with a mock model and Slack
npm run test:docker  # builds the image and tests it in Docker
```

`npm test` needs no Docker: it uses `TEST_DATABASE_URL` if set, and otherwise starts a throwaway Postgres from the local binaries (`initdb`, `pg_ctl`) and gives every test a fresh database.
