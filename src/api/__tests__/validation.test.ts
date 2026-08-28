/**
 * Tests for the strict-ingest mode + warning helpers added in v0.7.2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  formatWarnings,
  logWarnings,
  isStrictIngestEnabled,
} from "../validation.js";

describe("validation: strict ingest mode", () => {
  const opts = { defaultSource: "test" };

  it("accepts unknown fields with a warning when strict is off", () => {
    const result = validateCaptureInput(
      { content: "hello", source: "test", _v: 1, totally_bogus: "x" },
      { ...opts, strict: false },
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]!.reason).toBe("unknown_field");
    expect(result.warnings[1]!.reason).toBe("unknown_field");
  });

  it("throws on unknown fields when strict is on", () => {
    expect(() =>
      validateCaptureInput({ content: "hello", _v: 1 }, { ...opts, strict: true }),
    ).toThrow(CaptureValidationError);
  });

  it("throws on deprecated top-level fields when strict is on", () => {
    expect(() =>
      validateCaptureInput(
        { content: "hello", type: "decision" },
        { ...opts, strict: true },
      ),
    ).toThrow(/deprecated/);
  });

  it("throws on bad metadata type when strict is on", () => {
    expect(() =>
      validateCaptureInput(
        { content: "hello", metadata: "not-an-object" },
        { ...opts, strict: true },
      ),
    ).toThrow(/metadata/);
  });

  it("escalates batch envelope warnings when strict is on", () => {
    expect(() =>
      validateBatchInput(
        { thoughts: [{ content: "x" }], bogus_envelope_key: true },
        { ...opts, strict: true },
      ),
    ).toThrow(/bogus_envelope_key/);
  });

  it("escalates per-item warnings when strict is on", () => {
    expect(() =>
      validateBatchInput(
        { thoughts: [{ content: "ok" }, { content: "bad", _v: 1 }] },
        { ...opts, strict: true },
      ),
    ).toThrow(CaptureValidationError);
  });

  it("respects OPENBRAIN_STRICT_INGEST env var when option omitted", () => {
    const old = process.env.OPENBRAIN_STRICT_INGEST;
    try {
      process.env.OPENBRAIN_STRICT_INGEST = "true";
      expect(isStrictIngestEnabled()).toBe(true);
      expect(() =>
        validateCaptureInput({ content: "hello", _v: 1 }, opts),
      ).toThrow(CaptureValidationError);

      process.env.OPENBRAIN_STRICT_INGEST = "false";
      expect(isStrictIngestEnabled()).toBe(false);
      const result = validateCaptureInput({ content: "hello", source: "test", _v: 1 }, opts);
      expect(result.warnings).toHaveLength(1);

      delete process.env.OPENBRAIN_STRICT_INGEST;
      expect(isStrictIngestEnabled()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.OPENBRAIN_STRICT_INGEST;
      else process.env.OPENBRAIN_STRICT_INGEST = old;
    }
  });

  it("explicit strict:false overrides env strict:true", () => {
    const old = process.env.OPENBRAIN_STRICT_INGEST;
    try {
      process.env.OPENBRAIN_STRICT_INGEST = "true";
      const result = validateCaptureInput(
        { content: "hello", source: "test", _v: 1 },
        { ...opts, strict: false },
      );
      expect(result.warnings).toHaveLength(1);
    } finally {
      if (old === undefined) delete process.env.OPENBRAIN_STRICT_INGEST;
      else process.env.OPENBRAIN_STRICT_INGEST = old;
    }
  });
});

describe("validation: formatWarnings", () => {
  it("returns empty string for no warnings", () => {
    expect(formatWarnings([])).toBe("");
  });

  it("renders one warning with reason, field, message, suggestion", () => {
    const out = formatWarnings([
      {
        field: "_v",
        reason: "unknown_field",
        message: "'_v' was ignored.",
        suggestion: "Nest it under metadata.",
      },
    ]);
    expect(out).toContain("1 issue");
    expect(out).toContain("[unknown_field]");
    expect(out).toContain("'_v'");
    expect(out).toContain("Nest it under metadata.");
  });

  it("pluralises and lists multiple warnings", () => {
    const out = formatWarnings([
      { field: "a", reason: "unknown_field", message: "x" },
      { field: "b", reason: "deprecated_top_level", message: "y" },
    ]);
    expect(out).toContain("2 issues");
    expect(out).toContain("'a'");
    expect(out).toContain("'b'");
  });
});

describe("validation: logWarnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits one [ingest-warning] line per warning with caller context", () => {
    logWarnings(
      [
        { field: "_v", reason: "unknown_field", message: "ignored" },
        { field: "type", reason: "deprecated_top_level", message: "moved" },
      ],
      { transport: "mcp", source: "plan-forge", project: "pf", created_by: "scott" },
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const first = warnSpy.mock.calls[0][0] as string;
    expect(first).toMatch(/^\[ingest-warning\] /);
    const payload = JSON.parse(first.replace(/^\[ingest-warning\] /, ""));
    expect(payload).toMatchObject({
      transport: "mcp",
      source: "plan-forge",
      project: "pf",
      created_by: "scott",
      field: "_v",
      reason: "unknown_field",
    });
  });

  it("emits nothing when warnings array is empty", () => {
    logWarnings([], { transport: "rest", source: "api" });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("validation: embedding truncation warning", () => {
  const opts = { defaultSource: "test", strict: false };
  const SAFE = 6000;

  beforeEach(() => {
    delete process.env.OPENBRAIN_EMBED_SAFE_BYTES;
  });

  it("does not warn when content is at or below the safe ceiling", () => {
    const result = validateCaptureInput({ content: "x".repeat(SAFE), source: "test" }, opts);
    expect(result.warnings).toHaveLength(0);
    expect(result.metadata.embedding_truncated).toBeUndefined();
    expect(result.metadata.embedding_indexed_bytes).toBeUndefined();
  });

  it("warns and tags metadata when content exceeds the safe ceiling", () => {
    const big = "x".repeat(SAFE + 500);
    const result = validateCaptureInput({ content: big, source: "test" }, opts);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.reason).toBe("embedding_truncated");
    expect(result.warnings[0]!.field).toBe("content");
    expect(result.warnings[0]!.message).toMatch(/6500 bytes/);
    expect(result.metadata.embedding_truncated).toBe(true);
    expect(result.metadata.embedding_indexed_bytes).toBe(SAFE);
    expect(result.metadata.content_bytes).toBe(SAFE + 500);
  });

  it("never escalates the truncation warning under strict mode", () => {
    const big = "x".repeat(SAFE + 1);
    const result = validateCaptureInput({ content: big, source: "test" }, { defaultSource: "test", strict: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.reason).toBe("embedding_truncated");
  });

  it("honours OPENBRAIN_EMBED_SAFE_BYTES override", () => {
    process.env.OPENBRAIN_EMBED_SAFE_BYTES = "100";
    const result = validateCaptureInput({ content: "x".repeat(200), source: "test" }, opts);
    expect(result.warnings).toHaveLength(1);
    expect(result.metadata.embedding_indexed_bytes).toBe(100);
    expect(result.metadata.content_bytes).toBe(200);
  });
});

describe("validation: default-source warning (S291)", () => {
  const opts = { defaultSource: "mcp" };
  const dsw = (ws: { reason: string }[]) =>
    ws.filter((w) => w.reason === "default_source_used");

  it("warns when the caller omits source", () => {
    const r = validateCaptureInput({ content: "hello" }, opts);
    expect(dsw(r.warnings)).toHaveLength(1);
    expect(r.warnings[0]!.field).toBe("source");
    expect(r.warnings[0]!.message).toContain("mcp");
    expect(r.source).toBe("mcp");
  });

  it("stays silent when the caller supplies a source", () => {
    const r = validateCaptureInput(
      { content: "hello", source: "session-291-clawdferret" },
      opts,
    );
    expect(dsw(r.warnings)).toHaveLength(0);
    expect(r.source).toBe("session-291-clawdferret");
  });

  // *** THE BRANCH THAT WOULD HAVE SILENTLY STAYED BROKEN. ***
  // validateBatchInput always writes a resolved `source` into the object it
  // hands to validateCaptureInput, so a naive `body.source === undefined`
  // check is ALWAYS false here. Without the sourceWasDefaulted flag the fix
  // would cover single captures only -- i.e. miss the bulk path a close-out
  // uses -- while every single-capture test above still passed.
  it("warns on EVERY batch item when no source is stated anywhere", () => {
    const b = validateBatchInput(
      { thoughts: [{ content: "a" }, { content: "b" }, { content: "c" }] },
      opts,
    );
    expect(b.items).toHaveLength(3);
    for (const item of b.items) {
      expect(dsw(item.warnings)).toHaveLength(1);
      expect(item.source).toBe("mcp");
    }
  });

  it("stays silent on batch items when the ENVELOPE supplies a source", () => {
    const b = validateBatchInput(
      { source: "session-291-clawdferret", thoughts: [{ content: "a" }, { content: "b" }] },
      opts,
    );
    for (const item of b.items) {
      expect(dsw(item.warnings)).toHaveLength(0);
      expect(item.source).toBe("session-291-clawdferret");
    }
  });

  it("judges each batch item separately when only SOME state a source", () => {
    const b = validateBatchInput(
      { thoughts: [{ content: "a" }, { content: "b", source: "session-291-clawdferret" }] },
      opts,
    );
    expect(dsw(b.items[0]!.warnings)).toHaveLength(1);   // inherited the default
    expect(dsw(b.items[1]!.warnings)).toHaveLength(0);   // stated its own
    expect(b.items[1]!.source).toBe("session-291-clawdferret");
  });

  // Deliberate: `source` is OPTIONAL with a documented default, so escalating
  // would redefine it as MANDATORY under strict ingest -- an API contract
  // change, not a warning. Same treatment as embedding_truncated.
  it("never escalates under strict mode", () => {
    const r = validateCaptureInput({ content: "hello" }, { ...opts, strict: true });
    expect(dsw(r.warnings)).toHaveLength(1);
  });
});
