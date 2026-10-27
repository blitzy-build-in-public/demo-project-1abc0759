/**
 * Unit tests of the CSV export writer (pure functions, no database, no clock).
 *
 * The export follows RFC 4180: a field is enclosed in double quotes exactly when it contains a
 * comma, a double quote, CR or LF, and embedded double quotes are doubled; every other field is
 * written bare. The file starts with a UTF-8 byte-order mark, the header row is exact, and every
 * record, the header included, ends with CRLF, so an export with no tasks is the byte-order mark,
 * the header and one CRLF. Cells that look like spreadsheet formulas are exported unchanged,
 * because exported values must equal the stored task data. The independent RFC 4180 parser in
 * `tests/helpers/csv-parse.ts` is the oracle for the round trip.
 */

import { buildCsv, CSV_HEADER, escapeCsvField, taskToCsvRow } from '../../src/reports/csv';
import type { TaskRecord } from '../../src/db/types';
import { parseCsv } from '../helpers/csv-parse';

/** The UTF-8 byte-order mark, as the first character of the decoded file. */
const BOM = '\uFEFF';

/** The record separator and terminator. Written as an explicit literal, never a plain LF. */
const CRLF = '\r\n';

/** The serialised header row, without its terminating CRLF. */
const HEADER_LINE = 'id,title,description,status,priority,due date,created time,completed time';

/** ISO 8601 UTC with milliseconds, the format of both exported timestamps. */
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A completed, dated task whose title holds a comma and whose description holds quotes. */
const done: TaskRecord = {
  id: 42,
  ownerId: 7,
  title: 'Buy milk, eggs',
  description: 'He said "now"',
  status: 'Done',
  priority: 'High',
  dueDate: '2026-10-30',
  createdAt: new Date('2026-10-21T09:15:30.123Z'),
  updatedAt: new Date('2026-10-22T10:00:00.000Z'),
  completedAt: new Date('2026-10-22T10:00:00.456Z'),
};

/** An open task with no due date, no completion time and an empty description. */
const open: TaskRecord = {
  id: 43,
  ownerId: 7,
  title: 'Plan trip',
  description: '',
  status: 'To do',
  priority: 'Medium',
  dueDate: null,
  createdAt: new Date('2026-10-21T23:59:59.999Z'),
  updatedAt: new Date('2026-10-21T23:59:59.999Z'),
  completedAt: null,
};

/**
 * A task whose title looks like a formula and whose description mixes CRLF, a bare LF, a comma,
 * quotes and non-ASCII text, including a character outside the Basic Multilingual Plane.
 */
const tricky: TaskRecord = {
  id: 44,
  ownerId: 7,
  title: '=SUM(A1:A2)',
  description: 'line1\r\nline2\nline3, with "quotes"\nCafé ☕ \u{1D49C}',
  status: 'In progress',
  priority: 'Low',
  dueDate: '2026-11-01',
  createdAt: new Date('2026-10-20T00:00:00.000Z'),
  updatedAt: new Date('2026-10-20T08:30:00.000Z'),
  completedAt: null,
};

describe('escapeCsvField', () => {
  it.each<[string, string]>([
    ['plain', 'plain'],
    ['', ''],
    ['Café ☕', 'Café ☕'],
    ['\tindent', '\tindent'],
  ])('writes %j bare as %j', (value, expected) => {
    expect(escapeCsvField(value)).toBe(expected);
  });

  it.each<[string, string]>([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['"', '""""'],
    ['a\rb', '"a\rb"'],
    ['a\nb', '"a\nb"'],
    ['a\r\nb', '"a\r\nb"'],
    ['x, "y"\r\nz', '"x, ""y""\r\nz"'],
  ])('quotes %j as %j', (value, expected) => {
    expect(escapeCsvField(value)).toBe(expected);
  });

  // Formula-looking cells are never prefixed: the export must equal the stored data. Quoting
  // still applies whenever RFC 4180 requires it, including for a leading CR.
  it.each<[string, string]>([
    ['=SUM(A1:A2)', '=SUM(A1:A2)'],
    ['+1', '+1'],
    ['-1', '-1'],
    ['@cmd', '@cmd'],
    ['\t=1', '\t=1'],
    ['=1,2', '"=1,2"'],
    ['\r=1', '"\r=1"'],
  ])('writes formula-looking %j without a prefix as %j', (value, expected) => {
    expect(escapeCsvField(value)).toBe(expected);
  });
});

