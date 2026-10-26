/**
 * Unit tests for the timestamp defaults of `insertTask`, the task fixture in
 * `tests/helpers/test-db.ts`.
 *
 * `FIXTURE_TIME` is an exported `Date`, and a `Date` stays mutable through `setTime` and its
 * setters even when frozen. The defaults are therefore built afresh from a private epoch on every
 * call, so a test that moves `FIXTURE_TIME` cannot shift the timestamps of any later fixture. A
 * fake `Queryable` records the values `insertTask` binds, so no case opens a connection or needs a
 * database.
 */

import type { Queryable } from '../../src/db/query';

import { FIXTURE_TIME, insertTask } from '../helpers/test-db';

/** The instant every default fixture timestamp carries. */
const FIXTURE_ISO = '2026-10-21T09:00:00.000Z';

/** Zero-based positions of `created_at`, `updated_at` and `completed_at` among the bound values. */
const CREATED_AT_INDEX = 6;
const UPDATED_AT_INDEX = 7;
const COMPLETED_AT_INDEX = 8;

/** A fake database and the values bound to each statement it received, in order. */
interface RecordingDatabase {
  db: Queryable;
  bound: unknown[][];
}

/**
 * Builds a `Queryable` that records every statement's bound values and answers each with one row,
 * which is all `insertTask` reads back.
 */
function createRecordingDatabase(): RecordingDatabase {
  const bound: unknown[][] = [];
  const fake = {
    async query(_text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
      bound.push(values);
      return { rows: [{ id: bound.length }] };
    },
  };
  // Only `query` is used by the fixture, so the fake stands in for a pool.
  return { db: fake as unknown as Queryable, bound };
}

/**
 * Returns the `Date` bound at `index` of one statement's values.
 *
 * @throws Error when the statement is missing or the value there is not a `Date`.
 */
function boundDate(values: unknown[] | undefined, index: number): Date {
  const value = values?.[index];
  if (!(value instanceof Date)) {
    throw new Error(`bound value ${index} is not a Date`);
  }
  return value;
}

describe('insertTask timestamp defaults', () => {
  afterEach(() => {
    // Undo any mutation, so this file leaves FIXTURE_TIME as every other importer expects it.
    FIXTURE_TIME.setTime(Date.parse(FIXTURE_ISO));
  });

  it(`exports FIXTURE_TIME at ${FIXTURE_ISO}`, () => {
    expect(FIXTURE_TIME.toISOString()).toBe(FIXTURE_ISO);
  });

  it.each([
    { mutation: 'setTime(0)', mutate: (date: Date): number => date.setTime(0) },
    {
      mutation: 'setUTCFullYear(1999)',
      mutate: (date: Date): number => date.setUTCFullYear(1999),
    },
  ])(
    `binds ${FIXTURE_ISO} for every default after FIXTURE_TIME.$mutation`,
    async ({ mutate }) => {
      mutate(FIXTURE_TIME);
      expect(FIXTURE_TIME.toISOString()).not.toBe(FIXTURE_ISO);
      const { db, bound } = createRecordingDatabase();

      await insertTask(db, 1);
      await insertTask(db, 1, { status: 'Done' });

      const [open, done] = bound;
      expect(boundDate(open, CREATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(open, UPDATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(open?.[COMPLETED_AT_INDEX]).toBeNull();
      expect(boundDate(open, CREATED_AT_INDEX)).not.toBe(FIXTURE_TIME);
      expect(boundDate(done, CREATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, UPDATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, COMPLETED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, CREATED_AT_INDEX)).not.toBe(FIXTURE_TIME);
    },
  );

  it('binds a distinct Date object on each default call', async () => {
    const { db, bound } = createRecordingDatabase();

    await insertTask(db, 1);
    await insertTask(db, 1);

    const first = boundDate(bound[0], CREATED_AT_INDEX);
    const second = boundDate(bound[1], CREATED_AT_INDEX);
    expect(first).not.toBe(second);
    expect(first.toISOString()).toBe(FIXTURE_ISO);
    expect(second.toISOString()).toBe(FIXTURE_ISO);
  });
});
