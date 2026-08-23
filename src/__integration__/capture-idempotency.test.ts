/**
 * Capture idempotency — integration tests against a real Postgres.
 *
 * These exist because the unit tests mock the pool and therefore prove only that the
 * routes call the right function. The defect being fixed lives in the DATABASE
 * interaction, so it can only be proven here.
 *
 * Every "it dedups" assertion is paired with a control that makes dedup NOT fire.
 * Without those, a dedup that swallowed everything unconditionally would pass just as
 * cleanly as a correct one -- which is the failure class this repo keeps finding.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  captureThought,
  captureThoughts,
  contentHash,
  DEDUP_WINDOW_MINUTES,
} from "../db/queries.js";

const pool = new Pool({
  host: process.env.DB_HOST_TEST ?? process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "openbrain",
  password: process.env.DB_PASSWORD ?? "changeme",
  database: process.env.DB_NAME ?? "openbrain",
});

const EMB = () => Array.from({ length: 768 }, () => 0.01);
let tag: string;

async function countMatching(text: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM thoughts WHERE content = $1",
    [text]
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  for (const f of [
    "db/init.sql",
    "db/migrations/001-dev-ready-upgrade.sql",
    "db/migrations/002-add-created-by.sql",
    "db/migrations/003-add-provenance-helpers.sql",
    "db/migrations/004-capture-idempotency.sql",
  ]) {
    await pool.query(readFileSync(join(process.cwd(), f), "utf8"));
  }
});

beforeEach(() => {
  tag = randomUUID();
});

afterAll(async () => {
  await pool.query("DELETE FROM thoughts WHERE content LIKE '__idem_test_%'");
  await pool.end();
});

describe("content_hash generated column", () => {
  it("matches an independently computed sha256", async () => {
    const text = `__idem_test_hash_${tag}`;
    const { row } = await captureThought(pool, text, EMB(), {});
    const { rows } = await pool.query<{ content_hash: string }>(
      "SELECT content_hash FROM thoughts WHERE id = $1",
      [row.id]
    );
    expect(rows[0]!.content_hash).toBe(contentHash(text));
  });
});

describe("captureThought dedup", () => {
  it("collapses an immediate retry of identical content onto the original row", async () => {
    const text = `__idem_test_retry_${tag}`;

    const first = await captureThought(pool, text, EMB(), { type: "observation" });
    const retry = await captureThought(pool, text, EMB(), { type: "observation" });

    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.row.id).toBe(first.row.id);
    expect(await countMatching(text)).toBe(1);
  });

  // ── CONTROL: the mechanism must be able to NOT fire ──────────────

  it("CONTROL: different content is never deduplicated", async () => {
    const a = `__idem_test_diff_a_${tag}`;
    const b = `__idem_test_diff_b_${tag}`;

    const first = await captureThought(pool, a, EMB(), {});
    const second = await captureThought(pool, b, EMB(), {});

    expect(second.deduplicated).toBe(false);
    expect(second.row.id).not.toBe(first.row.id);
  });

  it("CONTROL: identical content OUTSIDE the window is a new row (window is real)", async () => {
    const text = `__idem_test_window_${tag}`;

    const first = await captureThought(pool, text, EMB(), {});
    // Window 0 = "nothing is recent enough", the boundary case of an elapsed window.
    const later = await captureThought(pool, text, EMB(), {}, undefined, undefined, undefined, {
      dedupWindowMinutes: 0,
    });

    expect(later.deduplicated).toBe(false);
    expect(later.row.id).not.toBe(first.row.id);
    expect(await countMatching(text)).toBe(2);
  });

  it("CONTROL: identical content in a DIFFERENT project is a new row (scope is real)", async () => {
    const text = `__idem_test_scope_${tag}`;

    const first = await captureThought(pool, text, EMB(), {}, "project-a");
    const other = await captureThought(pool, text, EMB(), {}, "project-b");

    expect(other.deduplicated).toBe(false);
    expect(other.row.id).not.toBe(first.row.id);
  });

  // ── The NULL case: `=` would silently never match here ───────────

  it("dedups unscoped rows, where project and created_by are NULL", async () => {
    const text = `__idem_test_nulls_${tag}`;

    const first = await captureThought(pool, text, EMB(), {});
    const retry = await captureThought(pool, text, EMB(), {});

    expect(retry.deduplicated).toBe(true);
    expect(retry.row.id).toBe(first.row.id);
    expect(await countMatching(text)).toBe(1);
  });

  it("honours a client-supplied idempotency key even outside the window", async () => {
    const key = `__idem_key_${tag}`;
    const a = `__idem_test_key_a_${tag}`;
    const b = `__idem_test_key_b_${tag}`;

    const first = await captureThought(pool, a, EMB(), {}, undefined, undefined, undefined, {
      idempotencyKey: key,
    });
    // Different content AND window disabled: only the key can collapse these.
    const second = await captureThought(pool, b, EMB(), {}, undefined, undefined, undefined, {
      idempotencyKey: key,
      dedupWindowMinutes: 0,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(await countMatching(b)).toBe(0);
  });
});

describe("captureThoughts batch dedup", () => {
  it("collapses a wholesale batch retry — the measured S275 shape", async () => {
    const items = [1, 2, 3].map((n) => ({
      content: `__idem_test_batch_${n}_${tag}`,
      embedding: EMB(),
      metadata: {},
    }));

    const first = await captureThoughts(pool, items);
    const retry = await captureThoughts(pool, items);

    expect(first.every((r) => !r.deduplicated)).toBe(true);
    expect(retry.every((r) => r.deduplicated)).toBe(true);
    expect(retry.map((r) => r.row.id)).toEqual(first.map((r) => r.row.id));

    for (const item of items) {
      expect(await countMatching(item.content)).toBe(1);
    }
  });

  it("converges a PARTIALLY landed batch instead of duplicating what already exists", async () => {
    const shared = { embedding: EMB(), metadata: {} };
    const landed = { content: `__idem_test_partial_a_${tag}`, ...shared };
    const fresh = { content: `__idem_test_partial_b_${tag}`, ...shared };

    const partial = await captureThoughts(pool, [landed]);
    const full = await captureThoughts(pool, [landed, fresh]);

    expect(full[0]!.deduplicated).toBe(true);
    expect(full[0]!.row.id).toBe(partial[0]!.row.id);
    expect(full[1]!.deduplicated).toBe(false);
    expect(await countMatching(landed.content)).toBe(1);
    expect(await countMatching(fresh.content)).toBe(1);
  });
});

describe("window policy", () => {
  it("is wide enough for the longest measured retry gap (98s at S275)", () => {
    expect(DEDUP_WINDOW_MINUTES * 60).toBeGreaterThan(98);
  });
});
