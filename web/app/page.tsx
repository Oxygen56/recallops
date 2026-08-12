"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";
const TENANT = "demo-logistics";

type Memory = {
  memoryId: string;
  content: string;
  status: "active" | "revoked";
  score?: number;
  provenance: Record<string, unknown>;
  expiresAt: string | null;
};

type Action = {
  actionId: string;
  actionType: string;
  title: string;
  rationale: string;
  risk: "low" | "medium" | "high";
  reversible: boolean;
  state: "proposed" | "approved" | "executed" | "compensated" | "rejected";
  revision: number;
};

type Bundle = {
  incident: {
    incidentId: string;
    supplier: string;
    shipmentRef: string;
    category: string;
    severity: number;
    summary: string;
    status: string;
    revision: number;
    sessionId: string;
  };
  memory: Memory;
  actions: Action[];
  similarMemories: Memory[];
  idempotentReplay: boolean;
  receiptState: string;
};

type Evidence = {
  incidents: number;
  activeMemories: number;
  revokedMemories: number;
  events: number;
  pendingReceipts: number;
  publishedReceipts: number;
  vectorIndex: string;
  databaseVersion: string;
};

type SafetyCheck = {
  id: string;
  label: string;
  passed: boolean;
  proof: string;
};

type SafetyEvaluation = {
  schema: "recallops.safety-evaluation.v1";
  evaluationId: string;
  generatedAt: string;
  runtimeMs: number;
  passed: number;
  total: number;
  databaseVersion: string;
  vectorIndex: string;
  cleanupVerified: boolean;
  remainingRowsAfterCleanup: number;
  checks: SafetyCheck[];
};

type TimelineEvent = {
  eventId: string;
  version: number;
  eventType: string;
  actor: string;
  sessionId: string;
  eventHash: string;
  previousHash: string;
  createdAt: string;
};

const defaultForm = {
  supplier: "HarborLine Logistics",
  shipmentRef: "HL-2048",
  category: "delay",
  severity: 4,
  summary: "Carrier milestone is missing after six days of port congestion; customer promise is at risk.",
};

const defaultSafetyChecks: SafetyCheck[] = [
  { id: "ambiguous-commit", label: "Lost-response recovery", passed: false, proof: "same command, same aggregate" },
  { id: "zero-duplicates", label: "Zero duplicate rows", passed: false, proof: "database counts stay singular" },
  { id: "concurrent-approval", label: "Concurrent approval", passed: false, proof: "one winner, explicit stale loser" },
  { id: "compensation", label: "Compensating transition", passed: false, proof: "reversible state change" },
  { id: "cross-session", label: "Cross-session continuity", passed: false, proof: "prior shift recalled" },
  { id: "memory-lifecycle", label: "Revoke + restore lifecycle", passed: false, proof: "recall changes with status" },
  { id: "expiry", label: "Expiry exclusion", passed: false, proof: "expired sentinel excluded" },
  { id: "tenant-prefix", label: "Tenant-prefix retrieval", passed: false, proof: "perfect shadow match excluded" },
  { id: "hash-chain", label: "Audit hash chain", passed: false, proof: "payload + metadata recomputed" },
  { id: "vector-index", label: "Distributed cosine vector plan", passed: false, proof: "EXPLAIN shows vector search" },
];

const safetyGroups = [
  { title: "Failure recovery", ids: ["ambiguous-commit", "zero-duplicates", "concurrent-approval"] },
  { title: "Human control", ids: ["compensation"] },
  { title: "Lifecycle", ids: ["cross-session", "memory-lifecycle", "expiry"] },
  { title: "Isolation & integrity", ids: ["tenant-prefix", "hash-chain", "vector-index"] },
];

function makeKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function shortId(value: string) {
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message ?? payload.error ?? "Request failed"), { payload, status: response.status });
  return payload;
}