describe('CSV_HEADER', () => {
  it('lists the eight export columns in order', () => {
    expect(CSV_HEADER).toEqual([
      'id',
      'title',
      'description',
      'status',
      'priority',
      'due date',
      'created time',
      'completed time',
    ]);
  });
});

describe('buildCsv', () => {
  it('writes the byte-order mark, the header and one CRLF for an empty export', () => {
    expect(buildCsv([])).toBe(BOM + HEADER_LINE + CRLF);
  });

  it('encodes the byte-order mark as EF BB BF at the start of the UTF-8 bytes', () => {
    const bytes = Buffer.from(buildCsv([]), 'utf8');

    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('escapes each data field and ends every record with CRLF', () => {
    const csv = buildCsv([['1', 'a,b', '', 'To do', 'Low', '', '2026-10-21T09:15:30.123Z', '']]);

    expect(csv).toBe(
      BOM + HEADER_LINE + CRLF + '1,"a,b",,To do,Low,,2026-10-21T09:15:30.123Z,' + CRLF,
    );
  });

  it('terminates the header and each data row with exactly one CRLF', () => {
    const csv = buildCsv([
      ['1', 'first', '', 'To do', 'Low', '', '2026-10-21T09:15:30.123Z', ''],
      [
        '2',
        'second',
        '',
        'Done',
        'High',
        '2026-10-30',
        '2026-10-21T09:15:31.000Z',
        '2026-10-22T10:00:00.456Z',
      ],
    ]);

    expect(csv.endsWith(CRLF)).toBe(true);
    expect(csv.split(CRLF)).toHaveLength(4);
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it('places the byte-order mark at index 0 only', () => {
    const csv = buildCsv([taskToCsvRow(done), taskToCsvRow(tricky)]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.indexOf(BOM, 1)).toBe(-1);
  });
});

describe('taskToCsvRow', () => {
  it('maps a completed task to its raw field values in header order', () => {
    expect(taskToCsvRow(done)).toEqual([
      '42',
      'Buy milk, eggs',
      'He said "now"',
      'Done',
      'High',
      '2026-10-30',
      '2026-10-21T09:15:30.123Z',
      '2026-10-22T10:00:00.456Z',
    ]);
  });

  it('writes a missing due date, completion time and description as empty fields', () => {
    expect(taskToCsvRow(open)).toEqual([
      '43',
      'Plan trip',
      '',
      'To do',
      'Medium',
      '',
      '2026-10-21T23:59:59.999Z',
      '',
    ]);
  });

  it.each<[string, TaskRecord]>([
    ['done', done],
    ['open', open],
    ['tricky', tricky],
  ])('emits one field per header column for the %s task', (_name, task) => {
    expect(taskToCsvRow(task)).toHaveLength(CSV_HEADER.length);
  });

  it('formats both timestamps as ISO 8601 UTC with milliseconds', () => {
    const row = taskToCsvRow(done);

    expect(row[6]).toMatch(ISO_UTC_MS);
    expect(row[7]).toMatch(ISO_UTC_MS);
  });
});

describe('round trip through an independent RFC 4180 parser', () => {
  const rows = [done, open, tricky].map((task) => taskToCsvRow(task));
  const expected = { bom: true, records: [Array.from(CSV_HEADER), ...rows] };

  it('parses the text back to the header and the exact stored values', () => {
    expect(parseCsv(buildCsv(rows))).toEqual(expected);
  });

  it('parses the UTF-8 bytes back to the same records', () => {
    expect(parseCsv(Buffer.from(buildCsv(rows), 'utf8'))).toEqual(expected);
  });

  it('parses an empty export to the header row only', () => {
    expect(parseCsv(buildCsv([]))).toEqual({ bom: true, records: [Array.from(CSV_HEADER)] });
  });
});
