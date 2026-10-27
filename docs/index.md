---
title: Setup
---

# Setup

cloudfriend is a live event triage pipeline in one Docker container. Your systems send it events: Sentry issues, PostHog events, logs, anything JSON. A fast classifier scores every event, and a stronger model, Jev, judges the few that might matter. Jev flags the ones a person should look at, and each flag goes to the escalation queue, to Slack, to a webhook, or to your own action. Jev's verdicts and your feedback retrain the classifier, so less of the stream needs Jev over time. See [Triage](./triage.md) and [Training](./training.md).

This page gets you from nothing to a flag in Slack, and explains what each step does. For how it works inside, see [Architecture](./architecture.md).

## What you need

- **Docker**, on any machine that can receive HTTP from the services that will send events.
- **An OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) for Jev. cloudfriend uses it to ask Jev about the events the classifier passes on. Without it, the classifier escalates on its own, with less judgment.
- **A Postgres database** (tested with Postgres 14) and a user that can create tables in it. cloudfriend creates its schema on first boot and migrates it on later ones.
- **A Slack incoming webhook URL** ([api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)), or any HTTP endpoint that should receive flags.

Everything lives in that one Postgres database. The container itself only writes trained model files, under `/data/models`.

## 1. Build the image

From a checkout of the repository:

```bash
docker build -t cloudfriend .
```

The image is about Node 22 plus three small dependencies (Hono, its Node server, and the `pg` Postgres driver). It runs TypeScript directly, so there is no compile step.

## 2. Run it

```bash
docker run -d --name cloudfriend \
  -p 8080:8080 \
  -v cloudfriend-models:/data \
  -e CLOUDFRIEND_DATABASE_URL=postgres://cloudfriend:secret@db.internal:5432/cloudfriend \
  -e CLOUDFRIEND_ADMIN_KEY=change-me \
  -e JEV_API_KEY=sk-or-... \
  -e SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  cloudfriend
```

What each line does:

| Flag | Why |
| --- | --- |
| `-p 8080:8080` | cloudfriend listens on port 8080 for events and API calls. |
| `-v cloudfriend-models:/data` | Keeps trained model files on a named volume, so a promoted model survives a replaced container. Without it, the built-in model is used until the next promotion. Events, flags and secrets are in Postgres either way. |
| `CLOUDFRIEND_DATABASE_URL` | The Postgres database cloudfriend stores everything in. `DATABASE_URL` works too. cloudfriend exits at boot if neither is set. |
| `CLOUDFRIEND_ADMIN_KEY` | Turns on the admin API (`/secrets`, `/flags`, `/events`). Pick a long random value. It can never be used to send events. |
| `JEV_API_KEY` | Turns on Jev, the default decider, for the events the classifier passes on. `OPENROUTER_API_KEY` works too. |
| `SLACK_WEBHOOK_URL` | Turns on the Slack action. Every flag is posted to this channel. |

Check that it is up:

```bash
curl localhost:8080/healthz
# {"ok":true,"queued":0}
```

The container also has a Docker `HEALTHCHECK`, so `docker ps` shows `healthy` once it is ready.

## 3. Get the ingest secret

Sending events needs an **ingest secret**, which is separate from the admin key. On first boot cloudfriend creates one named `default` and prints it once:

```bash
docker logs cloudfriend
```

```
========================================================================
First boot: created an ingest secret named 'default'. It is shown only once:

  cloudfriend_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Send events:  curl -X POST http://localhost:8080/in/<source> \
                -H 'Authorization: Bearer <secret>' -d '{"message":"hello"}'
========================================================================
```

