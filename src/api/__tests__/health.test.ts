/**
 * Health endpoints — /health and /health/deep (S275, task_1785713207341).
 *
 * The defect being fixed: /health was a static handler that CANNOT FAIL, so
 * `docker inspect` reported healthy throughout the S204 and S231 outages while
 * search was dead. Two instruments green, capability gone.
 *
 * Every "goes red" assertion is paired with a control that must stay green,
 * because a healthcheck that fails unconditionally is no better than one that
 * passes unconditionally -- it just gets disabled faster.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPing = vi.fn();
let exposePing = true;

vi.mock("../../db/connection.js", () => ({ getPool: () => ({}) }));
vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => (exposePing
    ? { generateEmbedding: vi.fn(), extractMetadata: vi.fn(), ping: mockPing }
    : { generateEmbedding: vi.fn(), extractMetadata: vi.fn() }),
}));

const { createApi } = await import("../routes.js");

beforeEach(() => {
  mockPing.mockReset();
  exposePing = true;
});

describe("/health", () => {
  it("reports the dependency so a reader cannot be misled", async () => {
    mockPing.mockResolvedValue({ provider: "ollama", reachable: true, ms: 4 });
    const res = await createApi().request("/health");
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.dependencies.embedder.reachable).toBe(true);
  });

  // *** THE DELIBERATE NON-CHANGE. *** collect-ob1-health.mjs keys api_healthy off
  // `status === "healthy"`, and ops-ob1.capability -- the only `critical` seam --
  // derives its verdict from that. Widening `status` here would silently re-label
  // a dead-ollama condition from `search-failed` to `api-unhealthy` on that seam.
  it("*** keeps status=healthy even with the dependency DOWN (contract is process liveness) ***", async () => {
    mockPing.mockResolvedValue({ provider: "ollama", reachable: false, ms: 3000 });
    const res = await createApi().request("/health");
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    // ...but it no longer HIDES the failure, which was the actual defect.
    expect(body.dependencies.embedder.reachable).toBe(false);
  });
});

describe("/health/deep", () => {
  it("200 when the dependency is reachable", async () => {
    mockPing.mockResolvedValue({ provider: "ollama", reachable: true, ms: 4 });
    const res = await createApi().request("/health/deep");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("healthy");
  });

  // *** THE WHOLE POINT: it must be ABLE to go red. ***
  it("*** 503 when the dependency is measurably unreachable ***", async () => {
    mockPing.mockResolvedValue({ provider: "ollama", reachable: false, ms: 3000, detail: "fetch failed" });
    const res = await createApi().request("/health/deep");
    const body = (await res.json()) as any;

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.dependencies.embedder.detail).toBe("fetch failed");
  });

  // CONTROL: not-probed is NOT a failure. A provider with no free liveness probe
  // would otherwise be permanently unhealthy -- the always-red class.
  it("CONTROL: a provider exposing no ping stays healthy, NOT degraded", async () => {
    exposePing = false;
    const res = await createApi().request("/health/deep");
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.dependencies.embedder.reachable).toBeNull();
  });

  it("CONTROL: reachable:null is distinguished from reachable:false", async () => {
    mockPing.mockResolvedValue({ provider: "x", reachable: null, ms: null });
    const res = await createApi().request("/health/deep");
    expect(res.status).toBe(200);
  });

  it("caches the probe so a 30s healthcheck does not hammer the dependency", async () => {
    mockPing.mockResolvedValue({ provider: "ollama", reachable: true, ms: 4 });
    const app = createApi();
    await app.request("/health/deep");
    await app.request("/health/deep");
    await app.request("/health");
    expect(mockPing).toHaveBeenCalledTimes(1);
  });
});
