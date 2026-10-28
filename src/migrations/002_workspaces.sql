-- Multi-workspace release: people and sign-in, sources and destinations as workspace settings,
-- one leased owner per workspace for the sorter, and per-workspace usage for limits and budgets.
-- Pipeline times stay epoch milliseconds in bigint (001); the auth tables use timestamptz, as
-- src/auth/ reads and writes Date values.

-- People ------------------------------------------------------------------------------------

CREATE TABLE users (
  id            text PRIMARY KEY,
  -- Stored lowercased by the app; the check keeps the unique constraint case-insensitive.
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text,
  -- 'scrypt$<logN>$<r>$<p>$<salt>$<hash>', or NULL for users who only sign in with OIDC.
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- OIDC identities. Users are matched by (issuer, subject), never by email.
CREATE TABLE user_identities (
  issuer     text NOT NULL,
  subject    text NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX user_identities_user_id ON user_identities (user_id);

-- Only the SHA-256 (hex) of the cookie token is stored.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_id ON workspace_members (user_id);

-- Workspace settings and counters ------------------------------------------------------------

-- settings: per-workspace overrides, e.g. {"jev_budget_usd": 5, "decider_instructions": "..."}.
-- backlog: queue rows with status 'new', kept by intake (+ per flush) and parse (- per chunk),
-- so admission control works when web and worker run in different processes.
ALTER TABLE workspaces
  ADD COLUMN settings jsonb  NOT NULL DEFAULT '{}',
  ADD COLUMN backlog  bigint NOT NULL DEFAULT 0;

-- Where events come from. kind picks the source adapter (json, sentry, posthog, or a custom one
-- when self-hosted). Events are POSTed to /in/<id>.
CREATE TABLE sources (
  id           text   PRIMARY KEY,
  workspace_id text   NOT NULL REFERENCES workspaces(id),
  name         text   NOT NULL,
  kind         text   NOT NULL,
  created_at   bigint NOT NULL,
  revoked_at   bigint
);
CREATE INDEX sources_workspace ON sources (workspace_id, created_at);

-- A secret now belongs to a source (source_id), or is a legacy secret (source_id NULL, scoped by
-- the old `source` name or not at all). expires_at: set on the old secret when a source's secret
-- is rotated, so senders have a grace period.
ALTER TABLE secrets
  ADD COLUMN source_id  text REFERENCES sources(id),
  ADD COLUMN expires_at bigint;
CREATE INDEX secrets_source ON secrets (source_id) WHERE source_id IS NOT NULL;

-- The adapter that parses a queue row, fixed at intake from the source's kind. NULL for legacy
-- rows, which use the adapter named like their source (as in 001).
ALTER TABLE queue ADD COLUMN adapter text;

-- Where alerts go. kind names the action adapter (slack, webhook, or a custom one when
-- self-hosted); config is what that adapter needs, e.g. {"url": "...", "signing_secret": "..."}.
-- Deleted destinations are kept (deleted_at) so delivery history can still name them.
CREATE TABLE destinations (
  id               text   PRIMARY KEY,
  workspace_id     text   NOT NULL REFERENCES workspaces(id),
  name             text   NOT NULL,
  kind             text   NOT NULL,
  config           jsonb  NOT NULL DEFAULT '{}',
  created_at       bigint NOT NULL,
  deleted_at       bigint,
  last_delivery_at bigint,
  last_error       text
);
CREATE INDEX destinations_workspace ON destinations (workspace_id) WHERE deleted_at IS NULL;

-- deliveries.action now holds a destination id (dst_...). Rows from 001 keep their adapter name.

-- What Jev decided about each event, for the dashboard: its judgment (relevant | benign |
-- uncertain), the flag the event joined, and the decider call that judged it.
ALTER TABLE events
  ADD COLUMN judgment    text,
  ADD COLUMN flag_id     text,
  ADD COLUMN decision_id text;

-- Decider call cost as OpenRouter reported it, when it did.
ALTER TABLE decisions ADD COLUMN cost_usd double precision;

-- Sorter ownership ---------------------------------------------------------------------------

-- One owner per workspace. A worker claims a workspace by taking an expired (or missing) lease,
-- which increments epoch; every sorter write is fenced on (workspace_id, epoch).
CREATE TABLE leases (
  workspace_id text   PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  owner        text   NOT NULL,
  epoch        bigint NOT NULL,
  expires_at   bigint NOT NULL
);

-- Usage per workspace and UTC day: what the dashboard shows and what limits and budgets check.
CREATE TABLE usage (
  workspace_id  text   NOT NULL REFERENCES workspaces(id),
  day           text   NOT NULL,
  events        bigint NOT NULL DEFAULT 0,
  jev_calls     integer NOT NULL DEFAULT 0,
  jev_spend_usd double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
