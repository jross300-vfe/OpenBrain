import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-expect-error — pforge-sdk is an untyped .mjs package
import { buildProvenance } from 'pforge-sdk/hallmark';

const pool = new Pool({
  host: process.env.DB_HOST_TEST ?? process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'openbrain',
  password: process.env.DB_PASSWORD ?? 'changeme',
  database: process.env.DB_NAME ?? 'openbrain',
});

const SENTINEL = `__test_slice2_${randomUUID()}`;

beforeAll(async () => {
  for (const f of [
    'db/init.sql',
    'db/migrations/001-dev-ready-upgrade.sql',
    'db/migrations/002-add-created-by.sql',
    'db/migrations/003-add-provenance-helpers.sql',
  ]) {
    await pool.query(readFileSync(join(process.cwd(), f), 'utf8'));
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE project LIKE '__test_slice2_%'`);
  await pool.end();
});

describe('Migration 003 — provenance helpers', () => {
  it('1: generated columns exist', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_name = 'thoughts'
        AND column_name IN ('source_file_hash', 'code_hash')
      ORDER BY column_name
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.is_generated).toBe('ALWAYS');
      expect(row.generation_expression).toContain('provenance');
    }
  });

  it('2: partial indexes exist', async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'thoughts'
        AND indexname IN ('idx_thoughts_source_file_hash', 'idx_thoughts_code_hash')
      ORDER BY indexname
    `);
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual([
      'idx_thoughts_code_hash',
      'idx_thoughts_source_file_hash',
    ]);
  });

  it('3: match_thoughts_by_source signature', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'match_thoughts_by_source'
        AND n.nspname = 'public'
    `);
    expect(rows).toHaveLength(1);
    const args: string = rows[0].args;
    expect(args).toContain('source_hash text');
    expect(args).toContain('max_count integer');
    expect(args).toContain('project_filter text');
    expect(args).toContain('include_archived boolean');
  });

  it('4: null provenance → null helpers', async () => {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('null-prov test', '{}'::jsonb, $1)
       RETURNING source_file_hash, code_hash`,
      [SENTINEL],
    );
    expect(rows[0].source_file_hash).toBeNull();
    expect(rows[0].code_hash).toBeNull();
  });

  it('5: populated provenance → populated helpers', async () => {
    const meta = {
      provenance: { contentHash: 'abc123', codeHash: 'def456' },
    };
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('prov test', $1::jsonb, $2)
       RETURNING source_file_hash, code_hash`,
      [JSON.stringify(meta), SENTINEL],
    );
    expect(rows[0].source_file_hash).toBe('abc123');
    expect(rows[0].code_hash).toBe('def456');
  });

  it('6: RPC lookup by source hash', async () => {
    const hash = `lookup_${randomUUID()}`;
    await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('match me', $1::jsonb, $2)`,
      [JSON.stringify({ provenance: { contentHash: hash } }), SENTINEL],
    );
    await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('no match', '{"provenance":{"contentHash":"other"}}'::jsonb, $1)`,
      [SENTINEL],
    );
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, NULL, false)`,
      [hash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('match me');
  });

  it('7: RPC project_filter scopes', async () => {
    const hash = `proj_${randomUUID()}`;
    const projA = `${SENTINEL}_A`;
    const projB = `${SENTINEL}_B`;
    const meta = JSON.stringify({ provenance: { contentHash: hash } });

    await pool.query(
      `INSERT INTO thoughts (content, metadata, project) VALUES ('A', $1::jsonb, $2)`,
      [meta, projA],
    );
    await pool.query(
      `INSERT INTO thoughts (content, metadata, project) VALUES ('B', $1::jsonb, $2)`,
      [meta, projB],
    );

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, $2, false)`,
      [hash, projA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe(projA);
  });

  it('8: RPC excludes archived by default', async () => {
    const hash = `arch_${randomUUID()}`;
    const meta = JSON.stringify({ provenance: { contentHash: hash } });

    const { rows: inserted } = await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('live', $1::jsonb, $2), ('dead', $1::jsonb, $2)
       RETURNING id`,
      [meta, SENTINEL],
    );
    await pool.query(`UPDATE thoughts SET archived = true WHERE id = $1`, [
      inserted[1].id,
    ]);

    const { rows: defaultRows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, NULL, false)`,
      [hash],
    );
    expect(defaultRows).toHaveLength(1);

    const { rows: allRows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, NULL, true)`,
      [hash],
    );
    expect(allRows).toHaveLength(2);
  });

  it('9: RPC ordered by created_at DESC', async () => {
    const hash = `order_${randomUUID()}`;
    const meta = JSON.stringify({ provenance: { contentHash: hash } });

    await pool.query(
      `INSERT INTO thoughts (content, metadata, project, created_at)
       VALUES ('older', $1::jsonb, $2, '2020-01-01T00:00:00Z')`,
      [meta, SENTINEL],
    );
    await pool.query(
      `INSERT INTO thoughts (content, metadata, project, created_at)
       VALUES ('newer', $1::jsonb, $2, '2025-01-01T00:00:00Z')`,
      [meta, SENTINEL],
    );

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, NULL, false)`,
      [hash],
    );
    expect(rows[0].content).toBe('newer');
    expect(rows[1].content).toBe('older');
  });

  it('10: hallmark round-trip', async () => {
    const prov = buildProvenance({
      toolName: 'test-slice2',
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    const meta = { provenance: prov };

    await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ('hallmark test', $1::jsonb, $2)`,
      [JSON.stringify(meta), SENTINEL],
    );

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, NULL, false)`,
      [prov.contentHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hallmark test');
  });

  it('11: regression — match_thoughts still exists', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'match_thoughts'
        AND n.nspname = 'public'
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('updateThought — provenance preservation (clobber regression, S90 class:openbrain-update-provenance-loss)', () => {
  const EMBEDDING = Array(768).fill(0.001);

  async function insertWithProvenance(content: string) {
    const meta = {
      type: 'observation',
      topics: ['original-topic'],
      source: 'session-75-clawdferret',
      provenance: {
        origin: 'bulk-import',
        contentHash: `sha256:${'b'.repeat(64)}`,
        codeHash: 'code789',
      },
    };
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, metadata, project)
       VALUES ($1, $2::jsonb, $3)
       RETURNING id, source_file_hash, code_hash`,
      [content, JSON.stringify(meta), SENTINEL],
    );
    return rows[0];
  }

  it('12: full-content update preserves source + provenance and keeps generated columns populated', async () => {
    const inserted = await insertWithProvenance('tags: lesson:open\n\noriginal body');
    expect(inserted.source_file_hash).toBe(`sha256:${'b'.repeat(64)}`);

    const { updateThought } = await import('../db/queries.js');
    await updateThought(
      pool,
      inserted.id,
      'tags: lesson:open\n\nrewritten body',
      EMBEDDING,
      // What re-extraction produces: NO source, NO provenance.
      { type: 'observation', topics: ['new-topic'] },
    );

    const { rows } = await pool.query(
      `SELECT content, metadata, source_file_hash, code_hash
       FROM thoughts WHERE id = $1`,
      [inserted.id],
    );
    expect(rows[0].content).toBe('tags: lesson:open\n\nrewritten body');
    expect(rows[0].metadata.source).toBe('session-75-clawdferret');
    expect(rows[0].metadata.provenance.origin).toBe('bulk-import');
    // Generated columns must NOT null out — they are the import-dedup identity.
    expect(rows[0].source_file_hash).toBe(`sha256:${'b'.repeat(64)}`);
    expect(rows[0].code_hash).toBe('code789');
    // Re-extracted non-preserved keys still win.
    expect(rows[0].metadata.topics).toEqual(['new-topic']);
  });

  it('13: updated thought remains findable via match_thoughts_by_source', async () => {
    const inserted = await insertWithProvenance('tags: lesson:open\n\nfindable body');

    const { updateThought } = await import('../db/queries.js');
    await updateThought(pool, inserted.id, 'tags: lesson:incorporated\n\nfindable body', EMBEDDING, {
      type: 'observation',
    });

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, $2, false)`,
      [`sha256:${'b'.repeat(64)}`, SENTINEL],
    );
    // Both rows from tests 12+13 share the hash within this sentinel project;
    // the updated row must still be among them.
    expect(rows.some((r: { id: string }) => r.id === inserted.id)).toBe(true);
  });

  it('14: explicit caller-supplied source overrides the preserved one', async () => {
    const inserted = await insertWithProvenance('tags: x\n\noverride body');

    const { updateThought } = await import('../db/queries.js');
    await updateThought(pool, inserted.id, 'tags: x\n\noverride body v2', EMBEDDING, {
      type: 'observation',
      source: 'explicit-new-source',
    });

    const { rows } = await pool.query(`SELECT metadata FROM thoughts WHERE id = $1`, [
      inserted.id,
    ]);
    expect(rows[0].metadata.source).toBe('explicit-new-source');
    // provenance was not explicitly supplied → still preserved.
    expect(rows[0].metadata.provenance.origin).toBe('bulk-import');
  });
});
