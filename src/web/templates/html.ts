/**
 * Escaping template tag for server-rendered pages.
 *
 * Every page is built with the {@link html} tag: each interpolated value is HTML-escaped unless it
 * is already a {@link SafeHtml}, so task titles, descriptions, emails and messages can never inject
 * markup. This module is the product's XSS boundary and its only template engine.
 */

/** Detects whether any escapable character is present. Not global, so it keeps no `lastIndex`. */
const NEEDS_ESCAPE = /[&<>"'`]/;

/** Matches every escapable character for the single replacement pass. */
const ESCAPABLE_CHARS = /[&<>"'`]/g;

const ESCAPE_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
  // Backtick is escaped too: legacy browsers accepted it as an attribute-value quote.
  '`': '&#96;',
};

/**
 * Markup that is safe to send to the browser as is: either produced by {@link html}, which escapes
 * every interpolated value, or wrapped by {@link raw}. {@link html} inserts a `SafeHtml` value
 * without escaping it again, which is how page fragments compose.
 */
export class SafeHtml {
  /** Nominal brand: only instances of this class pass {@link SafeHtml.is}, not look-alikes. */
  readonly #brand = true;

  /** The markup itself. */
  readonly value: string;

  /**
   * Construct only through {@link html} or {@link raw}; calling the constructor directly bypasses
   * escaping.
   *
   * @internal
   */
  constructor(value: string) {
    this.value = value;
  }

  /** Returns the markup, so a `SafeHtml` can be sent with `res.send(String(page))`. */
  toString(): string {
    return this.value;
  }

  /** Whether `v` is a `SafeHtml` instance created by this module. */
  static is(v: unknown): v is SafeHtml {
    return typeof v === 'object' && v !== null && #brand in v;
  }
}

/**
 * Escapes `&`, `<`, `>`, `"`, `'` and `` ` `` as HTML character references.
 *
 * The result is safe in element content and inside attribute values, provided the caller always
 * wraps attribute values in double quotes (`value="${v}"`, never `value=${v}`). Unquoted
 * attributes are not protected by escaping.
 */
export function escapeHtml(text: string): string {
  // Most values (ids, labels, dates) contain nothing to escape, so skip the replacement pass.
  if (!NEEDS_ESCAPE.test(text)) {
    return text;
  }
  return text.replace(ESCAPABLE_CHARS, (ch) => ESCAPE_ENTITIES[ch] ?? ch);
}

/**
 * Appends one interpolated value to `out`: `SafeHtml` verbatim, arrays flattened recursively with
 * no separator, `null`, `undefined` and `false` as nothing, and anything else escaped as text.
 * `0`, `''` and `true` are ordinary values, so a zero count renders as `0`.
 */
function appendValue(out: string[], v: unknown): void {
  if (SafeHtml.is(v)) {
    out.push(v.value);
    return;
  }
  if (Array.isArray(v)) {
    const items: readonly unknown[] = v;
    for (let i = 0; i < items.length; i += 1) {
      appendValue(out, items[i]);
    }
    return;
  }
  if (v === null || v === undefined || v === false) {
    return;
  }
  out.push(escapeHtml(String(v)));
}

/**
 * Tag for HTML templates. The literal parts are trusted markup; every interpolated value is
 * escaped with {@link escapeHtml} unless it is a {@link SafeHtml}. Arrays (for example mapped rows)
 * are joined with no separator, and `null`, `undefined` and `false` render nothing, so
 * `` ${cond && html`...`} `` includes an optional fragment. Numbers, including `0`, render as text.
 *
 * @example
 * ```ts
 * const rows = tasks.map((t) => html`<tr><td>${t.title}</td><td>${t.status}</td></tr>`);
 * const page = html`<input name="title" value="${title}">
 *   <table><tbody>${[headerRow, rows]}</tbody></table>`;
 * // A title of `"><script>` renders as `&quot;&gt;&lt;script&gt;` inside the attribute.
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  // One array and a single join: pages such as the 10,000-row task list must not pay for
  // repeated string concatenation.
  const out: string[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    // Cooked strings, never `strings.raw`; an invalid escape sequence cooks to `undefined`.
    out.push(strings[i] ?? '');
    if (i < values.length) {
      appendValue(out, values[i]);
    }
  }
  return new SafeHtml(out.join(''));
}

/**
 * Marks `markup` as safe without escaping it.
 *
 * Warning: wrap only the output of another {@link html} call. Never pass user input, request data
 * or error text, which would be sent to the browser unescaped. Pages rarely need this, because
 * {@link html} already accepts `SafeHtml` values and arrays of them.
 */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
