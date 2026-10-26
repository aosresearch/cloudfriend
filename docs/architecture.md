---
title: Architecture
---

# Architecture

cloudfriend is one Node.js process and one SQLite file. Events move through three steps, and each step writes its result to the database before the next one starts:

1. **[Intake](./architecture/intake.md)** stores each request's raw bytes and replies `202`.
2. **[Process](./architecture/process.md)** parses stored requests into events, then sends batches of events to a decider, which returns flags.
3. **[Delivery](./architecture/delivery.md)** runs every enabled action (Slack, webhook, your own) for each flag, retrying until it works.

Intake runs in the HTTP request. Process and delivery run in a background worker loop in the same process.

```mermaid
flowchart TB
  senders(["Sentry<br/>PostHog<br/>any JSON"]) -->|"POST /in/:source"| intake
  intake["Intake<br/>check secret,<br/>group commit"] -->|queue| process
  process["Process<br/>parse, then decide<br/>in batches"] -->|"flags +<br/>deliveries"| delivery
  delivery["Delivery<br/>run actions,<br/>retry on failure"] --> outputs(["Slack<br/>webhook<br/>your action"])
  process <-.->|"batch of events"| model(["OpenRouter<br/>model"])
```

Square boxes are cloudfriend's steps and rounded boxes are outside systems. Each arrow between steps is a table in the one SQLite file: a step hands work to the next by writing a row.

## Why it is built this way

**An acknowledged event is never lost.** cloudfriend replies `202` only after the request is committed to disk. Every later step reads its input from a table and writes its output in one transaction, so a crash or restart at any moment leaves each event either before or after a step, never halfway. On startup the worker simply continues with whatever is pending.

**The request path does almost nothing.** Intake does not parse JSON or call the model. It checks the secret, appends bytes, and waits for a commit that it shares with every other request in the same ~2 ms. Slow parts (parsing, the model, Slack) cannot slow down senders.

**Batches, not single events.** The model sees up to 100 events at once. It can see that 40 errors share one cause and raise one flag for them, and one model call per batch keeps cost flat when traffic spikes.

**Everything pluggable is a file.** Sources, deciders and actions are adapters: one TypeScript file each, named after the file. You can add or replace them without rebuilding the image by mounting a directory and setting `CLOUDFRIEND_ADAPTER_DIR`.

## The data model

All state lives in `cloudfriend.db` under `/data`, in WAL mode.

| Table | One row per | Written by | Read by |
| --- | --- | --- | --- |
| `queue` | HTTP request, raw bytes | intake | parse |
| `events` | event, as parsed JSON plus hints | parse | decide, the API |
| `flags` | thing the decider flagged | decide | delivery, the API |
| `deliveries` | (flag, action) pair | decide | delivery |
| `secrets` | ingest secret, SHA-256 hash only | API, CLI | intake |

A row's status column is what moves it from step to step:

| Step | Picks up | Leaves behind |
| --- | --- | --- |
| Parse | `queue.status = 'new'` | `queue.status = 'done'` (or `'failed'`), new `events` rows with `decided = 0` |
| Decide | `events.decided = 0` | `events.decided = 1`, new `flags` rows, one `deliveries` row per action with `status = 'pending'` |
| Deliver | `deliveries.status = 'pending'` that are due | `deliveries.status = 'ok'`, or a later retry time, or `'failed'` after 15 attempts |

## Retention

A cleanup job runs every minute. It deletes processed `queue` rows and decided `events` older than `CLOUDFRIEND_RETENTION` (7 days by default), 1000 rows at a time so it never holds the database for long. Events the decider has not seen yet are never deleted. Flags are kept until you delete them with `DELETE /flags/:id`.

## Adapters

| Kind | Interface | Built in |
| --- | --- | --- |
| Source | `verify?(req)` and `parse(body) → events[]` | `json` (the fallback), `sentry`, `posthog` |
| Decider | `decide(events[]) → flags[]` | `openrouter` |
| Action | `enabled?(env)` and `run(flag, { events })` | `slack`, `webhook` |

Built-in adapters live in `src/adapters/{sources,deciders,actions}/`, and the interfaces are in `src/types.ts`. A file in `CLOUDFRIEND_ADAPTER_DIR` with the same name replaces a built-in one. Each step's page shows how its adapter is called.

## Shutdown

On `SIGTERM` (what `docker stop` sends), cloudfriend:

1. stops accepting HTTP requests,
2. stops the worker from starting new work,
3. waits up to 4 seconds for model calls and deliveries already running,
4. aborts whatever is still running, commits any requests still waiting for intake, closes the database, and exits `0`.

Aborted work is not lost. Its events and deliveries are still pending in the database and are picked up again on the next start.
