/**
 * Integration tests: updateThought provenance preservation.
 * (clobber regression, S90 class:openbrain-update-provenance-loss)
 *
 * Standalone from provenance.test.ts because that suite imports
 * pforge-sdk/hallmark — a file:-path dependency that only resolves in the
 * upstream author's environment. These tests need only a pgvector database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { updateThought } from '../db/queries.js';

const pool = new Pool({
  host: process.env.DB_HOST_TEST ?? process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'openbrain',
  password: process.env.DB_PASSWORD ?? 'changeme',
  database: process.env.DB_NAME ?? 'openbrain',
});

const SENTINEL = `__test_updateprov_${randomUUID()}`;

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
  await pool.query(`DELETE FROM thoughts WHERE project LIKE '__test_updateprov_%'`);
  await pool.end();
});

describe('updateThought — provenance preservation', () => {
  const EMBEDDING = Array(768).fill(0.001);
  const CONTENT_HASH = `sha256:${'b'.repeat(64)}`;

  async function insertWithProvenance(content: string) {
    const meta = {
      type: 'observation',
      topics: ['original-topic'],
      source: 'session-75-clawdferret',
      provenance: {
        origin: 'bulk-import',
        contentHash: CONTENT_HASH,
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

  it('1: full-content update preserves source + provenance and keeps generated columns populated', async () => {
    const inserted = await insertWithProvenance('tags: lesson:open\n\noriginal body');
    expect(inserted.source_file_hash).toBe(CONTENT_HASH);

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
    expect(rows[0].source_file_hash).toBe(CONTENT_HASH);
    expect(rows[0].code_hash).toBe('code789');
    // Re-extracted non-preserved keys still win.
    expect(rows[0].metadata.topics).toEqual(['new-topic']);
  });

  it('2: updated thought remains findable via match_thoughts_by_source', async () => {
    const inserted = await insertWithProvenance('tags: lesson:open\n\nfindable body');

    await updateThought(
      pool,
      inserted.id,
      'tags: lesson:incorporated\n\nfindable body',
      EMBEDDING,
      { type: 'observation' },
    );

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_by_source($1, 10, $2, false)`,
      [CONTENT_HASH, SENTINEL],
    );
    // Rows from tests 1+2 share the hash within this sentinel project;
    // the updated row must still be among them.
    expect(rows.some((r: { id: string }) => r.id === inserted.id)).toBe(true);
  });

  it('3: explicit caller-supplied source overrides the preserved one', async () => {
    const inserted = await insertWithProvenance('tags: x\n\noverride body');

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
