/**
 * Tag-line -> column parser. THE SINGLE SOURCE OF TRUTH for how a tag line maps
 * onto the `class` / `lesson` / `session` / `incorporated_into` / `duplicate_of`
 * columns added by migration 006.
 *
 * *** THE "SEMANTICALLY IDENTICAL TO THE M1 BACKFILL" CLAIM IS RETIRED (S281). ***
 * It was never wholly true and it is now deliberately false for `session`.
 *
 * What it got right: `class`, `lesson`, `incorporated_into` and `duplicate_of`
 * are still parsed exactly as the backfill parsed them, and the M1 census is
 * still pinned in the unit tests as fixtures. `parseTagLine` below is unchanged.
 *
 * What it always omitted: the backfill enforces `SESSION_MAX = 300` and this
 * parser deliberately refuses any upper bound (see RX_SESSION_* below -- a
 * constant like `n <= 300` is a silent expiry date). Two parsers, two upper
 * bounds, one claiming identity, for three sessions.
 *
 * What [HOFFA] changed at S281: `session` MEANS THE CAPTURE SESSION and is
 * DERIVED FROM `metadata.source`. The backfill's session values were scraped
 * from PROSE -- for a row whose line 1 is not a tag line it widened scope to
 * `lines[:6]` and ran a bare S-number regex over the headline, so it routinely
 * read a REFERENCED session ("Extends /S168", "Instances: S151") as the capture
 * session. Measured across the live corpus: 89 of 711 comparable rows (12.5%)
 * disagree with `metadata.source`. See `claude-workshop Tools/ob1-provenance/`.
 *
 * SESSION RESOLUTION IS FOUR TIERS (`resolveSession` below), and the ORDER is
 * the whole ruling:
 *   1. `metadata.source`   -- written by the capture; the only field that
 *                             actually means "when was this written".
 *   2. explicit `session:` / `datapoint:S` token on line 1  -- a FALLBACK, not
 *                             an override. It outranking source is what let an
 *                             INCORPORATION walk stamp its own number onto a
 *                             thought captured 107 sessions earlier (2bb380da:
 *                             created at S159, source S159, prose opens
 *                             "S159 --", tag line says `session:S266`). Source
 *                             winning makes flip-stamping STRUCTURALLY
 *                             impossible rather than a matter of authoring care.
 *   3. bare `S###` on line 1  -- RETAINED, against the letter of the ruling,
 *                             because measurement showed the ruling's target was
 *                             the BACKFILL's prose scraping, which has no runtime
 *                             equivalent. This tier only reads line 1, and can
 *                             now only fire when tiers 1 and 2 are both silent.
 *                             Deleting it would NULL 11 rows whose source is the
 *                             literal string "mcp" and whose tag line carries the
 *                             only correct session that exists for them.
 *   4. NULL -- the honest value for "not stated".
 *
 * SCOPE IS LINE 1 ONLY for every tag-line tier, and that is a deliberate
 * difference from the backfill. The backfill also looked at lines 2-6, because
 * 32 historical rows carried their tag line further down and it was repairing
 * them. (Those rows were repaired in the data at S281; 30 moved, 2 were prose
 * that merely CONTAINED `class:`.) At WRITE time that leniency would be harmful:
 * both tag-line readers were bound to `split_part(content, E'\n', 1)` when this
 * was written, so accepting a tag on line 3 would populate columns for a row
 * those readers could never see -- manufacturing new instances of the very
 * defect the backfill just repaired. Line 1 or nothing makes the miner's hard
 * constraint enforceable instead of aspirational.
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

// ─── Session resolution (S281) ───────────────────────────────────────

/**
 * `metadata.source` shapes live in the corpus, and the `s` is CASE-INSENSITIVE
 * on purpose: `cowork-s125`, `clawdferret-s130` and `duke-sched-probe-s111` are
 * as much a session reference as `clawdferret-S131`. A case-SENSITIVE match
 * loses 27 rows across 11 distinct sources for no reason anyone chose.
 *
 * Measured against the full source vocabulary before widening: the sources this
 * still refuses (`mcp`, `research-pointer-*`, `scheduled-task:*`,
 * `duke-finance-specialist-v1-firstfire`) genuinely name no session. Zero false
 * positives -- which is a fact about today's vocabulary, so re-measure before
 * widening it again rather than assuming it stays true.
 */
const RX_SOURCE_KW = /session-(\d{1,4})/i;
const RX_SOURCE_BARE = /(?<![A-Za-z0-9])s(\d{1,4})(?![0-9])/i;

/** Capture session from a free-text `metadata.source`. NULL = not stated. */
export function parseSourceSession(source?: string | null): number | null {
  if (!source) return null;
  for (const rx of [RX_SOURCE_KW, RX_SOURCE_BARE]) {
    const m = rx.exec(source);
    if (m) {
      const n = Number(m[1]);
      // Same lower bound and same refusal of an upper bound as parseTagLine.
      if (n >= 1) return n;
    }
  }
  return null;
}

/**
 * Tiers 2 and 3 kept apart, because their PRECEDENCE relative to source is the
 * same but their standing against each other is not: an explicit `session:` is
 * a declaration, a bare `S###` is an observation about the line's text.
 */
export function taglineSessionTiers(content: string): {
  explicit: number | null;
  bare: number | null;
} {
  const line1 = (content ?? "").split("\n", 1)[0] ?? "";
  if (!isTagLine(line1)) return { explicit: null, bare: null };

  let explicit: number | null = null;
  for (const rx of [RX_SESSION_KW, RX_SESSION_DP]) {
    const m = rx.exec(line1);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1) explicit = n;
      break;
    }
  }

  let bare: number | null = null;
  const mb = RX_SESSION_BARE.exec(line1);
  if (mb) {
    const n = Number(mb[1]);
    if (n >= 1) bare = n;
  }

  return { explicit, bare };
}

/**
 * THE RULED PRECEDENCE (S281): source, then an explicit token, then a bare
 * S-number on line 1, then NULL.
 *
 * *** THE TAG-LINE TOKEN IS A FALLBACK, NOT AN OVERRIDE. *** That inversion is
 * the entire point: while the token outranked source, an incorporation walk
 * that wrote `session:S266` into a tag line silently re-dated a thought captured
 * at S159, and no amount of authoring guidance could prevent the next one.
 * Source winning makes it impossible instead of discouraged.
 *
 * Consequence accepted with the ruling: an author can no longer correct a
 * wrong-but-parseable source by editing the tag line. The correction has to go
 * to `metadata.source`, which is the field that actually claims to know.
 */
export function resolveSession(
  source: string | null | undefined,
  content: string
): number | null {
  const fromSource = parseSourceSession(source);
  if (fromSource !== null) return fromSource;
  const t = taglineSessionTiers(content);
  return t.explicit ?? t.bare;
}
