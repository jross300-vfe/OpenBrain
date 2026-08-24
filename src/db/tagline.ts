/**
 * Tag-line -> column parser. THE SINGLE SOURCE OF TRUTH for how a tag line maps
 * onto the `class` / `lesson` / `session` / `incorporated_into` / `duplicate_of`
 * columns added by migration 006.
 *
 * *** THIS MUST STAY SEMANTICALLY IDENTICAL TO THE S278 M1 BACKFILL. *** The
 * backfill parsed 1,001 historical rows into these columns; if the runtime
 * parser disagrees, the corpus silently splits into "rows written before E2" and
 * "rows written after", which is exactly the divergence the columns exist to end.
 * The M1 census is pinned in the unit tests as fixtures.
 *
 * SCOPE IS LINE 1 ONLY, and that is a deliberate difference from the backfill.
 * The backfill also looked at lines 2-6, because 32 historical rows carry their
 * tag line further down and it was repairing them. At WRITE time that leniency
 * would be harmful: both tag-line readers (`build-reflection-classes.mjs` and
 * `tags_contain`) are bound to `split_part(content, E'\n', 1)`, so accepting a
 * tag on line 3 would populate columns for a row those readers can never see --
 * manufacturing new instances of the very defect the backfill just repaired.
 * Line 1 or nothing makes the miner's hard constraint enforceable instead of
 * aspirational.
 */

/** The six ruled dispositions ([HOFFA], S278). NOT five, and NOT seven. */
export const LESSON_VALUES = [
  "open",
  "incorporated",
  "duplicate",
  "retired",
  "converted",
  "n/a",
] as const;

export type LessonValue = (typeof LESSON_VALUES)[number];

/**
 * Historical dispositions that fold into a ruled one rather than being dropped.
 * `obsolete` was in live use until 2026-06-23 and means what `retired` means.
 * [HOFFA] ruled the mapping at S278; 7 rows were folded by the M1 backfill.
 */
const LESSON_ALIASES: Record<string, LessonValue> = { obsolete: "retired" };

const RX_CLASS = /\bclass:([a-z0-9-]+)/;
/**
 * The full token, NOT `[a-z]+`. The S278 census used `lesson:([a-z]+)` and it
 * truncated `n/a` -> `n`, `pending-promotion` -> `pending` and
 * `verified-refined` -> `verified` -- manufacturing three phantom values and
 * causing the enum to be miscounted for the fourth time in 74 sessions. A
 * truncating parser does not report a smaller answer; it reports a WRONG one.
 */
const RX_LESSON = /\blesson:([a-z][a-z/-]*)/;
const RX_SESSION_KW = /\bsession:S?(\d{1,4})/;
const RX_SESSION_DP = /\bdatapoint:S(\d{1,4})/;
const RX_SESSION_BARE = /(?<![A-Za-z0-9])S(\d{1,4})(?![0-9])/;
/** Dominant spelling first: the corpus converged on the column name itself. */
const RX_INCORPORATED: RegExp[] = [
  /\bincorporated_into:(\S+)/,
  /\bincorporated:(\S+)/,
  /\blanded:(\S+)/,
];
const RX_DUP: RegExp[] = [/\bduplicate-of:([0-9a-f]{4,36})/, /\bdup-of:([0-9a-f]{4,36})/];
/** `landed:S275` means WHEN it landed, not WHERE. See isLocationLike. */
const RX_SESSION_REF = /^S\d{1,4}$/;

export interface TagLineColumns {
  class: string | null;
  lesson: LessonValue | null;
  session: number | null;
  incorporated_into: string | null;
  /** The raw reference as written (an 8-char id prefix). Resolution needs the DB. */
  duplicate_of_ref: string | null;
}

export const EMPTY_TAGLINE_COLUMNS: TagLineColumns = {
  class: null,
  lesson: null,
  session: null,
  incorporated_into: null,
  duplicate_of_ref: null,
};

/** A line is a tag line only if it carries `class:` or `lesson:`. */
export function isTagLine(line: string): boolean {
  return line.includes("class:") || line.includes("lesson:");
}

/**
 * `incorporated_into` answers WHERE a lesson landed. Four live rows feed it a
 * session number instead (`landed:S275`, `incorporated:S188`) -- the same
 * multiple-semantics rot that retired `datapoint:` at S204 for carrying a count,
 * a session id and a bare marker at once. A WHEN in a WHERE column is a type
 * error that only becomes visible once the value has a column, so it is refused
 * here rather than stored and puzzled over later.
 */
function isLocationLike(v: string): boolean {
  if (RX_SESSION_REF.test(v)) return false;
  return v.includes("/") || v.includes(".") || v.includes("#");
}

/**
 * Parse line 1 of `content` into column values. Pure, total, and never throws:
 * an unparseable tag line yields nulls, because a capture must not fail on the
 * shape of its own annotation. NULL is the honest value for "not stated".
 */
export function parseTagLine(content: string): TagLineColumns {
  const line1 = (content ?? "").split("\n", 1)[0] ?? "";
  if (!isTagLine(line1)) return { ...EMPTY_TAGLINE_COLUMNS };

  const out: TagLineColumns = { ...EMPTY_TAGLINE_COLUMNS };

  const mClass = RX_CLASS.exec(line1);
  if (mClass) out.class = mClass[1]!;

  const mLesson = RX_LESSON.exec(line1);
  if (mLesson) {
    const raw = mLesson[1]!;
    const mapped = (LESSON_VALUES as readonly string[]).includes(raw)
      ? (raw as LessonValue)
      : LESSON_ALIASES[raw];
    // An unrecognised disposition stays NULL. It is NOT coerced to `open`:
    // inventing a value is the fabrication the CHECK constraint exists to
    // refuse, and a NULL is findable while a wrong guess is not.
    if (mapped) out.lesson = mapped;
  }

  for (const rx of [RX_SESSION_KW, RX_SESSION_DP, RX_SESSION_BARE]) {
    const m = rx.exec(line1);
    if (m) {
      const n = Number(m[1]);
      // Lower bound only. There is deliberately NO upper bound tied to the
      // current session number: a constant like `n <= 300` is a silent expiry
      // date that would start dropping real values at S301, which is the
      // hardcoded-limit failure this estate has already recorded (OB1 5f6658e1).
      // `S0` is the real false positive and is what this rejects.
      if (n >= 1) out.session = n;
      break;
    }
  }

  for (const rx of RX_INCORPORATED) {
    const m = rx.exec(line1);
    if (m) {
      if (isLocationLike(m[1]!)) out.incorporated_into = m[1]!;
      break;
    }
  }

  for (const rx of RX_DUP) {
    const m = rx.exec(line1);
    if (m) {
      out.duplicate_of_ref = m[1]!;
      break;
    }
  }

  return out;
}
