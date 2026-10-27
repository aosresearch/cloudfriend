---
title: Architecture
---

# Architecture

cloudfriend is one or more Node.js processes and one Postgres database. Events move through three steps, and each step writes its result to the database before the next one starts:

1. **[Intake](./architecture/intake.md)** stores each request's raw bytes and replies `202`.
2. **[Process](./architecture/process.md)** parses stored requests into events and scores each one with the classifier. It then sends batches of the events that pass to a decider (Jev), which returns flags. See [Triage](./triage.md).
3. **[Delivery](./architecture/delivery.md)** sends each flag to every destination of its workspace (Slack, webhook, your own action), retrying until it works.

Intake runs in the HTTP request. Process and delivery run in a background worker loop. By default one process does both; `CLOUDFRIEND_ROLE` splits them (see [Processes and workspaces](#processes-and-workspaces)).

```mermaid
flowchart TB
  senders(["Sentry<br/>PostHog<br/>any JSON"]) -->|"POST /in/:source"| intake
  intake["Intake<br/>check secret,<br/>group commit"] -->|queue| process
  process["Process<br/>parse, then decide<br/>in batches"] -->|"flags +<br/>deliveries"| delivery
  delivery["Delivery<br/>run actions,<br/>retry on failure"] --> outputs(["Slack<br/>webhook<br/>your action"])
  process <-.->|"batch of events"| model(["OpenRouter<br/>model"])
```

Square boxes are cloudfriend's steps and rounded boxes are outside systems. Each arrow between steps is a table in Postgres: a step hands work to the next by writing a row.

## Why it is built this way

**An acknowledged event is never lost.** cloudfriend replies `202` only after the request is committed. Every later step reads its input from a table and writes its output in one transaction, so a crash or restart at any moment leaves each event either before or after a step, never halfway. No transaction stays open across a network call (the model, an action), so a slow call never holds a lock. On startup the worker simply continues with whatever is pending.

**The request path does almost nothing.** Intake does not parse JSON or call the model. It checks the secret, appends bytes, and waits for a commit that it shares with every other request in the same ~2 ms. Slow parts (parsing, the model, Slack) cannot slow down senders.

**Batches, not single events.** The model sees up to 100 events at once. It can see that 40 errors share one cause and raise one flag for them, and one model call per batch keeps cost flat when traffic spikes.

**Everything pluggable is a file.** Sources, deciders and actions are adapters: one TypeScript file each, named after the file. You can add or replace them without rebuilding the image by mounting a directory and setting `CLOUDFRIEND_ADAPTER_DIR`.

## The data model

All state lives in Postgres, at `CLOUDFRIEND_DATABASE_URL` (or `DATABASE_URL`). Only trained model files are written to disk, under `CLOUDFRIEND_DATA_DIR/models`.

The schema is versioned SQL in `src/migrations/` (`001_init.sql`, ...). At boot, cloudfriend applies the ones not yet applied, in one transaction under a Postgres advisory lock, and records them in `schema_migrations`. When several processes start at once, one migrates and the others wait for it. Times are stored as epoch milliseconds (`bigint`), and generated ids as `bigint` identities.

Every data table has a `workspace_id` column that references `workspaces`. The workspace `ws_default` is created at boot; ingest secrets belong to a workspace, and a request's rows go to its secret's workspace.

| Table | One row per | Written by | Read by |
| --- | --- | --- | --- |
| `queue` | HTTP request, raw bytes | intake | parse |
| `events` | event, as parsed JSON plus hints | parse | decide, the API |
| `flags` | thing the decider flagged | decide | delivery, the API |
| `deliveries` | (flag, destination) pair | decide | delivery |
| `destinations` | place a workspace's flags go: an action adapter (`kind`) and its `config` | API, boot (from env vars) | decide, delivery |
| `labels` | training example: Jev's or a person's verdict, with the event's features | decide, feedback API | training |
| `models` | classifier training run and its report | training | the API |
| `decisions` | decider call that produced labels: its prompt and raw reply | decide | the API |
| `snapshots` | workspace's featurizer template history | the workspace's owner, every minute and on release | its next owner |
| `leases` | workspace: which worker runs its parse and decide, and the lease `epoch` | worker | worker |
| `usage` | (workspace, UTC day): accepted requests, decider calls and spend | intake, decide | budget, the API |
| `secrets` | ingest secret, SHA-256 hash only | API, CLI | intake |
| `workspaces` | workspace, its `settings` and `backlog` (requests not yet parsed) | boot, the API; intake and parse keep `backlog` | every table, by `workspace_id` |

A row's status column is what moves it from step to step:

| Step | Picks up | Leaves behind |
| --- | --- | --- |
| Parse | `queue.status = 'new'` | `queue.status = 'done'` (or `'failed'`), new `events` rows with `decided = false` |
| Decide | `events.decided = false` | `events.decided = true` with `judgment`, `flag_id` and `decision_id`, new `flags` rows, one `deliveries` row per destination with `status = 'pending'` |
| Deliver | `deliveries.status = 'pending'` that are due | `deliveries.status = 'ok'`, or a later retry time, or `'failed'` after 15 attempts |

These status columns are the queues; there is no separate job system. Rows that more than one worker could take are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`: the queue rows a parse pass reads, and the deliveries a delivery pass runs (see [Delivery](./architecture/delivery.md)).

## Processes and workspaces

`CLOUDFRIEND_ROLE` picks what a process runs: `all` (the default) runs HTTP and the worker, `web` runs HTTP and intake only, and `worker` runs the worker and serves only `/healthz`. Any number of each can share one database.

Parse and decide keep state in memory per workspace: the featurizer's history and the routing state (verdict cache, earned suppression, escalation memory). So each workspace's parse and decide run in one worker at a time, the one holding its row in `leases`:

- A worker with room (`CLOUDFRIEND_MAX_WORKSPACES_PER_WORKER`, 200) claims workspaces that have unparsed requests or undecided events and no live lease. A claim adds 1 to the lease's `epoch`. On claim, the worker loads the workspace's featurizer history from `snapshots` and rebuilds its routing from `labels`. The classifier is shared by all workspaces.
- The owner renews its leases every `CLOUDFRIEND_LEASE_RENEW` (10 s); a lease runs out `CLOUDFRIEND_LEASE_TTL` (30 s) after the last renewal. Times are the database's clock.
- Every parse, decide and snapshot transaction first locks its workspace's lease row (`FOR SHARE`) and checks that the owner and epoch are still its own. A claim has to wait for that transaction to end, and once another worker has claimed, the old owner's writes fail and roll back. A decider answer that arrives after a takeover is discarded; the new owner asks again.
- On shutdown, and after `CLOUDFRIEND_IDLE_UNLOAD` (10 minutes) without work, a worker saves the workspace's history and releases its lease, so another worker can claim it at once. After a crash, the lease runs out and another worker takes over.

Delivery and retention cleanup are not tied to leases: any worker runs them.

People's feedback is written as labels by whichever process serves the API. The owner of the workspace reads new labels every 2 seconds and applies them to routing.

## Retention

A cleanup job runs every minute, in one worker at a time. It deletes processed `queue` rows and decided `events` older than `CLOUDFRIEND_RETENTION` (7 days by default), 1000 rows at a time so it never holds the database for long. Events the decider has not seen yet are never deleted. Flags are kept until you delete them with `DELETE /flags/:id`.

## Adapters

| Kind | Interface | Built in |
| --- | --- | --- |
| Source | `verify?(req)` and `parse(body) → events[]` | `json` (the fallback), `sentry`, `posthog` |
| Decider | `decide(events[]) → flags[]` | `jev`, `openrouter` |
| Action | `enabled?(env)` and `run(flag, { events })` | `slack`, `webhook` |

Built-in adapters live in `src/adapters/{sources,deciders,actions}/`, and the interfaces are in `src/types.ts`. A file in `CLOUDFRIEND_ADAPTER_DIR` with the same name replaces a built-in one. Each step's page shows how its adapter is called.

## Shutdown

On `SIGTERM` (what `docker stop` sends), cloudfriend:

1. stops accepting HTTP requests,
2. stops the worker from starting new work,
3. waits up to 4 seconds for model calls and deliveries already running,
4. aborts whatever is still running, hands back the claims of interrupted deliveries, commits any requests still waiting for intake, saves each workspace's featurizer history and releases its lease, closes the database connections, and exits `0`.

Aborted work is not lost. Its events and deliveries are still pending in the database and are picked up again on the next start.
