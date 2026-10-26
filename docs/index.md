---
title: Setup
---

# Setup

Sieve is a live event triage pipeline in one Docker container. Your systems send it events (Sentry issues, PostHog events, logs, anything JSON). A model reads them in batches and flags the ones a person should look at. Each flag goes to Slack, a webhook, or your own action.

This page gets you from nothing to a flag in Slack, and explains what each step does. For how it works inside, see [Architecture](./architecture.md).

## What you need

- **Docker**, on any machine that can receive HTTP from the services that will send events.
- **An OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)). Sieve uses it to ask a model which events matter. Without it, events are stored but nothing gets flagged.
- **A Slack incoming webhook URL** ([api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)), or any HTTP endpoint that should receive flags.

There is no database to set up. Everything lives in one SQLite file inside the container's `/data` volume.

## 1. Build the image

From a checkout of the repository:

```bash
docker build -t sieve .
```

The image is about Node 22 plus two small dependencies. It runs TypeScript directly, so there is no compile step.

## 2. Run it

```bash
docker run -d --name sieve \
  -p 8080:8080 \
  -v sieve-data:/data \
  -e SIEVE_ADMIN_KEY=change-me \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  sieve
```

What each line does:

| Flag | Why |
| --- | --- |
| `-p 8080:8080` | Sieve listens on port 8080 for events and API calls. |
| `-v sieve-data:/data` | Keeps the database on a named volume, so events, flags and secrets survive a replaced container. Without it, data lives only as long as the container. |
| `SIEVE_ADMIN_KEY` | Turns on the admin API (`/secrets`, `/flags`, `/events`). Pick a long random value. It can never be used to send events. |
| `OPENROUTER_API_KEY` | Turns on the default decider, which sends batches of events to a model. |
| `SLACK_WEBHOOK_URL` | Turns on the Slack action. Every flag is posted to this channel. |

Check that it is up:

```bash
curl localhost:8080/healthz
# {"ok":true,"queued":0}
```

The container also has a Docker `HEALTHCHECK`, so `docker ps` shows `healthy` once it is ready.

## 3. Get the ingest secret

Sending events needs an **ingest secret**, which is separate from the admin key. On first boot Sieve creates one named `default` and prints it once:

```bash
docker logs sieve
```

```
========================================================================
First boot: created an ingest secret named 'default'. It is shown only once:

  sieve_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Send events:  curl -X POST http://localhost:8080/in/<source> \
                -H 'Authorization: Bearer <secret>' -d '{"message":"hello"}'
========================================================================
```

