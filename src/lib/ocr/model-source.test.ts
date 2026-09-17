import test from "node:test";
import assert from "node:assert/strict";
import { NDL_MODEL_REVISION, ndlModelRevision } from "./model-revision.ts";
import { resolveLatestNdlModelRevision, NDL_LATEST_REVISION_URL } from "./model-source.ts";

test("model identity accepts immutable SHA values and keeps legacy benchmark identity", () => {
  assert.equal(ndlModelRevision(), NDL_MODEL_REVISION);
  assert.equal(ndlModelRevision("a".repeat(40)), "a".repeat(40));
  assert.throws(() => ndlModelRevision("master"), /commit SHA/);
});

test("latest model lookup validates the response and never substitutes a model after failure", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async request => {
      assert.equal(request, NDL_LATEST_REVISION_URL);
      return Response.json({ sha: "b".repeat(40) });
    };
    assert.equal(await resolveLatestNdlModelRevision(), "b".repeat(40));
    globalThis.fetch = async () => Response.json({ sha: "master" });
    await assert.rejects(resolveLatestNdlModelRevision(), /Invalid model commit SHA/);
    globalThis.fetch = async () => new Response("limited", { status: 403 });
    await assert.rejects(resolveLatestNdlModelRevision(), /HTTP 403/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveLatestNdlModelRevision(controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});