Only a SHA-256 hash is stored, so the plain secret cannot be shown again. If you lose it, create a new one (see [Managing secrets](#managing-secrets)).

## 4. Send a test event

```bash
curl -X POST localhost:8080/in/myapp \
  -H "Authorization: Bearer cloudfriend_..." \
  -d '{"level":"error","message":"payment provider timeout","route":"/checkout"}'
# accepted
```

The `202 accepted` reply means the event is on disk. The `myapp` part of the URL becomes the event's `source`, and it can be any name.

The classifier scores the event at once. A checkout error like this one has a template it has never seen, so it goes to Jev within about 10 seconds, and Jev usually flags it. A message then appears in Slack, and the flag appears in `GET /queue`. Routine events, such as an info log, are dropped by the classifier and never reach Jev. `GET /events/:id` shows each event's `score` and `route`.

To see what happened without Slack:

```bash
curl -H "Authorization: Bearer change-me" "localhost:8080/events?since=10m"
curl -H "Authorization: Bearer change-me" "localhost:8080/flags"
```

## 5. Connect your sources

Each source sends to `POST /in/<source>`. A source name with a built-in adapter (`sentry`, `posthog`) gets its payload understood: ids, event types and grouping hints are pulled out. Any other name stores the JSON as is.

For a real source, create a secret limited to it, so a leaked secret can only send to that one source:

```bash
docker exec cloudfriend cloudfriend secrets create sentry-prod --source sentry
```

### Sentry

1. Create a secret: `docker exec cloudfriend cloudfriend secrets create sentry-prod --source sentry`.
2. In Sentry, go to **Settings → Developer Settings → Custom Integrations → New Internal Integration**.
3. Set the webhook URL to `https://<your-host>/in/sentry?secret=<secret>`. Sentry cannot send custom headers, so the secret goes in the query string.
4. Turn on **Alert Rule Action** and subscribe to the **issue** and **error** webhooks you want.
5. Optional: set `SENTRY_CLIENT_SECRET` to the integration's client secret. cloudfriend then also checks the `Sentry-Hook-Signature` header on every request.

The legacy **WebHooks** alert plugin works too, with the same URL.

### PostHog

Create an **HTTP Webhook** destination:

- URL: `https://<your-host>/in/posthog`
- Header: `Authorization: Bearer <secret>`

The default `{ event, person }` body works as is. Capture-style payloads and `{ "batch": [...] }` also work, and each item becomes one event.

### Anything else

`POST /in/<name>` accepts any body:

- a JSON object becomes one event
- a JSON array, or newline-delimited JSON, becomes one event per item
- plain text becomes `{ "raw": "..." }`

Senders that cannot set headers can pass the secret as `?secret=`.

## 6. Put it behind HTTPS

cloudfriend speaks plain HTTP. Sentry, PostHog and most SaaS webhooks require an `https://` URL, so run cloudfriend behind something that terminates TLS: a load balancer, Caddy, nginx, Cloudflare Tunnel, or your platform's ingress. Forward everything to port 8080.

## Managing secrets

The CLI inside the container talks to the database directly and needs no admin key:

```bash
docker exec cloudfriend cloudfriend secrets create <name> [--source <source>]
docker exec cloudfriend cloudfriend secrets list
docker exec cloudfriend cloudfriend secrets revoke <id>
```

The same operations are available over HTTP with the admin key: `POST /secrets`, `GET /secrets`, `DELETE /secrets/:id`.

To rotate a secret, create a new one, update the sender, then revoke the old one. Revoking takes effect immediately.

## Configuration

Everything is set through environment variables. Durations accept `ms`, `s`, `m`, `h` and `d`.

| Variable | Default | What it does |
| --- | --- | --- |
| `CLOUDFRIEND_ADMIN_KEY` | *(unset)* | Key for the admin API. The admin API is off until this is set. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `CLOUDFRIEND_DATABASE_URL` | *(required)* | Postgres connection string. `DATABASE_URL` is used if this is unset. |
| `CLOUDFRIEND_DB_POOL` | `10` | Connections to Postgres per process. |
| `CLOUDFRIEND_DATA_DIR` | `/data` | Where trained model files are written (`models/`). |
| `CLOUDFRIEND_BATCH_SIZE` | `100` | Events per decider call. |
| `CLOUDFRIEND_BATCH_WAIT` | `10s` | Longest an event waits for its batch to fill. |
| `CLOUDFRIEND_DECIDER` | `openrouter` | Which decider adapter to use. |
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

- **Back up Postgres.** Everything but model files is there. A `202` is as durable as the server's commits (`fsync` and `synchronous_commit` on, the defaults).
- **Mount a volume at `/data`** to keep promoted models. The image runs as the `node` user (uid 1000), so a bind-mounted directory must be writable by that user.
- **Run one container per database.** The worker keeps some state in memory (the featurizer's history, the verdict cache), so this release is built to do a lot with one process rather than to scale out.
- **Use `docker stop`, not `docker kill`.** On `SIGTERM` cloudfriend stops taking requests, gives in-flight work a few seconds to finish, and exits. A hard kill loses nothing that was acknowledged, but in-flight model calls are repeated after restart.
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