export default function Home() {
  const [form, setForm] = useState(defaultForm);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evaluation, setEvaluation] = useState<SafetyEvaluation | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting to the memory ledger…");
  const [faultMode, setFaultMode] = useState(true);
  const [recoveryProof, setRecoveryProof] = useState(false);
  const [apiOnline, setApiOnline] = useState(false);

  const sessionId = useMemo(() => `judge-session-${crypto.randomUUID().slice(0, 8)}`, []);

  const refreshEvidence = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/evidence?tenantId=${TENANT}`, { cache: "no-store" });
      const next = await readJson(response);
      setEvidence(next);
      setApiOnline(true);
      setStatus("CockroachDB memory ledger is live");
    } catch {
      setApiOnline(false);
      setStatus("Start the RecallOps API to run the live proof");
    }
  }, []);

  const loadTimeline = useCallback(async (incidentId: string) => {
    const response = await fetch(`${API_BASE}/v1/incidents/${incidentId}/timeline?tenantId=${TENANT}`, { cache: "no-store" });
    const payload = await readJson(response);
    setTimeline(payload.events);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/v1/evidence?tenantId=${TENANT}`, { cache: "no-store" })
      .then(readJson)
      .then((next) => {
        if (cancelled) return;
        setEvidence(next);
        setApiOnline(true);
        setStatus("CockroachDB memory ledger is live");
      })
      .catch(() => {
        if (cancelled) return;
        setApiOnline(false);
        setStatus("Start the RecallOps API to run the live proof");
      });
    return () => { cancelled = true; };
  }, []);

  async function resetDemo() {
    setBusy("reset");
    setStatus("Resetting the synthetic proof environment…");
    try {
      await readJson(await fetch(`${API_BASE}/v1/demo/reset`, { method: "POST" }));
      setBundle(null);
      setTimeline([]);
      setEvaluation(null);
      setRecoveryProof(false);
      await refreshEvidence();
      setStatus("Three provenance-bearing memories are ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reset failed safely");
    } finally {
      setBusy(null);
    }
  }

  async function runEvaluation() {
    setBusy("evaluate");
    setEvaluation(null);
    setStatus("Attacking an isolated memory tenant with ten failure and governance checks…");
    try {
      const next = await readJson(await fetch(`${API_BASE}/v1/evaluations/safety`, { method: "POST" }));
      setEvaluation(next);
      setStatus(`${next.passed}/${next.total} operational memory checks passed in ${(next.runtimeMs / 1000).toFixed(1)}s`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Safety evaluation failed closed");
    } finally {
      setBusy(null);
    }
  }

  async function analyzeIncident(event: React.FormEvent) {
    event.preventDefault();
    setBusy("analyze");
    setRecoveryProof(false);
    const idempotencyKey = makeKey("judge-incident");
    const payload = {
      tenantId: TENANT,
      ...form,
      severity: Number(form.severity),
      sessionId,
      actor: "judge-operator",
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    };
    if (faultMode) headers["x-recallops-fault"] = "after-commit";
    try {
      setStatus(faultMode ? "Committing, then intentionally losing the response…" : "Writing one atomic memory decision…");
      let response = await fetch(`${API_BASE}/v1/incidents`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (response.status === 503 && faultMode) {
        await response.json();
        setStatus("Response lost after commit. Reconciling with the same idempotency key…");
        response = await fetch(`${API_BASE}/v1/incidents`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(payload),
        });
        setRecoveryProof(true);
      }
      const next = await readJson(response);
      setBundle(next);
      await Promise.all([refreshEvidence(), loadTimeline(next.incident.incidentId)]);
      setStatus(next.idempotentReplay ? "Recovered the committed decision without duplication" : "Decision committed atomically");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The incident failed safely");
    } finally {
      setBusy(null);
    }
  }

  async function transitionAction(action: Action, transition: "approve" | "compensate") {
    if (!bundle) return;
    setBusy(action.actionId);
    try {
      const response = await fetch(`${API_BASE}/v1/actions/${action.actionId}/${transition}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": makeKey(`judge-${transition}`) },
        body: JSON.stringify({
          tenantId: TENANT,
          expectedRevision: action.revision,
          actor: "judge-operator",
          sessionId: `${sessionId}-next-shift`,
        }),
      });
      const payload = await readJson(response);
      setBundle({
        ...bundle,
        actions: bundle.actions.map((candidate) => candidate.actionId === action.actionId ? payload.action : candidate),
      });
      await Promise.all([refreshEvidence(), loadTimeline(bundle.incident.incidentId)]);
      setStatus(transition === "approve" ? "Action approved with a compare-and-set revision" : "Action compensated; history remains auditable");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transition failed safely");
    } finally {
      setBusy(null);
    }
  }

  async function transitionMemory(transition: "revoke" | "restore") {
    if (!bundle) return;
    setBusy(`memory-${transition}`);
    try {
      const response = await fetch(`${API_BASE}/v1/memories/${bundle.memory.memoryId}/${transition}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": makeKey(`judge-${transition}`) },
        body: JSON.stringify({
          tenantId: TENANT,
          actor: "judge-operator",
          sessionId: `${sessionId}-governance`,
          reason: transition === "revoke" ? "Judge demonstration: source evidence superseded." : "Judge demonstration: replacement evidence revalidated the memory.",
        }),
      });
      const payload = await readJson(response);
      setBundle({ ...bundle, memory: payload.memory });
      await Promise.all([refreshEvidence(), loadTimeline(bundle.incident.incidentId)]);
      setStatus(transition === "revoke" ? "Memory revoked and removed from retrieval" : "Memory restored with a new audit event");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Memory transition failed safely");
    } finally {
      setBusy(null);
    }
  }

  async function flushReceipts() {
    setBusy("flush");
    try {
      const payload = await readJson(await fetch(`${API_BASE}/v1/evidence/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT }),
      }));
      await refreshEvidence();
      setStatus(`${payload.published} encrypted decision receipt${payload.published === 1 ? "" : "s"} published via ${payload.sink}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Receipt publish failed safely");
    } finally {
      setBusy(null);
    }
  }

  const displayedSafetyChecks = evaluation?.checks ?? defaultSafetyChecks;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RecallOps home">
          <span className="brandMark"><i /><i /><i /></span>
          <span>RecallOps</span>
        </a>
        <div className="systemStatus" aria-live="polite">
          <span className={apiOnline ? "pulse online" : "pulse"} />
          {status}
        </div>
        <button
          className="quietButton"
          onClick={evaluation
            ? resetDemo
            : () => document.getElementById("safety-gate")?.scrollIntoView({ behavior: "smooth" })}
          disabled={busy !== null}
        >
          {busy === "reset" ? "Resetting…" : evaluation ? "Reset proof" : "Run memory gate"}
        </button>
      </header>

      <section id="top" className="hero shell">
        <div className="heroCopy">
          <p className="eyebrow"><span>Supply-chain incident memory</span><span>Built for CockroachDB × AWS</span></p>
          <h1>Never duplicate a retry.<br /><em>Prove every memory.</em></h1>
          <p className="lede">
            One click attacks a fresh isolated application tenant in CockroachDB across lost results, racing approvals, revocation,
            expiry, tenant-prefix retrieval, and audit integrity—then proves cleanup.
          </p>
          <div className="heroActions">
            <a className="heroPrimary" href="#safety-gate">Run the live 10-check memory gate ↓</a>
            <a className="heroSecondary" href="#incident-proof">See incident recovery proof</a>
          </div>
          <div className="proofStrip">
            <div><strong>01</strong><span>No duplicate action on retry</span></div>
            <div><strong>02</strong><span>One approval winner</span></div>
            <div><strong>03</strong><span>Revoked memory never recalled</span></div>
          </div>
        </div>
        <div className="memoryOrb" aria-label="Live memory architecture">
          <div className="orbit orbitOne"><span /></div>
          <div className="orbit orbitTwo"><span /></div>
          <div className="orbCore"><small>persistent</small><strong>MEMORY</strong><span>CockroachDB</span></div>
          <span className="orbLabel labelA">VECTOR</span>
          <span className="orbLabel labelB">EVENTS</span>
          <span className="orbLabel labelC">TTL</span>
          <span className="orbLabel labelD">MCP</span>
        </div>
      </section>

      <section className="evidenceBar">
        <div className="shell evidenceGrid">
          <Metric label="Incidents" value={evidence?.incidents ?? "—"} />
          <Metric label="Active memories" value={evidence?.activeMemories ?? "—"} />
          <Metric label="Audit events" value={evidence?.events ?? "—"} />
          <Metric label="Published receipts" value={evidence?.publishedReceipts ?? "—"} />
          <div className="indexBadge"><span>Distributed index</span><strong>{evidence?.vectorIndex === "memory_semantic_idx:active" ? "ACTIVE" : "WAITING"}</strong></div>
        </div>
      </section>

      <section id="safety-gate" className="evaluationSection shell">
        <div className="sectionHeading">
          <div><p className="kicker">Operational memory gate / live</p><h2>Break the memory before operations do</h2></div>
          <p>A disposable application tenant is exercised, measured, and cleanup-audited. The score comes from live CockroachDB behavior—not a screenshot or a hard-coded checklist.</p>
        </div>
        <div className={`evaluationBoard ${evaluation && evaluation.passed === evaluation.total ? "evaluationPassed" : ""}`}>
          <div className="evaluationScore">
            <p className="monoLabel">
              {busy === "evaluate"
                ? "RUNNING / FRESH TENANT"
                : evaluation
                  ? `${evaluation.passed}/${evaluation.total} LIVE DATABASE CHECKS`
                  : "NOT RUN / 10 CHECKS READY"}
            </p>
            <strong>{busy === "evaluate" ? "…" : evaluation ? evaluation.passed : "—"}<span>/{evaluation ? evaluation.total : "10"}</span></strong>
            <p>{evaluation ? `${(evaluation.runtimeMs / 1000).toFixed(1)}s · ${evaluation.vectorIndex.replaceAll(":", " · ")}` : "Ten live checks · isolated tenant · cleanup is a hard gate"}</p>
            {evaluation && <small className="evaluationReceipt">eval {evaluation.evaluationId.slice(0, 8)} · cleanup {evaluation.cleanupVerified && evaluation.remainingRowsAfterCleanup === 0 ? "verified / 0 rows" : "failed"}<br />{evaluation.databaseVersion.split(" (")[0]}</small>}
            <button className="evaluationButton" onClick={runEvaluation} disabled={busy !== null || !apiOnline}>
              {busy === "evaluate" ? "Running operational memory gate…" : evaluation ? "Run again on fresh state" : "Run 10-check memory gate"}
            </button>
          </div>
          <div className="evaluationChecks" aria-live="polite">
            {safetyGroups.map((group) => (
              <section className="checkGroup" key={group.title}>
                <h3>{group.title}</h3>
                {displayedSafetyChecks
                  .filter((check) => group.ids.includes(check.id))
                  .map((check) => {
                    const index = displayedSafetyChecks.findIndex((candidate) => candidate.id === check.id);
                    return (
                      <article className={evaluation ? (check.passed ? "checkPassed" : "checkFailed") : "checkWaiting"} key={check.id}>
                        <span>{evaluation ? (check.passed ? "✓" : "!") : String(index + 1).padStart(2, "0")}</span>
                        <div><strong>{check.label}</strong><p>{check.proof}</p></div>
                      </article>
                    );
                  })}
              </section>
            ))}
          </div>
        </div>
      </section>

      <section id="incident-proof" className="workspace shell">
        <div className="sectionHeading">
          <div><p className="kicker">Live proof / 01</p><h2>Open an incident</h2></div>
          <p>Submit once. We deliberately lose the response after commit, then recover the exact decision with the same key.</p>
        </div>

        <div className="workGrid">
          <form className="incidentForm" onSubmit={analyzeIncident}>
            <div className="formRow">
              <label>Supplier<input value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} /></label>
              <label>Shipment reference<input value={form.shipmentRef} onChange={(event) => setForm({ ...form, shipmentRef: event.target.value })} /></label>
            </div>
            <div className="formRow compact">
              <label>Incident class<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="delay">Delay</option><option value="quality">Quality</option><option value="capacity">Capacity</option><option value="compliance">Compliance</option></select></label>
              <label>Severity<select value={form.severity} onChange={(event) => setForm({ ...form, severity: Number(event.target.value) })}><option value={2}>2 — Guarded</option><option value={3}>3 — Material</option><option value={4}>4 — High</option><option value={5}>5 — Critical</option></select></label>
            </div>
            <label>What changed?<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} rows={4} /></label>
            <label className="faultToggle">
              <input aria-label="Inject response loss after commit" type="checkbox" checked={faultMode} onChange={(event) => setFaultMode(event.target.checked)} />
              <span><strong>Inject response loss after commit</strong><small>Proves read-after-timeout reconciliation and idempotency.</small></span>
            </label>
            <button className="primaryButton" type="submit" disabled={busy !== null || !apiOnline}>
              <span>{busy === "analyze" ? "Running the proof…" : "Analyze & write memory"}</span><b>↗</b>
            </button>
            <p className="formFoot">Synthetic data only · human approval required · no external action executes automatically</p>
          </form>

          <div className="decisionPanel">
            {!bundle ? (
              <div className="emptyDecision">
                <span className="emptyGlyph">R</span>
                <h3>No incident selected</h3>
                <p>Run the proof to see vector recall, action proposals, provenance, and the hash-linked event ledger.</p>
                <ul><li>Serializable state</li><li>Reversible actions</li><li>Cross-session evidence</li></ul>
              </div>
            ) : (
              <>
                <div className="decisionTop">
                  <div><p className="monoLabel">INCIDENT / {shortId(bundle.incident.incidentId)}</p><h3>{bundle.incident.shipmentRef} · {bundle.incident.supplier}</h3></div>
                  <span className="severity">S{bundle.incident.severity}</span>
                </div>
                {recoveryProof && <div className="recoveryBanner"><span>RECOVERED</span><p>Commit survived a lost response. Replay returned the same incident and action IDs.</p></div>}
                <div className="memoryCard">
                  <div className="cardTitle"><span>Admitted memory</span><StatusPill state={bundle.memory.status} /></div>
                  <p>{bundle.memory.content.split("\n").slice(0, 3).join(" ")}</p>
                  <div className="memoryMeta"><span>64-d vector</span><span>TTL {bundle.memory.expiresAt ? new Date(bundle.memory.expiresAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : "none"}</span><span>rev {bundle.memory.provenance ? "1" : "—"}</span></div>
                  <button className="textButton" onClick={() => transitionMemory(bundle.memory.status === "active" ? "revoke" : "restore")} disabled={busy !== null}>
                    {busy?.startsWith("memory") ? "Writing event…" : bundle.memory.status === "active" ? "Revoke from future recall" : "Restore with audit event"}
                  </button>
                </div>
                <div className="actionList">
                  <p className="monoLabel">REVERSIBLE ACTION QUEUE</p>
                  {bundle.actions.map((action) => (
                    <article className="actionRow" key={action.actionId}>
                      <span className={`risk risk-${action.risk}`}>{action.risk.slice(0, 1).toUpperCase()}</span>
                      <div><h4>{action.title}</h4><p>{action.rationale}</p></div>
                      {action.state === "proposed" ? (
                        <button onClick={() => transitionAction(action, "approve")} disabled={busy !== null}>Approve</button>
                      ) : action.state === "approved" ? (
                        <button className="undoButton" onClick={() => transitionAction(action, "compensate")} disabled={busy !== null}>Undo</button>
                      ) : <StatusPill state={action.state} />}
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="proofSection">
        <div className="shell">
          <div className="sectionHeading inverse">
            <div><p className="kicker">Live proof / 02</p><h2>Inspect what the agent remembers</h2></div>
            <button className="outlineButton" onClick={flushReceipts} disabled={busy !== null || !bundle}>{busy === "flush" ? "Publishing…" : "Publish decision receipts"}</button>
          </div>
          <div className="proofColumns">
            <div className="priorMemory">
              <p className="monoLabel">SEMANTIC RECALL / COCKROACHDB VECTOR</p>
              {bundle?.similarMemories?.length ? bundle.similarMemories.slice(0, 3).map((memory, index) => (
                <article key={memory.memoryId}>
                  <div><span>0{index + 1}</span><strong>{Math.round((memory.score ?? 0) * 100)}% match</strong></div>
                  <p>{memory.content}</p>
                  <small>{shortId(memory.memoryId)} · provenance attached</small>
                </article>
              )) : <div className="darkEmpty">Run an incident to retrieve prior outcomes through the tenant-prefixed distributed vector index.</div>}
            </div>
            <div className="timeline">
              <p className="monoLabel">HASH-LINKED EVENT LEDGER</p>
              {timeline.length ? timeline.map((event) => (
                <article key={event.eventId}>
                  <span className="timelineDot" />
                  <div><strong>v{event.version} · {event.eventType}</strong><p>{event.actor} / {event.sessionId}</p><code>{event.eventHash.slice(0, 20)}…</code></div>
                  <time>{formatTime(event.createdAt)}</time>
                </article>
              )) : <div className="darkEmpty">The hash-linked timeline will show creation, approval, revocation, restoration, and compensation events.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="architecture shell">
        <div className="sectionHeading"><div><p className="kicker">Built to fail safely</p><h2>One memory, two control planes</h2></div><p>Application traffic uses serializable SQL. Operators and judges get a cluster-scoped, read-only Managed MCP audit path.</p></div>
        <div className="archFlow">
          <ArchNode step="01" label="Incident" detail="operator evidence" />
          <span className="connector">→</span>
          <ArchNode step="02" label="Lambda agent" detail="decision + guardrails" />
          <span className="connector">→</span>
          <ArchNode featured step="03" label="CockroachDB" detail="state · vectors · events" />
          <span className="connector split">↗<br />↘</span>
          <div className="archStack"><ArchNode step="04A" label="Amazon S3" detail="decision receipts" /><ArchNode step="04B" label="Managed MCP" detail="read-only audit" /></div>
        </div>
      </section>

      <footer>
        <div className="shell footerInner"><div className="brand"><span className="brandMark"><i /><i /><i /></span><span>RecallOps</span></div><p>Memory that knows when to act — and when to forget.</p><span>Apache-2.0 · Synthetic demo data</span></div>
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function StatusPill({ state }: { state: string }) {
  return <span className={`statusPill status-${state}`}>{state}</span>;
}

function ArchNode({ step, label, detail, featured = false }: { step: string; label: string; detail: string; featured?: boolean }) {
  return <div className={`archNode ${featured ? "featured" : ""}`}><span>{step}</span><strong>{label}</strong><small>{detail}</small></div>;
}
