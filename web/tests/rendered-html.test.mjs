import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete RecallOps judge experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();

  assert.match(html, /<title>RecallOps — Reversible agentic memory<\/title>/i);
  assert.match(html, /Memory that knows when to act/i);
  assert.match(html, /Open an incident/i);
  assert.match(html, /Inject response loss after commit/i);
  assert.match(html, /CockroachDB/i);
  assert.match(html, /Lambda agent/i);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);
});

test("publishes accessible controls and social metadata", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /aria-label="Inject response loss after commit"/i);
  assert.match(html, /property="og:image"/i);
  assert.match(html, /\/og\.png/i);
  assert.match(html, /Synthetic data only/i);
  assert.match(html, /human approval required/i);
});
