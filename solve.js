// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Same answers, same errors, same order -- built with bulk slices instead of
// character-by-character concatenation. Single pass, left to right.
//
// Reference semantics (vendor/csv-reader/index.js, readCsv):
//  - U+FEFF at the very start is dropped.
//  - A record ends at LF or CRLF; a line with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next non-doubled quote; "" inside
//    is one quote; CRLF / lone CR inside is read as LF; what follows the closing
//    quote up to the next comma or line break is appended as it stands
//    (quote_junk, when the field ends); a quote that never closes is a literal
//    character and the text after it is read again as unquoted
//    (unterminated_quote).
//  - A quote inside an unquoted field is a literal character.
//  - Fields stay strings, never trimmed or converted.
//  - columns is the first record when header is true, else null; rows holds the
//    records after it, each padded (short_row, fields: count) or cut (long_row,
//    extra: cut fields) to the first record's width.
//  - Each error is {code, line, row}, in the order met; line is the 1-based line
//    its record starts on, row its record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on, its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Read an unquoted field starting at pos, with `value` as its prefix already
  // collected ('' normally; '"' after an unterminated quote). Returns
  // {value, ended}. Appends to `value` by slices; lone CRs are dropped and
  // reported (stray_cr). `prefix` is '' or '"' (a literal opening quote).
  // NOTE: `line` is advanced by this call; `recordLine`/`recordRow` are the
  // current record's and are used for every error this call reports.
  function readUnquoted(prefix) {
    let parts = null; // segments when a lone CR splits the field, else null
    let segStart = pos;
    let p = pos;
    let value;
    let ended;
    for (;;) {
      // Scan to the next comma, LF, CR, or end of text.
      while (p < n) {
        const cc = text.charCodeAt(p);
        if (cc === 44 || cc === 10 || cc === 13) break;
        p++;
      }
      if (p >= n) {
        if (parts === null) value = prefix + text.slice(segStart, n);
        else {
          parts.push(text.slice(segStart, n));
          value = prefix + parts.join('');
        }
        pos = n;
        ended = END;
        break;
      }
      const cc = text.charCodeAt(p);
      if (cc === 44) {
        if (parts === null) value = prefix + text.slice(segStart, p);
        else {
          parts.push(text.slice(segStart, p));
          value = prefix + parts.join('');
        }
        pos = p + 1;
        ended = COMMA;
        break;
      }
      if (cc === 10) {
        if (parts === null) value = prefix + text.slice(segStart, p);
        else {
          parts.push(text.slice(segStart, p));
          value = prefix + parts.join('');
        }
        pos = p + 1;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      // cc === 13 (CR)
      if (text.charCodeAt(p + 1) === 10) {
        if (parts === null) value = prefix + text.slice(segStart, p);
        else {
          parts.push(text.slice(segStart, p));
          value = prefix + parts.join('');
        }
        pos = p + 2;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      // Lone CR: dropped, reported, field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, p));
      p += 1;
      segStart = p;
    }
    return { value, ended };
  }

  // Read a quoted field whose opening quote is at pos.
  // Returns {value, ended}. On an unterminated quote it reports the error and
  // re-reads the text after the quote as unquoted, with '"' as its first char.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: a '"' not followed by another '"'.
    let p = pos + 1;
    let close = -1;
    let escaped = false; // a "" pair was met inside
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        escaped = true;
        p = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: literal character, re-read as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    // The quoted content is text[open+1 .. close). Turn CRLF / lone CR into LF
    // and "" into ", counting lines, unless it needs no change at all.
    let value;
    let contentHasBreak = false;
    if (!escaped) {
      // Fast check: any CR or LF in the content?
      // (indexOf is C-speed; a content with no break and no "" is a plain slice.)
      const cr = text.indexOf('\r', open + 1);
      const lf = text.indexOf('\n', open + 1);
      if ((cr === -1 || cr >= close) && (lf === -1 || lf >= close)) {
        value = text.slice(open + 1, close);
        pos = close + 1;
      } else {
        contentHasBreak = true;
      }
    }
    if (contentHasBreak || escaped) {
      // Build the value from the content, converting CRLF / lone CR to LF and
      // "" to ", and counting every line break.
      const parts = [];
      let s = open + 1;
      let q = s;
      while (q < close) {
        const cc = text.charCodeAt(q);
        if (cc === 34) {
          // "" -> one quote. (A lone " cannot occur here: close is the first
          // non-doubled quote, so every " before it is part of a "" pair.)
          parts.push(text.slice(s, q));
          parts.push('"');
          q += 2;
          s = q;
        } else if (cc === 13) {
          parts.push(text.slice(s, q));
          parts.push('\n');
          line += 1;
          q += text.charCodeAt(q + 1) === 10 ? 2 : 1;
          s = q;
        } else if (cc === 10) {
          line += 1;
          q += 1;
        } else {
          q += 1;
        }
      }
      parts.push(text.slice(s, close));
      value = parts.join('');
      pos = close + 1;
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.value.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
