/**
 * Unit tests for src/db/tagline.ts.
 *
 * The fixtures are not invented: most are REAL tag lines from the live corpus,
 * cited by their thought-id prefix, and the counts pinned in "M1 parity" are the
 * S278 backfill census. If a change to the parser breaks those, the runtime and
 * the 1,001 backfilled rows have diverged -- which is the failure this file
 * exists to make loud rather than discoverable months later.
 */

import { describe, it, expect } from "vitest";
import { parseTagLine, isTagLine, LESSON_VALUES, type LessonValue } from "../tagline.js";

describe("parseTagLine — the ruled lesson set", () => {
  it("is SIX values, not five and not seven ([HOFFA], S278)", () => {
    expect([...LESSON_VALUES]).toEqual([
      "open",
      "incorporated",
      "duplicate",
      "retired",
      "converted",
      "n/a",
    ]);
  });

  it.each(LESSON_VALUES)("accepts the ruled value %s", (v) => {
    expect(parseTagLine(`class:x lesson:${v} S278`).lesson).toBe(v);
  });

  it("folds the historical `obsolete` into `retired` (7 rows at M1)", () => {
    // real shape, c0ef7c67 / aca5c0fa / 2f3a337e
    const r = parseTagLine("tags: role:clawdferret, class:audit-quality, datapoint:1, lesson:obsolete");
    expect(r.lesson).toBe("retired");
    expect(r.class).toBe("audit-quality");
  });

  it("does NOT truncate `n/a` to `n` — the census bug that miscounted the enum", () => {
    // e5da54f7 / 370b2d7b — six of the eight n/a rows are class:ship-record,
    // a class deliberately outside the lesson lifecycle.
    expect(parseTagLine("tags: class:ship-record, session:S138, lesson:n/a").lesson).toBe("n/a");
  });

  it("leaves an UNRECOGNISED disposition NULL rather than guessing", () => {
    // 8bace702 and b08b3cae. Both were hand-ruled to `retired` by [HOFFA] at
    // S278 AFTER evidence; the parser must never make that call by itself.
    expect(parseTagLine("class:sandbox-mount-staleness session:S118 lesson:pending-promotion").lesson).toBeNull();
    expect(parseTagLine("class:session-init-load-channel session:S125 lesson:verified-refined").lesson).toBeNull();
  });

  it("never coerces an unknown disposition to `open`", () => {
    const r = parseTagLine("class:x lesson:banana");
    expect(r.lesson).not.toBe("open");
    expect(r.lesson).toBeNull();
  });
});

describe("parseTagLine — scope is LINE 1 ONLY", () => {
  it("ignores a tag line on line 3, because neither reader can see it", () => {
    const r = parseTagLine("a headline\n\nclass:instrument-honesty lesson:open S260");
    expect(r).toEqual({
      class: null,
      lesson: null,
      session: null,
      incorporated_into: null,
      duplicate_of_ref: null,
    });
  });

  it("reads a fused tag+headline line, which is the dominant live style", () => {
    const r = parseTagLine(
      "class:instrument-honesty lesson:incorporated S260 (2026-08-18) — A LIVE CREDENTIAL WAS ABSENT"
    );
    expect(r.class).toBe("instrument-honesty");
    expect(r.lesson).toBe("incorporated");
    expect(r.session).toBe(260);
  });

  it("returns all-null for content with no tag line at all (113 historical rows)", () => {
    expect(parseTagLine("just a body, no tags").class).toBeNull();
    expect(parseTagLine("").lesson).toBeNull();
  });

  it("isTagLine requires class: or lesson:, not merely `tags:`", () => {
    expect(isTagLine("tags: project:claude-workshop, kind:persona-lineage")).toBe(false);
    expect(isTagLine("tags: class:x")).toBe(true);
    expect(isTagLine("lesson:open")).toBe(true);
  });
});

describe("parseTagLine — session, and the three dialects", () => {
  it("prefers session:S<n> over datapoint:S<n> over a bare S<n>", () => {
    expect(parseTagLine("class:x session:S200 S999").session).toBe(200);
    expect(parseTagLine("class:x datapoint:S198 S999").session).toBe(198);
    expect(parseTagLine("class:x lesson:open S203").session).toBe(203);
  });

  it("accepts session:200 without the S", () => {
    expect(parseTagLine("class:x session:200").session).toBe(200);
  });

  it("rejects S0 — the real false positive, seen on 0ee214d2 / 2747d4ed", () => {
    expect(parseTagLine("class:x lesson:open S0").session).toBeNull();
  });

  it("*** has NO upper bound: a cap would be a silent expiry date ***", () => {
    // A `n <= 300` guard would start dropping real values at S301. The estate
    // has already recorded that failure class (OB1 5f6658e1); do not add one.
    expect(parseTagLine("class:x lesson:open S301").session).toBe(301);
    expect(parseTagLine("class:x lesson:open S1500").session).toBe(1500);
  });
});