Only a SHA-256 hash is stored, so the plain secret cannot be shown again. If you lose it, create a new one (see [Managing secrets](#managing-secrets)).

## 4. Send a test event

```bash
curl -X POST localhost:8080/in/myapp \
  -H "Authorization: Bearer sieve_..." \
  -d '{"level":"error","message":"payment provider timeout","route":"/checkout"}'
# accepted
```

The `202 accepted` reply means the event is on disk. The `myapp` part of the URL becomes the event's `source`, and it can be any name.

Within about 10 seconds the batch goes to the model. A checkout error like this one is usually flagged, so a message should appear in Slack. Routine events, such as an info log, are not.

To see what happened without Slack:

```bash
curl -H "Authorization: Bearer change-me" "localhost:8080/events?since=10m"
curl -H "Authorization: Bearer change-me" "localhost:8080/flags"
```

## 5. Connect your sources

Each source sends to `POST /in/<source>`. A source name with a built-in adapter (`sentry`, `posthog`) gets its payload understood: ids, event types and grouping hints are pulled out. Any other name stores the JSON as is.

For a real source, create a secret limited to it, so a leaked secret can only send to that one source:

```bash
docker exec sieve sieve secrets create sentry-prod --source sentry
```

### Sentry

1. Create a secret: `docker exec sieve sieve secrets create sentry-prod --source sentry`.
2. In Sentry, go to **Settings → Developer Settings → Custom Integrations → New Internal Integration**.
3. Set the webhook URL to `https://<your-host>/in/sentry?secret=<secret>`. Sentry cannot send custom headers, so the secret goes in the query string.
4. Turn on **Alert Rule Action** and subscribe to the **issue** and **error** webhooks you want.
5. Optional: set `SENTRY_CLIENT_SECRET` to the integration's client secret. Sieve then also checks the `Sentry-Hook-Signature` header on every request.

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

Sieve speaks plain HTTP. Sentry, PostHog and most SaaS webhooks require an `https://` URL, so run Sieve behind something that terminates TLS: a load balancer, Caddy, nginx, Cloudflare Tunnel, or your platform's ingress. Forward everything to port 8080.

## Managing secrets

The CLI inside the container talks to the database directly and needs no admin key:

```bash
docker exec sieve sieve secrets create <name> [--source <source>]
docker exec sieve sieve secrets list
docker exec sieve sieve secrets revoke <id>
```

The same operations are available over HTTP with the admin key: `POST /secrets`, `GET /secrets`, `DELETE /secrets/:id`.

To rotate a secret, create a new one, update the sender, then revoke the old one. Revoking takes effect immediately.

## Configuration

Everything is set through environment variables. Durations accept `ms`, `s`, `m`, `h` and `d`.

| Variable | Default | What it does |
| --- | --- | --- |
| `SIEVE_ADMIN_KEY` | *(unset)* | Key for the admin API. The admin API is off until this is set. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `SIEVE_DATA_DIR` | `/data` | Where `sieve.db` lives. |
| `SIEVE_BATCH_SIZE` | `100` | Events per decider call. |
| `SIEVE_BATCH_WAIT` | `10s` | Longest an event waits for its batch to fill. |
| `SIEVE_DECIDER` | `openrouter` | Which decider adapter to use. |
| `SIEVE_DECIDER_CONCURRENCY` | `2` | Decider calls in flight at once. |
| `SIEVE_ACTIONS` | *(every configured action)* | Comma-separated list, e.g. `slack,webhook`. |
| `SIEVE_RETENTION` | `7d` | How long events are kept. Flags are kept until deleted. |
| `SIEVE_MAX_QUEUE` | `1000000` | Unparsed requests allowed before ingest replies `503`. |
| `SIEVE_MAX_BODY_BYTES` | `1048576` | Larger bodies get `413`. |
| `SIEVE_SYNCHRONOUS` | `FULL` | `FULL` survives power loss. `NORMAL` survives a process crash and is faster. |
| `SIEVE_COMMIT_WINDOW` | `2ms` | How long intake collects requests before one commit. |
| `SIEVE_ADAPTER_DIR` | *(unset)* | Directory of extra adapters to load without rebuilding the image. |
| `SIEVE_LOG` | `info` | `debug`, `info`, `warn`, `error` or `silent`. |
| `OPENROUTER_API_KEY` | *(unset)* | Required for the default decider. |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-5.5` | Any OpenRouter model id. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `SIEVE_DECIDER_INSTRUCTIONS` | *(unset)* | Extra context for the model, e.g. "Checkout and billing matter most; ignore staging." |
| `SIEVE_EVENT_CHARS` | `1500` | Most characters of each event shown to the model. |
| `SLACK_WEBHOOK_URL` | *(unset)* | Turns on the Slack action. |
| `SLACK_MIN_SEVERITY` | `low` | Only post flags at or above this severity. |
| `WEBHOOK_URL` | *(unset)* | Turns on the webhook action, which receives `POST {"flag": ..., "events": [...]}`. |
| `WEBHOOK_SECRET` | *(unset)* | Adds `x-sieve-signature: sha256=<HMAC of body>`. |
| `SENTRY_CLIENT_SECRET` | *(unset)* | When set, the `Sentry-Hook-Signature` header is required and checked. |

## Running it in production

- **Mount a volume at `/data`.** The image runs as the `node` user (uid 1000), so a bind-mounted directory must be writable by that user.
- **Run one container per database.** SQLite has one writer. Sieve is built to do a lot with one process rather than to scale out.
- **Use `docker stop`, not `docker kill`.** On `SIGTERM` Sieve stops taking requests, gives in-flight work a few seconds to finish, and exits. A hard kill loses nothing that was acknowledged, but in-flight model calls are repeated after restart.
- **Watch `/healthz`.** A `queued` count that keeps growing means the worker is falling behind intake.

## Running from source

Sieve needs Node 22.18 or later.

```bash
npm install
npm run dev          # ./data/sieve.db, restarts on change
npm test             # unit and end-to-end tests with a mock model and Slack
npm run test:docker  # builds the image and tests it in Docker
```
