/**
 * CSV assembly for the task export, following RFC 4180.
 *
 * Every function is pure: the report service passes in the owner-scoped task records it has read
 * and sends the returned string as the response body. Records are separated by CRLF, every record
 * (the header included) ends with CRLF, and a field is quoted exactly when RFC 4180 requires it.
 */

import type { TaskRecord } from '../db/types';

/**
 * Column names of the export, in column order. The serialised header row is
 * `id,title,description,status,priority,due date,created time,completed time`.
 */
export const CSV_HEADER = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'due date',
  'created time',
  'completed time',
] as const;

/**
 * UTF-8 byte-order mark written before the header. Excel decodes a CSV file as UTF-8, rather than
 * the system code page, only when the file begins with this mark, so non-ASCII titles and
 * descriptions display correctly. It belongs to the file, not to any value: parsers strip it before
 * reading the first field.
 */
const BYTE_ORDER_MARK = '\uFEFF';

const FIELD_SEPARATOR = ',';
const RECORD_SEPARATOR = '\r\n';

/** Characters that force a field into double quotes under RFC 4180. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Escapes one field for RFC 4180.
 *
 * A field containing a comma, a double quote, CR or LF is enclosed in double quotes with each
 * embedded double quote doubled; any other field, the empty string included, is returned bare.
 *
 * Cells beginning with `=`, `+`, `-`, `@`, tab or CR are deliberately written unchanged, with no
 * prefix to neutralise spreadsheet formulas: exported values must equal the stored task data, which
 * prefixing would alter, and the file holds only the requesting user's own task text, so any formula
 * in it was written by the person who opens it.
 *
 * @param value - The field's text exactly as it should read after parsing.
 * @returns The field as written in the file.
 */
export function escapeCsvField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Maps a task to its eight export fields, in {@link CSV_HEADER} order.
 *
 * Text and labels are copied exactly as stored, line breaks included. The due date stays the stored
 * `YYYY-MM-DD` text, and both timestamps are ISO 8601 UTC with milliseconds (for example
 * `2026-10-21T09:15:30.123Z`), which equals the stored `timestamptz(3)` value. A missing due date or
 * completion time is an empty field. The owner and the update time are never exported.
 *
 * @param task - An owner-scoped task record.
 * @returns The unescaped field values; {@link buildCsv} applies the quoting.
 */
export function taskToCsvRow(task: TaskRecord): string[] {
  return [
    String(task.id),
    task.title,
    task.description,
    task.status,
    task.priority,
    task.dueDate ?? '',
    task.createdAt.toISOString(),
    task.completedAt?.toISOString() ?? '',
  ];
}

/** Serialises one record: its escaped fields joined by commas, terminated by CRLF. */
function encodeRecord(fields: readonly string[]): string {
  return fields.map(escapeCsvField).join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
}

/**
 * Assembles the complete export file: the byte-order mark, the {@link CSV_HEADER} row, then one
 * record per data row, each ending with CRLF. With no data rows the result is the byte-order mark,
 * the header and a single CRLF.
 *
 * The records are collected and joined once, which keeps a 10,000-row export linear in its size.
 *
 * @param rows - Data rows only, typically from {@link taskToCsvRow}; the header is written here.
 * @returns The file's text, to be sent encoded as UTF-8.
 */
export function buildCsv(rows: readonly (readonly string[])[]): string {
  const records: string[] = [encodeRecord(CSV_HEADER)];
  for (const row of rows) {
    records.push(encodeRecord(row));
  }
  return BYTE_ORDER_MARK + records.join('');
}