describe("parseTagLine — incorporated_into is a WHERE, never a WHEN", () => {
  it("takes incorporated_into: first, the spelling the corpus converged on", () => {
    const r = parseTagLine(
      "class:instrument-honesty lesson:incorporated incorporated_into:Conventions/instrument-honesty.md S260"
    );
    expect(r.incorporated_into).toBe("Conventions/instrument-honesty.md");
  });

  it("falls back to incorporated: then landed:", () => {
    expect(parseTagLine("class:x lesson:incorporated incorporated:Skills/pm-system/SKILL.md").incorporated_into)
      .toBe("Skills/pm-system/SKILL.md");
    expect(parseTagLine("class:x lesson:incorporated landed:Conventions/closeout-procedure.md").incorporated_into)
      .toBe("Conventions/closeout-procedure.md");
  });

  it("*** REFUSES a session reference — landed:S275 means WHEN, not WHERE ***", () => {
    // fe5fda7d, 5eb38419 (landed:S275) and 96b8deeb, 03c8090d (incorporated:S188).
    // Same multiple-semantics rot that retired `datapoint:` at S204.
    expect(parseTagLine("class:tooling-gap lesson:incorporated landed:S275").incorporated_into).toBeNull();
    expect(parseTagLine("class:deploy-pin-rot lesson:incorporated incorporated:S188").incorporated_into).toBeNull();
  });

  it("accepts a bare filename — gather.py IS a location", () => {
    expect(parseTagLine("class:x lesson:incorporated landed:gather.py").incorporated_into).toBe("gather.py");
  });

  it("takes the path but truncates at a space, and that is accepted loss", () => {
    // 10 live `landed:` values carry a section anchor after a space. The tag
    // line survives as the rendered projection ([HOFFA], S278 C1), so the full
    // text is retained even though the column holds only the path.
    const r = parseTagLine("class:x lesson:incorporated landed:Conventions/a.md §Heritage extra words");
    expect(r.incorporated_into).toBe("Conventions/a.md");
  });
});

describe("parseTagLine — duplicate_of", () => {
  it("reads the canonical duplicate-of: spelling (29 live rows)", () => {
    const r = parseTagLine("class:seam-integrity dp:1 lesson:duplicate duplicate-of:f3c36588 S155");
    expect(r.duplicate_of_ref).toBe("f3c36588");
    expect(r.lesson).toBe("duplicate");
  });

  it("reads the forked dup-of: alias (1 live row)", () => {
    expect(parseTagLine("class:x lesson:duplicate dup-of:468bf0cd").duplicate_of_ref).toBe("468bf0cd");
  });

  it("returns the RAW ref — resolution to a uuid needs the DB, not the parser", () => {
    const r = parseTagLine("class:x lesson:duplicate duplicate-of:44ee5faf");
    expect(r.duplicate_of_ref).toBe("44ee5faf");
    expect(r).not.toHaveProperty("duplicate_of");
  });
});

describe("parseTagLine — M1 parity on real corpus lines", () => {
  // Each fixture is a real live tag line; the expectation is what the S278
  // backfill wrote for that row. Divergence here means the runtime and the
  // 1,001 backfilled rows disagree.
  const CASES: Array<[string, string, Partial<Record<string, unknown>>]> = [
    [
      "d341e36d",
      "class:instrument-honesty lesson:incorporated incorporated_into:Conventions/instrument-honesty.md-ShapeB S260 (2026-08-18/19) — A LIVE CREDENTIAL WAS ABSENT FROM THE LEDGER",
      { class: "instrument-honesty", lesson: "incorporated", session: 260 },
    ],
    [
      "f659396d",
      "class:seam-integrity dp:1 lesson:duplicate duplicate-of:f3c36588 S155 — A DECLARATION LANGUAGE CAN OUTGROW ITS ENFORCEMENT ENGINE",
      { class: "seam-integrity", lesson: "duplicate", session: 155, duplicate_of_ref: "f3c36588" },
    ],
    [
      "96b8deeb",
      "tags: role:clawdferret, class:deploy-pin-rot, datapoint:4, lesson:incorporated, session:S177, incorporated:S188",
      { class: "deploy-pin-rot", lesson: "incorporated", session: 177, incorporated_into: null },
    ],
    [
      "2f3a337e",
      "tags: role:clawdferret, class:cowork-topology-schema-cache, datapoint:2, lesson:obsolete",
      { class: "cowork-topology-schema-cache", lesson: "retired", session: null },
    ],
  ];

  it.each(CASES)("%s parses as the backfill wrote it", (_id, line, expected) => {
    const got = parseTagLine(line) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected)) {
      expect(got[k]).toEqual(v);
    }
  });
});

describe("parseTagLine — totality", () => {
  it("never throws, whatever it is handed", () => {
    const nasty = [
      "",
      "\n\n\n",
      "class:",
      "lesson:",
      "class:x lesson:",
      "duplicate-of:",
      "class:x session:S",
      "🦦 class:x lesson:open S1",
      "class:x ".repeat(500),
    ];
    for (const s of nasty) expect(() => parseTagLine(s)).not.toThrow();
  });

  it("a parsed lesson is always a member of the ruled set or null", () => {
    const samples = ["lesson:open", "lesson:obsolete", "lesson:banana", "lesson:n/a", "class:x"];
    for (const s of samples) {
      const v = parseTagLine(`class:c ${s}`).lesson;
      if (v !== null) expect(LESSON_VALUES).toContain(v as LessonValue);
    }
  });
});
