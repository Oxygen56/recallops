import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { eventHash, requestHash } from "./hash.js";
import { vectorLiteral } from "./embedding.js";
import type {
  ActionProposal,
  DecisionBundle,
  DecisionDraft,
  EvidenceSummary,
  Incident,
  IncidentCommand,
  MemoryRecord,
  TimelineEvent,
} from "./types.js";

const ZERO_HASH = "0".repeat(64);
const MAX_TRANSACTION_ATTEMPTS = 5;

export class StaleRevisionError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`stale revision: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "StaleRevisionError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class QuotaExceededError extends Error {
  constructor(readonly scope: string, readonly limit: number) {
    super(`hourly demo quota exceeded for ${scope}`);
    this.name = "QuotaExceededError";
  }
}

export class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

interface OutboxRecord {
  tenantId: string;
  outboxId: string;
  receiptKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function incidentFromRow(row: QueryResultRow): Incident {
  return {
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    supplier: row.supplier,
    shipmentRef: row.shipment_ref,
    category: row.category,
    severity: Number(row.severity),
    summary: row.summary,
    status: row.status,
    sessionId: row.session_id,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function memoryFromRow(row: QueryResultRow): MemoryRecord {
  const distance = row.distance === undefined ? undefined : Number(row.distance);
  return {
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    incidentId: row.incident_id,
    kind: row.kind,
    content: row.content,
    provenance: row.provenance,
    status: row.status,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    revision: Number(row.revision),
    score: distance === undefined ? undefined : Number((1 - distance).toFixed(6)),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function actionFromRow(row: QueryResultRow): ActionProposal {
  return {
    tenantId: row.tenant_id,
    actionId: row.action_id,
    incidentId: row.incident_id,
    actionType: row.action_type,
    title: row.title,
    rationale: row.rationale,
    risk: row.risk,
    reversible: row.reversible,
    state: row.state,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function timelineFromRow(row: QueryResultRow): TimelineEvent {
  return {
    eventId: row.event_id,
    aggregateId: row.aggregate_id,
    version: Number(row.version),
    eventType: row.event_type,
    payload: row.payload,
    actor: row.actor,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: iso(row.created_at),
  };
}

export class CockroachRepository {
  readonly pool: Pool;

  constructor(databaseUrl: string, poolMax = Math.min(4, Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 2)))) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: "recallops-agent-api",
      max: poolMax,
      maxLifetimeSeconds: 300,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withSerializable<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = (error as { code?: string }).code;
        if (code === "40001" && attempt < MAX_TRANSACTION_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** (attempt - 1)));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("transaction retry budget exhausted");
  }

  async health(): Promise<{ databaseVersion: string; now: string }> {
    const result = await this.pool.query("SELECT version() AS version, now() AS now");
    return { databaseVersion: result.rows[0].version, now: iso(result.rows[0].now) };
  }

  async retrieveMemories(
    tenantId: string,
    embedding: number[],
    limit = 4,
  ): Promise<MemoryRecord[]> {
    let candidateLimit = Math.max(limit * 16, 64);
    const maximumCandidateLimit = 4096;
    while (true) {
      const result = await this.pool.query(
        `WITH candidates AS MATERIALIZED (
           SELECT tenant_id, memory_id, incident_id, kind, content, provenance, status,
                  expires_at, revision, created_at, updated_at,
                  embedding <=> $2::VECTOR AS distance
             FROM memory_records@memory_semantic_idx
            WHERE tenant_id = $1 AND status = 'active'
            ORDER BY embedding <=> $2::VECTOR
            LIMIT $3
         )
         SELECT *, count(*) OVER () AS unexpired_candidates
           FROM candidates
          WHERE expires_at IS NULL OR expires_at > now()
          ORDER BY distance
          LIMIT $4`,
        [tenantId, vectorLiteral(embedding), candidateLimit, limit],
      );
      const memories = result.rows.map(memoryFromRow);
      if (memories.length >= limit || candidateLimit >= maximumCandidateLimit) return memories;
      candidateLimit = Math.min(candidateLimit * 2, maximumCandidateLimit);
    }
  }

  async createIncident(
    command: IncidentCommand,
    idempotencyKey: string,
    embedding: number[],
    draft: DecisionDraft,
  ): Promise<DecisionBundle> {
    const commandFingerprint = requestHash(command);
    const replay = await this.loadByIdempotencyKey(
      command.tenantId,
      idempotencyKey,
      commandFingerprint,
    );
    if (replay) return replay;

    try {
      return await this.withSerializable(async (client) => {
        const duplicate = await this.loadByIdempotencyKey(
          command.tenantId,
          idempotencyKey,
          commandFingerprint,
          client,
        );
        if (duplicate) return duplicate;

        await client.query(
          `UPSERT INTO tenants (tenant_id, display_name)
           VALUES ($1, $2)`,
          [command.tenantId, command.tenantId === "demo-logistics" ? "Northstar Demo Logistics" : command.tenantId],
        );

        const incidentResult = await client.query(
          `INSERT INTO incidents
             (tenant_id, supplier, shipment_ref, category, severity, summary, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            command.tenantId,
            command.supplier,
            command.shipmentRef,
            command.category,
            command.severity,
            command.summary,
            command.sessionId,
          ],
        );
        const incident = incidentFromRow(incidentResult.rows[0]);

        const memoryResult = await client.query(
          `INSERT INTO memory_records
             (tenant_id, incident_id, kind, content, embedding, provenance, expires_at)
           VALUES ($1, $2, $3, $4, $5::VECTOR, $6::JSONB, $7)
           RETURNING *`,
          [
            command.tenantId,
            incident.incidentId,
            draft.memoryKind,
            draft.memoryContent,
            vectorLiteral(embedding),
            JSON.stringify(draft.provenance),
            draft.expiresAt,
          ],
        );
        const memory = memoryFromRow(memoryResult.rows[0]);

        const actions: ActionProposal[] = [];
        for (const [position, action] of draft.actions.entries()) {
          const actionResult = await client.query(
            `INSERT INTO action_proposals
               (tenant_id, incident_id, action_type, title, rationale, risk, position, reversible)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              command.tenantId,
              incident.incidentId,
              action.actionType,
              action.title,
              action.rationale,
              action.risk,
              position,
              action.reversible,
            ],
          );
          actions.push(actionFromRow(actionResult.rows[0]));
        }

        const payload = {
          incidentId: incident.incidentId,
          memoryId: memory.memoryId,
          actionIds: actions.map((action) => action.actionId),
          similarMemoryIds: draft.similarMemories.map((item) => item.memoryId),
          synopsis: draft.synopsis,
          embeddingProvider: draft.provenance.embeddingProvider,
          requestFingerprint: commandFingerprint,
        };
        const hash = eventHash({
          tenantId: command.tenantId,
          aggregateId: incident.incidentId,
          version: 1,
          eventType: "incident.created",
          payload,
          previousHash: ZERO_HASH,
          actor: command.actor,
          sessionId: command.sessionId,
          idempotencyKey,
        });
        const eventResult = await client.query(
          `INSERT INTO memory_events
             (tenant_id, aggregate_id, aggregate_type, version, event_type, payload,
              actor, session_id, idempotency_key, previous_hash, event_hash)
           VALUES ($1, $2, 'incident', 1, 'incident.created', $3::JSONB,
                   $4, $5, $6, $7, $8)
           RETURNING event_id`,
          [
            command.tenantId,
            incident.incidentId,
            JSON.stringify(payload),
            command.actor,
            command.sessionId,
            idempotencyKey,
            ZERO_HASH,
            hash,
          ],
        );
        const eventId = eventResult.rows[0].event_id;
        const receiptKey = `decisions/${command.tenantId}/${incident.incidentId}/v1.json`;
        await client.query(
          `INSERT INTO evidence_outbox
             (tenant_id, aggregate_id, event_id, receipt_key, payload)
           VALUES ($1, $2, $3, $4, $5::JSONB)`,
          [
            command.tenantId,
            incident.incidentId,
            eventId,
            receiptKey,
            JSON.stringify({
              schema: "recallops.decision-receipt.v1",
              incident,
              memory: { ...memory, score: undefined },
              actions,
              event: { id: eventId, hash, previousHash: ZERO_HASH },
            }),
          ],
        );

        return {
          incident,
          memory,
          actions,
          similarMemories: draft.similarMemories,
          idempotentReplay: false,
          receiptState: "pending",
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const reconciled = await this.loadByIdempotencyKey(
          command.tenantId,
          idempotencyKey,
          commandFingerprint,
        );
        if (reconciled) return reconciled;
      }
      throw error;
    }
  }

  async loadByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
    expectedRequestFingerprint: string,
    client: PoolClient | Pool = this.pool,
  ): Promise<DecisionBundle | null> {
    const eventResult = await client.query(
      `SELECT aggregate_id, payload
         FROM memory_events
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (eventResult.rowCount === 0) return null;
    const payload = eventResult.rows[0].payload as Record<string, unknown>;
    if (payload.requestFingerprint !== expectedRequestFingerprint) {
      throw new IdempotencyConflictError();
    }
    const aggregateId = eventResult.rows[0].aggregate_id;
    return this.loadBundle(tenantId, aggregateId, true, client, payload);
  }

  async replayIncident(command: IncidentCommand, idempotencyKey: string): Promise<DecisionBundle | null> {
    return this.loadByIdempotencyKey(command.tenantId, idempotencyKey, requestHash(command));
  }

  private async loadBundle(
    tenantId: string,
    incidentId: string,
    idempotentReplay: boolean,
    client: PoolClient | Pool = this.pool,
    eventPayload?: Record<string, unknown>,
  ): Promise<DecisionBundle> {
    const [incidentResult, memoryResult, actionResult, receiptResult] = await Promise.all([
      client.query("SELECT * FROM incidents WHERE tenant_id = $1 AND incident_id = $2", [tenantId, incidentId]),
      client.query(
        "SELECT * FROM memory_records WHERE tenant_id = $1 AND incident_id = $2 ORDER BY created_at LIMIT 1",
        [tenantId, incidentId],
      ),
      client.query(
        "SELECT * FROM action_proposals WHERE tenant_id = $1 AND incident_id = $2 ORDER BY position, action_id",
        [tenantId, incidentId],
      ),
      client.query(
        "SELECT state FROM evidence_outbox WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, incidentId],
      ),
    ]);
    if (incidentResult.rowCount === 0 || memoryResult.rowCount === 0) {
      throw new NotFoundError("incident bundle");
    }

    const similarIds = Array.isArray(eventPayload?.similarMemoryIds)
      ? (eventPayload?.similarMemoryIds as string[])
      : [];
    let similarMemories: MemoryRecord[] = [];
    if (similarIds.length > 0) {
      const similarResult = await client.query(
        `SELECT * FROM memory_records
          WHERE tenant_id = $1 AND memory_id = ANY($2::UUID[])`,
        [tenantId, similarIds],
      );
      similarMemories = similarResult.rows.map(memoryFromRow);
    }

    return {
      incident: incidentFromRow(incidentResult.rows[0]),
      memory: memoryFromRow(memoryResult.rows[0]),
      actions: actionResult.rows.map(actionFromRow),
      similarMemories,
      idempotentReplay,
      receiptState: receiptResult.rows[0]?.state ?? "pending",
    };
  }

  async getIncident(tenantId: string, incidentId: string): Promise<DecisionBundle> {
    const eventResult = await this.pool.query(
      `SELECT payload FROM memory_events
        WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'incident.created'
        ORDER BY version LIMIT 1`,
      [tenantId, incidentId],
    );
    return this.loadBundle(tenantId, incidentId, false, this.pool, eventResult.rows[0]?.payload);
  }

  async listIncidents(tenantId: string, limit = 20): Promise<Incident[]> {
    const result = await this.pool.query(
      `SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map(incidentFromRow);
  }

  private async appendIncidentEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      incidentId: string;
      eventType: string;
      payload: Record<string, unknown>;
      actor: string;
      sessionId: string;
      idempotencyKey: string;
    },
  ): Promise<{ eventId: string; version: number; hash: string; previousHash: string }> {
    const previous = await client.query(
      `SELECT version, event_hash FROM memory_events
        WHERE tenant_id = $1 AND aggregate_id = $2
        ORDER BY version DESC LIMIT 1`,
      [input.tenantId, input.incidentId],
    );
    const version = Number(previous.rows[0]?.version ?? 0) + 1;
    const previousHash = previous.rows[0]?.event_hash ?? ZERO_HASH;
    const hash = eventHash({
      tenantId: input.tenantId,
      aggregateId: input.incidentId,
      version,
      eventType: input.eventType,
      payload: input.payload,
      previousHash,
      actor: input.actor,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
    });
    const inserted = await client.query(
      `INSERT INTO memory_events
         (tenant_id, aggregate_id, aggregate_type, version, event_type, payload,
          actor, session_id, idempotency_key, previous_hash, event_hash)
       VALUES ($1, $2, 'incident', $3, $4, $5::JSONB, $6, $7, $8, $9, $10)
       RETURNING event_id`,
      [
        input.tenantId,
        input.incidentId,
        version,
        input.eventType,
        JSON.stringify(input.payload),
        input.actor,
        input.sessionId,
        input.idempotencyKey,
        previousHash,
        hash,
      ],
    );
    return { eventId: inserted.rows[0].event_id, version, hash, previousHash };
  }

  private async loadActionTransitionReplay(
    input: {
      tenantId: string;
      actionId: string;
      expectedRevision: number;
      targetState: "approved" | "compensated" | "rejected";
      actor: string;
      sessionId: string;
      idempotencyKey: string;
    },
    client: PoolClient | Pool = this.pool,
  ): Promise<ActionProposal | null> {
    const replay = await client.query(
      `SELECT event_type, payload FROM memory_events
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if (replay.rowCount === 0) return null;
    const eventType = replay.rows[0].event_type;
    const payload = replay.rows[0].payload as Record<string, unknown>;
    const fingerprint = requestHash({
      tenantId: input.tenantId,
      actionId: input.actionId,
      expectedRevision: input.expectedRevision,
      targetState: input.targetState,
      actor: input.actor,
      sessionId: input.sessionId,
    });
    if (
      eventType !== `action.${input.targetState}` ||
      payload.actionId !== input.actionId ||
      payload.toState !== input.targetState ||
      Number(payload.requestExpectedRevision ?? payload.revision) !== input.expectedRevision ||
      payload.requestFingerprint !== fingerprint
    ) {
      throw new IdempotencyConflictError();
    }
    if (payload.resultAction && typeof payload.resultAction === "object") {
      return payload.resultAction as ActionProposal;
    }
    const current = await client.query(
      "SELECT * FROM action_proposals WHERE tenant_id = $1 AND action_id = $2",
      [input.tenantId, input.actionId],
    );
    if (current.rowCount === 0) throw new NotFoundError("action");
    return {
      ...actionFromRow(current.rows[0]),
      state: input.targetState,
      revision: Number(payload.revision),
    };
  }

  async replayActionTransition(input: {
    tenantId: string;
    actionId: string;
    expectedRevision: number;
    targetState: "approved" | "compensated" | "rejected";
    actor: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<ActionProposal | null> {
    return this.loadActionTransitionReplay(input);
  }

  async transitionAction(input: {
    tenantId: string;
    actionId: string;
    expectedRevision: number;
    targetState: "approved" | "compensated" | "rejected";
    actor: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<ActionProposal> {
    const replay = await this.loadActionTransitionReplay(input);
    if (replay) return replay;

    try {
      return await this.withSerializable(async (client) => {
      const transactionReplay = await this.loadActionTransitionReplay(input, client);
      if (transactionReplay) return transactionReplay;
      const before = await client.query(
        "SELECT * FROM action_proposals WHERE tenant_id = $1 AND action_id = $2 FOR UPDATE",
        [input.tenantId, input.actionId],
      );
      if (before.rowCount === 0) throw new NotFoundError("action");
      const current = actionFromRow(before.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw new StaleRevisionError(input.expectedRevision, current.revision);
      }
      if (["approved", "rejected"].includes(input.targetState) && current.state !== "proposed") {
        throw new Error(`cannot ${input.targetState === "approved" ? "approve" : "reject"} action from state ${current.state}`);
      }
      if (input.targetState === "compensated" && !["approved", "executed"].includes(current.state)) {
        throw new Error(`cannot compensate action from state ${current.state}`);
      }

      const updated = await client.query(
        `UPDATE action_proposals
            SET state = $3, revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND action_id = $2 AND revision = $4
          RETURNING *`,
        [input.tenantId, input.actionId, input.targetState, input.expectedRevision],
      );
      if (updated.rowCount === 0) {
        const actual = await client.query(
          "SELECT revision FROM action_proposals WHERE tenant_id = $1 AND action_id = $2",
          [input.tenantId, input.actionId],
        );
        throw new StaleRevisionError(input.expectedRevision, Number(actual.rows[0]?.revision ?? -1));
      }
      const action = actionFromRow(updated.rows[0]);
      const payload = {
        actionId: action.actionId,
        actionType: action.actionType,
        fromState: current.state,
        toState: action.state,
        requestExpectedRevision: input.expectedRevision,
        revision: action.revision,
        resultAction: action,
        requestFingerprint: requestHash({
          tenantId: input.tenantId,
          actionId: input.actionId,
          expectedRevision: input.expectedRevision,
          targetState: input.targetState,
          actor: input.actor,
          sessionId: input.sessionId,
        }),
      };
      const event = await this.appendIncidentEvent(client, {
        tenantId: input.tenantId,
        incidentId: action.incidentId,
        eventType: `action.${input.targetState}`,
        payload,
        actor: input.actor,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
      });
      await client.query(
        `UPDATE incidents
            SET revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND incident_id = $2`,
        [input.tenantId, action.incidentId],
      );
      await client.query(
        `INSERT INTO evidence_outbox
           (tenant_id, aggregate_id, event_id, receipt_key, payload)
         VALUES ($1, $2, $3, $4, $5::JSONB)`,
        [
          input.tenantId,
          action.incidentId,
          event.eventId,
          `decisions/${input.tenantId}/${action.incidentId}/v${event.version}.json`,
          JSON.stringify({
            schema: "recallops.action-receipt.v1",
            action,
            event,
          }),
        ],
      );
      return action;
      });
    } catch (error) {
      const committedReplay = await this.loadActionTransitionReplay(input).catch((replayError) => {
        if (replayError instanceof IdempotencyConflictError) throw replayError;
        return null;
      });
      if (committedReplay) return committedReplay;
      throw error;
    }
  }

  async setMemoryStatus(input: {
    tenantId: string;
    memoryId: string;
    status: "active" | "revoked";
    actor: string;
    sessionId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<MemoryRecord> {
    const loadReplay = async (client: PoolClient | Pool = this.pool): Promise<MemoryRecord | null> => {
      const replay = await client.query(
        `SELECT event_type, payload FROM memory_events
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (replay.rowCount === 0) return null;
      const payload = replay.rows[0].payload as Record<string, unknown>;
      const expectedEventType = input.status === "revoked" ? "memory.revoked" : "memory.restored";
      const fingerprint = requestHash({
        tenantId: input.tenantId,
        memoryId: input.memoryId,
        status: input.status,
        actor: input.actor,
        sessionId: input.sessionId,
        reason: input.reason,
      });
      if (
        ![expectedEventType, "memory.status_unchanged"].includes(replay.rows[0].event_type) ||
        payload.memoryId !== input.memoryId ||
        payload.toStatus !== input.status ||
        payload.requestFingerprint !== fingerprint
      ) {
        throw new IdempotencyConflictError();
      }
      if (payload.resultMemory && typeof payload.resultMemory === "object") {
        return payload.resultMemory as MemoryRecord;
      }
      const current = await client.query(
        "SELECT * FROM memory_records WHERE tenant_id = $1 AND memory_id = $2",
        [input.tenantId, input.memoryId],
      );
      if (current.rowCount === 0) throw new NotFoundError("memory");
      return { ...memoryFromRow(current.rows[0]), status: input.status, revision: Number(payload.revision) };
    };

    const replay = await loadReplay();
    if (replay) return replay;
    try {
      return await this.withSerializable(async (client) => {
      const transactionReplay = await loadReplay(client);
      if (transactionReplay) return transactionReplay;
      const before = await client.query(
        "SELECT * FROM memory_records WHERE tenant_id = $1 AND memory_id = $2 FOR UPDATE",
        [input.tenantId, input.memoryId],
      );
      if (before.rowCount === 0) throw new NotFoundError("memory");
      const current = memoryFromRow(before.rows[0]);
      if (current.status === input.status) {
        const incidentId = current.incidentId ?? current.memoryId;
        await this.appendIncidentEvent(client, {
          tenantId: input.tenantId,
          incidentId,
          eventType: "memory.status_unchanged",
          payload: {
            memoryId: current.memoryId,
            fromStatus: current.status,
            toStatus: input.status,
            reason: input.reason,
            revision: current.revision,
            resultMemory: current,
            requestFingerprint: requestHash({
              tenantId: input.tenantId,
              memoryId: input.memoryId,
              status: input.status,
              actor: input.actor,
              sessionId: input.sessionId,
              reason: input.reason,
            }),
          },
          actor: input.actor,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        });
        return current;
      }
      const updated = await client.query(
        `UPDATE memory_records
            SET status = $3, revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND memory_id = $2
          RETURNING *`,
        [input.tenantId, input.memoryId, input.status],
      );
      const memory = memoryFromRow(updated.rows[0]);
      const incidentId = memory.incidentId ?? memory.memoryId;
      await this.appendIncidentEvent(client, {
        tenantId: input.tenantId,
        incidentId,
        eventType: input.status === "revoked" ? "memory.revoked" : "memory.restored",
        payload: {
          memoryId: memory.memoryId,
          fromStatus: current.status,
          toStatus: input.status,
          reason: input.reason,
          revision: memory.revision,
          resultMemory: memory,
          requestFingerprint: requestHash({
            tenantId: input.tenantId,
            memoryId: input.memoryId,
            status: input.status,
            actor: input.actor,
            sessionId: input.sessionId,
            reason: input.reason,
          }),
        },
        actor: input.actor,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
      });
      return memory;
      });
    } catch (error) {
      const committedReplay = await loadReplay().catch((replayError) => {
        if (replayError instanceof IdempotencyConflictError) throw replayError;
        return null;
      });
      if (committedReplay) return committedReplay;
      throw error;
    }
  }

  async replayMemoryStatus(input: {
    tenantId: string;
    memoryId: string;
    status: "active" | "revoked";
    actor: string;
    sessionId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<MemoryRecord | null> {
    const replay = await this.pool.query(
      `SELECT event_type, payload FROM memory_events
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if (replay.rowCount === 0) return null;
    const payload = replay.rows[0].payload as Record<string, unknown>;
    const fingerprint = requestHash({
      tenantId: input.tenantId,
      memoryId: input.memoryId,
      status: input.status,
      actor: input.actor,
      sessionId: input.sessionId,
      reason: input.reason,
    });
    if (
      ![
        input.status === "revoked" ? "memory.revoked" : "memory.restored",
        "memory.status_unchanged",
      ].includes(replay.rows[0].event_type) ||
      payload.memoryId !== input.memoryId ||
      payload.toStatus !== input.status ||
      payload.requestFingerprint !== fingerprint
    ) {
      throw new IdempotencyConflictError();
    }
    if (payload.resultMemory && typeof payload.resultMemory === "object") return payload.resultMemory as MemoryRecord;
    const current = await this.pool.query(
      "SELECT * FROM memory_records WHERE tenant_id = $1 AND memory_id = $2",
      [input.tenantId, input.memoryId],
    );
    if (current.rowCount === 0) throw new NotFoundError("memory");
    return { ...memoryFromRow(current.rows[0]), status: input.status, revision: Number(payload.revision) };
  }

  async timeline(tenantId: string, incidentId: string): Promise<TimelineEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_events
        WHERE tenant_id = $1 AND aggregate_id = $2
        ORDER BY version`,
      [tenantId, incidentId],
    );
    return result.rows.map(timelineFromRow);
  }

  async evidence(tenantId: string): Promise<EvidenceSummary> {
    const [counts, version, indexes] = await Promise.all([
      this.pool.query(
        `SELECT
           (SELECT count(*) FROM incidents WHERE tenant_id = $1) AS incidents,
           (SELECT count(*) FROM memory_records WHERE tenant_id = $1 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > now())) AS active_memories,
           (SELECT count(*) FROM memory_records WHERE tenant_id = $1 AND status = 'revoked') AS revoked_memories,
           (SELECT count(*) FROM memory_events WHERE tenant_id = $1) AS events,
           (SELECT count(*) FROM evidence_outbox WHERE tenant_id = $1 AND state = 'pending') AS pending_receipts,
           (SELECT count(*) FROM evidence_outbox WHERE tenant_id = $1 AND state = 'published') AS published_receipts`,
        [tenantId],
      ),
      this.pool.query("SELECT version() AS version"),
      this.pool.query("SHOW INDEXES FROM memory_records"),
    ]);
    const row = counts.rows[0];
    const indexNames = indexes.rows.map((item) => item.index_name ?? item.indexName ?? "");
    return {
      tenantId,
      incidents: Number(row.incidents),
      activeMemories: Number(row.active_memories),
      revokedMemories: Number(row.revoked_memories),
      events: Number(row.events),
      pendingReceipts: Number(row.pending_receipts),
      publishedReceipts: Number(row.published_receipts),
      vectorIndex: indexNames.includes("memory_semantic_idx") ? "memory_semantic_idx:active" : "missing",
      databaseVersion: version.rows[0].version,
    };
  }

  async aggregateEvidence(tenantId: string, incidentId: string): Promise<{
    incidents: number;
    memories: number;
    actions: number;
    createdEvents: number;
    approvedEvents: number;
  }> {
    const result = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND incident_id = $2) AS incidents,
         (SELECT count(*) FROM memory_records WHERE tenant_id = $1 AND incident_id = $2) AS memories,
         (SELECT count(*) FROM action_proposals WHERE tenant_id = $1 AND incident_id = $2) AS actions,
         (SELECT count(*) FROM memory_events WHERE tenant_id = $1 AND aggregate_id = $2
           AND event_type = 'incident.created') AS created_events,
         (SELECT count(*) FROM memory_events WHERE tenant_id = $1 AND aggregate_id = $2
           AND event_type = 'action.approved') AS approved_events`,
      [tenantId, incidentId],
    );
    const row = result.rows[0];
    return {
      incidents: Number(row.incidents),
      memories: Number(row.memories),
      actions: Number(row.actions),
      createdEvents: Number(row.created_events),
      approvedEvents: Number(row.approved_events),
    };
  }

  async vectorIndexPlan(tenantId: string, embedding: number[]): Promise<{
    plan: string;
    usesVectorIndex: boolean;
    cosineOpclass: boolean;
  }> {
    const [explain, create] = await Promise.all([
      this.pool.query(
        `EXPLAIN SELECT tenant_id, memory_id, embedding <=> $2::VECTOR AS distance
           FROM memory_records@memory_semantic_idx
          WHERE tenant_id = $1 AND status = 'active'
          ORDER BY embedding <=> $2::VECTOR
          LIMIT 4`,
        [tenantId, vectorLiteral(embedding)],
      ),
      this.pool.query("SHOW CREATE TABLE memory_records"),
    ]);
    const plan = explain.rows.map((row) => String(row.info ?? Object.values(row)[0])).join("\n");
    const definition = String(create.rows[0]?.create_statement ?? "");
    return {
      plan,
      usesVectorIndex: /vector search/i.test(plan) && /memory_records@memory_semantic_idx/i.test(plan),
      cosineOpclass: /memory_semantic_idx[^\n]*vector_cosine_ops/i.test(definition),
    };
  }

  async acquireDemoQuota(scope: string, limit: number): Promise<void> {
    if (!/^[a-z-]{3,40}$/.test(scope) || limit < 1) throw new Error("invalid quota scope");
    const hourBucket = new Date().toISOString().slice(0, 13);
    const result = await this.pool.query(
      `INSERT INTO demo_request_quotas (scope, hour_bucket, request_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (scope, hour_bucket)
       DO UPDATE SET request_count = least(demo_request_quotas.request_count + 1, $3)
       RETURNING request_count`,
      [scope, hourBucket, limit + 1],
    );
    const count = Number(result.rows[0].request_count);
    if (count > limit) throw new QuotaExceededError(scope, limit);
  }

  async acquireEvaluationLease(holderId: string, leaseSeconds = 120): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO evaluation_leases (lease_name, holder_id, expires_at)
       VALUES ('operational-memory-gate', $1::UUID, now() + ($2::INT * INTERVAL '1 second'))
       ON CONFLICT (lease_name) DO UPDATE
         SET holder_id = excluded.holder_id,
             expires_at = excluded.expires_at,
             updated_at = now()
       WHERE evaluation_leases.expires_at < now()
       RETURNING holder_id`,
      [holderId, leaseSeconds],
    );
    return result.rowCount === 1 && result.rows[0].holder_id === holderId;
  }

  async releaseEvaluationLease(holderId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM evaluation_leases WHERE lease_name = 'operational-memory-gate' AND holder_id = $1::UUID",
      [holderId],
    );
  }

  async pendingOutbox(tenantId: string, limit = 20): Promise<OutboxRecord[]> {
    const result = await this.pool.query(
      `SELECT tenant_id, outbox_id, receipt_key, payload, attempts
         FROM evidence_outbox
        WHERE tenant_id = $1 AND state IN ('pending', 'failed')
        ORDER BY created_at
        LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      outboxId: row.outbox_id,
      receiptKey: row.receipt_key,
      payload: row.payload,
      attempts: Number(row.attempts),
    }));
  }

  async markOutboxPublished(tenantId: string, outboxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE evidence_outbox
          SET state = 'published', attempts = attempts + 1, published_at = now(), last_error = NULL
        WHERE tenant_id = $1 AND outbox_id = $2`,
      [tenantId, outboxId],
    );
  }

  async markOutboxFailed(tenantId: string, outboxId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE evidence_outbox
          SET state = 'failed', attempts = attempts + 1, last_error = left($3, 500)
        WHERE tenant_id = $1 AND outbox_id = $2`,
      [tenantId, outboxId, message],
    );
  }

  async seedMemory(input: {
    tenantId: string;
    content: string;
    kind: string;
    embedding: number[];
    provenance: Record<string, unknown>;
    expiresAt?: string | null;
  }): Promise<MemoryRecord> {
    const result = await this.pool.query(
      `INSERT INTO memory_records
         (tenant_id, kind, content, embedding, provenance, expires_at)
       VALUES ($1, $2, $3, $4::VECTOR, $5::JSONB, $6)
       RETURNING *`,
      [
        input.tenantId,
        input.kind,
        input.content,
        vectorLiteral(input.embedding),
        JSON.stringify(input.provenance),
        input.expiresAt ?? null,
      ],
    );
    return memoryFromRow(result.rows[0]);
  }

  async resetDemoTenant(tenantId: string): Promise<void> {
    if (tenantId !== "demo-logistics") throw new Error("reset is restricted to the demo tenant");
    await this.withSerializable(async (client) => {
      await client.query("DELETE FROM evidence_outbox WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM memory_events WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM action_proposals WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM memory_records WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM incidents WHERE tenant_id = $1", [tenantId]);
      return undefined;
    });
  }

  async deleteEvaluationTenant(tenantId: string): Promise<void> {
    if (!/^eval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-shadow)?$/.test(tenantId)) {
      throw new Error("cleanup is restricted to isolated evaluation tenants");
    }
    await this.withSerializable(async (client) => {
      await client.query("DELETE FROM evidence_outbox WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM memory_events WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM action_proposals WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM memory_records WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM incidents WHERE tenant_id = $1", [tenantId]);
      await client.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
      return undefined;
    });
  }

  async deleteEvaluationTenants(tenantIds: string[]): Promise<void> {
    if (
      tenantIds.length === 0 ||
      tenantIds.some((tenantId) => !/^eval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-shadow)?$/.test(tenantId))
    ) {
      throw new Error("cleanup is restricted to isolated evaluation tenants");
    }
    await this.withSerializable(async (client) => {
      for (const table of ["evidence_outbox", "memory_events", "action_proposals", "memory_records", "incidents", "tenants"]) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::STRING[])`, [tenantIds]);
      }
      return undefined;
    });
  }

  async deleteStaleEvaluationTenants(olderThanMinutes: number): Promise<number> {
    if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 5 || olderThanMinutes > 1440) {
      throw new Error("stale evaluation cleanup window must be 5-1440 minutes");
    }
    const result = await this.pool.query(
      `SELECT DISTINCT regexp_replace(tenant_id, '-shadow$', '') AS tenant_id
         FROM (
           SELECT tenant_id, min(created_at) AS created_at FROM tenants GROUP BY tenant_id
           UNION ALL SELECT tenant_id, min(created_at) FROM incidents GROUP BY tenant_id
           UNION ALL SELECT tenant_id, min(created_at) FROM memory_records GROUP BY tenant_id
           UNION ALL SELECT tenant_id, min(created_at) FROM action_proposals GROUP BY tenant_id
           UNION ALL SELECT tenant_id, min(created_at) FROM memory_events GROUP BY tenant_id
           UNION ALL SELECT tenant_id, min(created_at) FROM evidence_outbox GROUP BY tenant_id
         ) AS evaluation_rows
        WHERE tenant_id ~ '^eval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-shadow)?$'
          AND created_at < now() - ($1::INT * INTERVAL '1 minute')`,
      [olderThanMinutes],
    );
    const tenants = result.rows.map((row) => String(row.tenant_id));
    for (const tenantId of tenants) {
      await this.deleteEvaluationTenants([tenantId, `${tenantId}-shadow`]);
    }
    return tenants.length;
  }

  async evaluationRows(tenantIds: string[]): Promise<number> {
    if (
      tenantIds.length === 0 ||
      tenantIds.some((tenantId) => !/^eval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-shadow)?$/.test(tenantId))
    ) {
      throw new Error("evaluation row audit requires evaluation tenants");
    }
    const result = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM tenants WHERE tenant_id = ANY($1::STRING[])) +
         (SELECT count(*) FROM incidents WHERE tenant_id = ANY($1::STRING[])) +
         (SELECT count(*) FROM memory_records WHERE tenant_id = ANY($1::STRING[])) +
         (SELECT count(*) FROM action_proposals WHERE tenant_id = ANY($1::STRING[])) +
         (SELECT count(*) FROM memory_events WHERE tenant_id = ANY($1::STRING[])) +
         (SELECT count(*) FROM evidence_outbox WHERE tenant_id = ANY($1::STRING[])) AS rows`,
      [tenantIds],
    );
    return Number(result.rows[0].rows);
  }

  makeIdempotencyKey(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}
