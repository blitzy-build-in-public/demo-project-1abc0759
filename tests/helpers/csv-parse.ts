/**
 * Result of {@link parseCsv}.
 */
export interface ParsedCsv {
  /** True when the decoded input began with a UTF-8 byte-order mark (U+FEFF). */
  bom: boolean;
  /**
   * Every record in input order, each as its list of field values with quoting removed.
   * The header row, when present, is the first record. Field counts are not compared
   * across records, so callers assert the column count they require.
   */
  records: string[][];
}

/**
 * Parses CSV text strictly according to RFC 4180, as an oracle for the export writer.
 *
 * Kept independent of the application's CSV writer and free of test-runner imports, so
 * that Jest suites and Playwright specs can both use it to check the writer's output.
 *
 * Input and decoding:
 * - A `Buffer` is decoded as UTF-8; a string is used unchanged.
 * - A leading U+FEFF sets `bom` and is not part of the first field.
 * - Input that is empty after the byte-order mark yields no records.
 *
 * Grammar:
 * - Records end with CRLF. A single CRLF at the very end terminates the last record and
 *   does not start an empty one; a final record without CRLF is still returned.
 * - An empty line between records yields the record `['']`.
 * - Fields are separated by `,`; a `,` directly before CRLF or the end yields a final
 *   empty field.
 * - A quoted field starts with `"` and ends at a `"` that is not doubled. Inside it `""`
 *   stands for one `"`, and `,`, CR and LF are kept literally.
 * - An unquoted field runs until `,`, CR or the end of the input.
 *
 * Offsets in error messages are UTF-16 code-unit indexes into the decoded text, counting
 * the byte-order mark. Messages never quote the input, because exports may hold
 * sensitive data.
 *
 * @param input - CSV bytes (UTF-8) or already-decoded text.
 * @returns The byte-order-mark flag and the parsed records.
 * @throws Error `CSV: unterminated quoted field starting at offset N` when a quoted field
 *   has no closing quote.
 * @throws Error `CSV: unexpected character after closing quote at offset N` when a closing
 *   quote is followed by anything other than `,`, CRLF or the end.
 * @throws Error `CSV: bare quote in unquoted field at offset N` when `"` appears inside an
 *   unquoted field.
 * @throws Error `CSV: bare LF in unquoted field at offset N` when LF appears outside quotes
 *   without a preceding CR.
 * @throws Error `CSV: bare CR at offset N` when CR outside quotes is not followed by LF.
 */
export function parseCsv(input: string | Buffer): ParsedCsv {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  const length = text.length;
  const records: string[][] = [];
  let i = bom ? 1 : 0;

  if (i >= length) {
    return { bom, records };
  }

  let record: string[] = [];

  // Each iteration reads one field starting at `i`, then consumes the separator after it.
  for (;;) {
    let field = '';

    if (text.charAt(i) === '"') {
      const fieldStart = i;
      let segmentStart = i + 1;
      for (;;) {
        const quote = text.indexOf('"', segmentStart);
        if (quote === -1) {
          throw new Error(`CSV: unterminated quoted field starting at offset ${fieldStart}`);
        }
        if (text.charAt(quote + 1) === '"') {
          field += text.slice(segmentStart, quote + 1);
          segmentStart = quote + 2;
          continue;
        }
        field += text.slice(segmentStart, quote);
        i = quote + 1;
        break;
      }
      if (i < length) {
        const after = text.charAt(i);
        if (after !== ',' && after !== '\r') {
          throw new Error(`CSV: unexpected character after closing quote at offset ${i}`);
        }
      }
    } else {
      const fieldStart = i;
      while (i < length) {
        const ch = text.charAt(i);
        if (ch === ',' || ch === '\r') {
          break;
        }
        if (ch === '"') {
          throw new Error(`CSV: bare quote in unquoted field at offset ${i}`);
        }
        if (ch === '\n') {
          throw new Error(`CSV: bare LF in unquoted field at offset ${i}`);
        }
        i += 1;
      }
      field = text.slice(fieldStart, i);
    }

    record.push(field);

    if (i >= length) {
      records.push(record);
      return { bom, records };
    }

    if (text.charAt(i) === ',') {
      i += 1;
      continue;
    }

    // The only other character that ends a field is CR, which must start a CRLF.
    if (text.charAt(i + 1) !== '\n') {
      throw new Error(`CSV: bare CR at offset ${i}`);
    }
    i += 2;
    records.push(record);
    if (i >= length) {
      return { bom, records };
    }
    record = [];
  }
}
