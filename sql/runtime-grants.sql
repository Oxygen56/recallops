SET DATABASE = recallops;

-- ccloud creates SQL users as admin members. Remove that broad membership first.
REVOKE admin FROM recallops_runtime;
ALTER USER recallops_runtime NOCREATEDB NOCREATEROLE NOCREATELOGIN NOMODIFYCLUSTERSETTING;

-- The database is dedicated to RecallOps, so remove inherited object-creation paths.
REVOKE CONNECT, TEMPORARY ON DATABASE recallops FROM public;
REVOKE CREATE ON SCHEMA public FROM public;

REVOKE ALL ON DATABASE recallops FROM recallops_runtime;
REVOKE ALL ON SCHEMA public FROM recallops_runtime;
REVOKE ALL ON TABLE
  tenants,
  incidents,
  memory_records,
  action_proposals,
  memory_events,
  evidence_outbox,
  demo_request_quotas,
  evaluation_leases
FROM recallops_runtime;

GRANT CONNECT ON DATABASE recallops TO recallops_runtime;
GRANT USAGE ON SCHEMA public TO recallops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  tenants,
  incidents,
  memory_records,
  action_proposals,
  memory_events,
  evidence_outbox,
  demo_request_quotas,
  evaluation_leases
TO recallops_runtime;
