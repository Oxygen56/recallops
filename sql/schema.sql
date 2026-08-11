CREATE DATABASE IF NOT EXISTS recallops;
SET DATABASE = recallops;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id STRING PRIMARY KEY,
  display_name STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  tenant_id STRING NOT NULL,
  incident_id UUID NOT NULL DEFAULT gen_random_uuid(),
  supplier STRING NOT NULL,
  shipment_ref STRING NOT NULL,
  category STRING NOT NULL,
  severity INT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  summary STRING NOT NULL,
  status STRING NOT NULL DEFAULT 'investigating',
  session_id STRING NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, incident_id)
);

CREATE INDEX IF NOT EXISTS incidents_recent_idx
  ON incidents (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_records (
  tenant_id STRING NOT NULL,
  memory_id UUID NOT NULL DEFAULT gen_random_uuid(),
  incident_id UUID,
  kind STRING NOT NULL,
  content STRING NOT NULL,
  embedding VECTOR(64) NOT NULL,
  provenance JSONB NOT NULL,
  status STRING NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id)
) WITH (ttl_expiration_expression = 'expires_at');

CREATE VECTOR INDEX IF NOT EXISTS memory_semantic_idx
  ON memory_records (tenant_id, embedding);

CREATE INDEX IF NOT EXISTS memory_lifecycle_idx
  ON memory_records (tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS action_proposals (
  tenant_id STRING NOT NULL,
  action_id UUID NOT NULL DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL,
  action_type STRING NOT NULL,
  title STRING NOT NULL,
  rationale STRING NOT NULL,
  risk STRING NOT NULL,
  position INT NOT NULL DEFAULT 0,
  reversible BOOL NOT NULL DEFAULT true,
  state STRING NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed', 'approved', 'executed', 'compensated', 'rejected')),
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_id),
  INDEX (tenant_id, incident_id)
);

ALTER TABLE action_proposals
  ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS memory_events (
  tenant_id STRING NOT NULL,
  event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  aggregate_type STRING NOT NULL,
  version INT NOT NULL,
  event_type STRING NOT NULL,
  payload JSONB NOT NULL,
  actor STRING NOT NULL,
  session_id STRING NOT NULL,
  idempotency_key STRING NOT NULL,
  previous_hash STRING NOT NULL,
  event_hash STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS memory_events_timeline_idx
  ON memory_events (tenant_id, aggregate_id, version);

CREATE TABLE IF NOT EXISTS evidence_outbox (
  tenant_id STRING NOT NULL,
  outbox_id UUID NOT NULL DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  event_id UUID NOT NULL,
  receipt_key STRING NOT NULL,
  payload JSONB NOT NULL,
  state STRING NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error STRING,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, receipt_key)
) WITH (ttl_expiration_expression = 'expires_at');

CREATE INDEX IF NOT EXISTS evidence_outbox_pending_idx
  ON evidence_outbox (tenant_id, state, created_at);

UPSERT INTO tenants (tenant_id, display_name)
VALUES ('demo-logistics', 'Northstar Demo Logistics');
