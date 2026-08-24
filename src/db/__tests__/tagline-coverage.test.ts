/**
 * SOURCE-LEVEL COVERAGE GUARD for the tag-line columns.
 *
 * The dual-write touches FIVE write paths (insertThought, batchInsertThoughts,
 * captureThought, captureThoughts, updateThought). Five sites is exactly the
 * shape where a sixth gets added later and quietly writes NULLs — the columns
 * would then be right for most rows and wrong for whatever the new path
 * inserted, which is worse than being wrong everywhere because nothing looks
 * broken.
 *
 * A checklist in a doc cannot catch that. This reads the source and fails.
 * (Same idiom as claude-workshop task_1787400000010, "the funeral has a LIST of
 * docs to update and NO WAY TO KNOW IT GOT THEM ALL".)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "queries.ts"),
  "utf8"
);

const TAGLINE_COLUMNS = ["class", "lesson", "session", "incorporated_into", "duplicate_of"];

/** Every `INSERT INTO thoughts (...)` column list in the file. */
function insertColumnLists(): string[] {
  return [...SRC.matchAll(/INSERT INTO thoughts\s*\(([^)]*)\)/g)].map((m) => m[1]!);
}

/** Every `UPDATE thoughts SET ...` clause, up to the WHERE. */
function updateSetClauses(): string[] {
  return [...SRC.matchAll(/UPDATE thoughts\s+SET\s+([\s\S]*?)\s+WHERE/g)].map((m) => m[1]!);
}

/**
 * The columns are a PROJECTION OF `content`, so the obligation follows content:
 * a write that changes content must recompute them, and a write that does not
 * touch content must not be required to. `deleteThought` clears `supersedes`
 * references without touching content and is correctly exempt.
 *
 * This distinction was not designed in — the guard's FIRST RUN flagged that
 * exempt UPDATE, which is the detector earning its place before it had ever
 * guarded anything.
 */
function contentTouchingUpdates(): string[] {
  return updateSetClauses().filter((c) => /\bcontent\s*=/.test(c));
}

describe("tag-line column coverage across every write path", () => {
  // *** THE LOAD-BEARING ASSERTION. *** Without it the tests below pass
  // vacuously if a refactor stops the regex matching: "every INSERT includes
  // the columns" is trivially true of zero INSERTs. An instrument that cannot
  // go red is not an instrument.
  it("finds the write paths at all (guards against a vacuous pass)", () => {
    expect(insertColumnLists().length).toBe(4);
    expect(contentTouchingUpdates().length).toBe(1);
    // Pinned so that a NEW non-content UPDATE is noticed and consciously
    // classified, rather than silently joining the exempt set.
    expect(updateSetClauses().length).toBe(2);
  });

  it.each([
    ["INSERT", insertColumnLists],
    ["content-touching UPDATE", contentTouchingUpdates],
  ])("every %s path writes all five tag-line columns", (_kind, getter) => {
    for (const clause of getter()) {
      const resolved = clause.includes("${TAGLINE_COLS}")
        ? clause.replace("${TAGLINE_COLS}", TAGLINE_COLUMNS.join(", "))
        : clause;
      for (const col of TAGLINE_COLUMNS) {
        expect(
          new RegExp(`\\b${col}\\b`).test(resolved),
          `a write path omits the '${col}' column:\n  ${clause.trim().slice(0, 200)}`
        ).toBe(true);
      }
    }
  });

  it("RETURNING_COLS surfaces the columns, so callers can read them back", () => {
    const m = /const RETURNING_COLS =\s*([\s\S]*?);/.exec(SRC);
    expect(m, "RETURNING_COLS not found — did it get renamed?").not.toBeNull();
    for (const col of TAGLINE_COLUMNS) {
      expect(m![1]!).toContain(col);
    }
  });

  it("the parser is imported from ONE module, never re-implemented inline", () => {
    expect(SRC).toContain('from "./tagline.js"');
    // A second copy of the regexes here would drift from the S278 backfill
    // without anything noticing, which is the whole failure mode.
    expect(SRC).not.toMatch(/\\blesson:\(\[a-z/);
  });
});
