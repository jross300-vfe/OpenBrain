/**
 * assertUsableEmbedding — the guard that refuses silent garbage.
 *
 * Weighted to the REFUSE cases on purpose: if the guard stopped refusing, a
 * corpus would quietly fill with thoughts that are permanently unfindable by
 * search while looking perfectly healthy in every count and every heartbeat.
 */
import { describe, it, expect } from "vitest";
import { assertUsableEmbedding, EXPECTED_EMBEDDING_DIMS } from "../types.js";

const ctx = { model: "nomic-embed-text", contentBytes: 42 };
const vec = (n: number, fill = 0.01) => Array.from({ length: n }, () => fill);

describe("assertUsableEmbedding", () => {
  it("accepts a well-formed vector of the expected dimensionality", () => {
    const v = vec(EXPECTED_EMBEDDING_DIMS);
    expect(assertUsableEmbedding(v, ctx)).toBe(v);
  });

  // ── THE S269 SHAPE — the case this whole task exists for ────────────
  it("*** REFUSES an empty array (the 200-with-embeddings:[] shape) ***", () => {
    expect(() => assertUsableEmbedding([], ctx)).toThrow(/EMPTY vector/);
  });

  // ── THE TRUTHINESS BUG that shipped in two of three providers ───────
  it("*** an empty array is TRUTHY, so `if (!embedding)` would have passed it ***", () => {
    // Pins the reason the old per-provider guard failed. If this ever becomes
    // false the guard's rationale changed and the comment is a lie.
    // Opaque to the compiler on purpose -- TS narrows a literal `![]` to
    // "always truthy" and refuses to compile the very point being pinned.
    const emptyish: unknown = [];
    expect(!emptyish).toBe(false);
    expect(() => assertUsableEmbedding([], ctx)).toThrow();
  });

  it("refuses undefined / null / a non-array", () => {
    for (const bad of [undefined, null, "vector", 768, {}]) {
      expect(() => assertUsableEmbedding(bad, ctx)).toThrow(/no vector array/);
    }
  });

  // ── DIMENSIONALITY — a model swap corrupts rather than errors ───────
  it("refuses a vector of the wrong dimensionality", () => {
    expect(() => assertUsableEmbedding(vec(1536), ctx)).toThrow(/1536 dimensions, expected 768/);
    expect(() => assertUsableEmbedding(vec(767), ctx)).toThrow(/767 dimensions/);
    expect(() => assertUsableEmbedding(vec(1), ctx)).toThrow(/1 dimensions/);
  });

  // ── THE ONE POSTGRES CANNOT SEE ────────────────────────────────────
  it("*** refuses NaN / Infinity — a valid VECTOR(768) that poisons every comparison ***", () => {
    const withNaN = vec(EXPECTED_EMBEDDING_DIMS);
    withNaN[500] = NaN;
    expect(() => assertUsableEmbedding(withNaN, ctx)).toThrow(/non-finite value at index 500/);

    const withInf = vec(EXPECTED_EMBEDDING_DIMS);
    withInf[0] = Infinity;
    expect(() => assertUsableEmbedding(withInf, ctx)).toThrow(/non-finite/);

    const withStr = vec(EXPECTED_EMBEDDING_DIMS) as unknown[];
    withStr[7] = "0.5";
    expect(() => assertUsableEmbedding(withStr, ctx)).toThrow(/non-finite value at index 7/);
  });

  it("accepts legitimate negative and zero components", () => {
    const v = vec(EXPECTED_EMBEDDING_DIMS);
    v[0] = -0.9;
    v[1] = 0;
    expect(() => assertUsableEmbedding(v, ctx)).not.toThrow();
  });

  it("names the model and content size so the error is actionable", () => {
    expect(() => assertUsableEmbedding([], { model: "some-model", contentBytes: 1234 }))
      .toThrow(/model=some-model, content_bytes=1234/);
  });

  it("honours an explicit expectedDims override", () => {
    expect(() => assertUsableEmbedding(vec(1536), { ...ctx, expectedDims: 1536 })).not.toThrow();
  });
});
