// A faster drop-in for makefun-site 1.0.0, written from the prose description of its method:
// the same build, byte for byte, done in one pass with no token trees, no per-line regexes and
// no repeated escaping. It reads no clock, no environment, no randomness and no file: its output
// depends on its input alone. Every case is answered alone; nothing is cached from one case to
// the next (the small slug and date caches below live for one build only).
//
// Method, in the reference's own order: sort the files by path; parse every template in name
// order; read each source's front matter and drop the refused, the drafts and the ones whose
// layout is no template that parses; give every kept page its slug, unique in its directory, and
// its url; render each body's Markdown with its links resolved; order the posts newest first;
// group the tags; run every page through its layout, then the index, tag and tags pages; copy
// the static files unless a built page shadows them; write the sorted report.
//
// The hot paths are the HTML escaper, the slug rule, the Markdown lexer and renderer, and the
// template renderer. The escaper scans for the five characters that change and copies the rest
// untouched; the slug rule skips Unicode normalisation for plain ASCII text (normalisation is
// the identity there) and memoises repeated titles and tags; the Markdown renderer classifies
// lines by their first characters and renders inline spans over index ranges, so no span ever
// copies its text; the template renderer walks a flat list of operations with an explicit
// scope chain, so a loop costs one scope object per iteration and no tree walk.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `c` (a code unit) is whitespace, by the same set String's trim and \s use. */
function isWSCode(c) {
  if (c <= 32) return true;
  if (c < 128) return false;
  return c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

// ---------------------------------------------------------------- HTML escaping

/** `s[lo..hi)` with & < > " ' escaped, appended to `out` without ever copying a clean run twice. */
function escInto(s, lo, hi, out) {
  let start = lo;
  for (let i = lo; i < hi; i++) {
    const c = s.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      if (start < i) out.push(s.slice(start, i));
      out.push(e);
      start = i + 1;
    }
  }
  if (start < hi) out.push(s.slice(start, hi));
}

/** `s` with & < > " ' escaped. A single scan: clean text is returned untouched. */
function escStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      const out = [s.slice(0, i)];
      escInto(s, i, s.length, out);
      return out.join('');
    }
  }
  return s;
}

// ---------------------------------------------------------------- slugs and dates

const MARK = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of characters other
 * than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), "untitled" when nothing is left. Plain ASCII text skips normalisation: NFKD is the
 * identity on it and it holds no combining mark.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) {
    n++;
    out = slug + '-' + n;
  }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const out = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  cache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Every whitespace code unit at or below 32 is covered inline; above 127 needs the full set.
    if (c <= 32 || (c > 127 && isWSCode(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}


// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line.
 * Returns the value, or an object { error } with the reason it is refused.
 */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or { error } with the reason it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        const v = c - 48;
        if (i < 4) y = y * 10 + v;
        else if (i < 7) mo = mo * 10 + v;
        else d = d * 10 + v;
      }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "slug": not a slug' };
      }
      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/: no leading, trailing or doubled "-".
      if (raw.charCodeAt(0) === 45 || raw.charCodeAt(raw.length - 1) === 45 || raw.indexOf('--') !== -1) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const p0 = text.indexOf('\n');
  const line0 = p0 === -1 ? text : text.slice(0, p0);
  if (line0 !== '---') return { error: 'no front matter' };
  // Find the closing line, remembering each line's span for the key pass.
  const spans = [];
  let lineStart = p0 + 1;
  let close = -1;
  let closeEnd = -1;
  for (let ln = 1; ; ln++) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      close = ln;
      closeEnd = lineEnd;
      break;
    }
    spans.push(lineStart, lineEnd);
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let s = 0; s < spans.length; s += 2) {
    const ls = spans[s];
    const le = spans[s + 1];
    const ln = s / 2 + 1;
    // Blank (spaces and tabs only) or a comment (opening on "#"): skipped.
    let j = ls;
    while (j < le && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (j === le || text.charCodeAt(ls) === 35) continue;
    // "key: value": a key of a-z and "_", a colon, one space and the value.
    let k = ls;
    while (k < le && ((text.charCodeAt(k) >= 97 && text.charCodeAt(k) <= 122) || text.charCodeAt(k) === 95)) k++;
    if (k === ls || k >= le || text.charCodeAt(k) !== 58) return { error: `line ${ln + 1} is not "key: value"` };
    const key = text.slice(ls, k);
    let raw;
    if (k + 1 >= le) raw = '';
    else if (text.charCodeAt(k + 1) !== 32) return { error: `line ${ln + 1} is not "key: value"` };
    else raw = text.slice(k + 2, le);
    // The value's trailing spaces and tabs are dropped.
    let re = raw.length;
    while (re > 0 && (raw.charCodeAt(re - 1) === 32 || raw.charCodeAt(re - 1) === 9)) re--;
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd + 1 <= text.length ? text.slice(closeEnd + 1) : '' };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A bullet item's text when `line` opens one, else null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text when `line` opens one, else null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** The first index from `from` where `s[lo..hi)` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace character. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) {
    if (isWSCode(s.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * `s[lo..hi)` rendered inline, appended to `out`; `link(target)` is a link's href. No span
 * ever copies its text: every nested span renders over its own index range.
 */
function inlineInto(s, lo, hi, out, link) {
  let run = lo;
  let i = lo;
  while (i < hi) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      if (run < i) out.push(s.slice(run, i));
      // The escaped character is written escaped, as the reference does.
      out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<code>');
        escInto(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          if (run < i) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, out, link);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, out, link);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        if (run < i) out.push(s.slice(run, i));
        const href = link(target);
        out.push('<a href="');
        escInto(href, 0, href.length, out);
        out.push('">');
        inlineInto(s, i + 1, k, out, link);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (run < i) out.push(s.slice(run, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (run < hi) out.push(s.slice(run, hi));
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, out, link);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const parts = ['<pre><code'];
      if (lang !== '') {
        parts.push(' class="language-');
        escInto(lang, 0, lang.length, parts);
        parts.push('"');
      }
      parts.push('>');
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        escInto(lines[i], 0, lines[i].length, parts);
        parts.push('\n');
        i++;
      }
      i++;
      parts.push('</code></pre>');
      out.push(parts.join(''));
      out.push('\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      out.push('\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>');
      out.push('\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const b of body) {
        const t = trimLine(b);
        if (t !== '') kept.push(t);
      }
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`);
      out.push('\n');
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const b = bulletOf(l);
          if (b !== null) {
            items.push([trimLine(b)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) parts.push(`<li>${inlineStr(item.join('\n'), link)}</li>\n`);
      parts.push(`</${tag}>`);
      out.push(parts.join(''));
      out.push('\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>`);
    out.push('\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlanks(src, lineStart, open) && isBlanks(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Whether `src[lo..hi)` holds only spaces and tabs. */
function isBlanks(src, lo, hi) {
  for (let i = lo; i < hi; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src` parsed into a tree of nodes (a TemplateError when it does not parse), then flattened
 * into operations: [0, text], [1, path, raw], [2, path, not, elsePc, endPc], [3, name, path,
 * bodyPc, endPc], [4, name], [5, jumpPc] (skip an else), [6] (a for loop's next step).
 */
function compileTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  const ops = [];
  emitNodes(root.body, ops);
  return ops;
}

/** A tree of nodes flattened into operations. */
function emitNodes(nodes, ops) {
  for (const n of nodes) {
    if (n.kind === 'text') ops.push([0, n.text]);
    else if (n.kind === 'var' || n.kind === 'raw') ops.push([1, n.path, n.kind === 'raw']);
    else if (n.kind === 'include') ops.push([4, n.name]);
    else if (n.kind === 'if') {
      const at = ops.length;
      ops.push([2, n.path, n.not, -1, -1]);
      emitNodes(n.then, ops);
      if (n.else !== null) {
        const jmp = ops.length;
        ops.push([5, -1]);
        ops[at][3] = ops.length;
        emitNodes(n.else, ops);
        const end = ops.length;
        ops[jmp][1] = end;
        ops[at][4] = end;
      } else {
        ops[at][4] = ops.length;
      }
    } else if (n.kind === 'for') {
      const at = ops.length;
      ops.push([3, n.name, n.path, -1, -1]);
      const bodyPc = ops.length;
      emitNodes(n.body, ops);
      ops.push([6]);
      ops[at][3] = bodyPc;
      ops[at][4] = ops.length;
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered in the scope of `vars`. Includes run in the same scope, at most
 * INCLUDE_DEPTH deep; a for loop costs one scope object per iteration, reused across its steps.
 */
function renderOps(ops, vars, templates) {
  let out = '';
  let scope = { vars, parent: null };
  const frames = [];
  const loops = [];
  let depth = 0;
  let pc = 0;
  for (;;) {
    while (pc < ops.length) {
      const op = ops[pc];
      switch (op[0]) {
        case 0:
          out += op[1];
          pc++;
          break;
        case 1: {
          const v = lookup(scope, op[1]);
          out += op[2] ? textOf(v) : escStr(textOf(v));
          pc++;
          break;
        }
        case 2: {
          const v = truthy(lookup(scope, op[1]));
          pc = v !== op[2] ? pc + 1 : op[3] !== -1 ? op[3] : op[4];
          break;
        }
        case 5:
          pc = op[1];
          break;
        case 3: {
          const xs = lookup(scope, op[2]);
          if (!Array.isArray(xs) || xs.length === 0) {
            pc = op[4];
            break;
          }
          const lvars = { [op[1]]: xs[0], loop: { index: 1, first: true, last: xs.length === 1, length: xs.length } };
          scope = { vars: lvars, parent: scope };
          loops.push({ arr: xs, idx: 0, name: op[1], scope, bodyPc: op[3], endPc: op[4] });
          pc = op[3];
          break;
        }
        case 6: {
          const loop = loops[loops.length - 1];
          loop.idx++;
          if (loop.idx < loop.arr.length) {
            const lv = loop.scope.vars;
            lv[loop.name] = loop.arr[loop.idx];
            const lp = lv.loop;
            lp.index = loop.idx + 1;
            lp.first = false;
            lp.last = loop.idx === loop.arr.length - 1;
            pc = loop.bodyPc;
          } else {
            loops.pop();
            scope = scope.parent;
            pc = loop.endPc;
          }
          break;
        }
        case 4: {
          const t = templates.get(op[1]);
          if (t !== undefined && depth < INCLUDE_DEPTH) {
            frames.push({ ops, pc: pc + 1, depth });
            ops = t;
            pc = 0;
            depth++;
          } else {
            pc++;
          }
          break;
        }
      }
    }
    if (frames.length === 0) break;
    const f = frames.pop();
    ops = f.ops;
    pc = f.pc;
    depth = f.depth;
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of their name; one that does not parse is reported
  // and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmpStr);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md
  // is static.
  const files = [...input.files].sort((x, y) => cmpStr(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Each source's front matter, in order: a refused source is reported and dropped, and so
  // is a draft. The checks run in order, and the first one that fails is the one reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target;
      // A scheme: a letter, then letters, digits, "+" "-" "." and a ":".
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if (c === 58) return target;
          if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
          j++;
        }
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: grouped by their slug, each named as first met in the posts' order, ordered by
  // count and then slug. A page's tags link to the posts' tag of the same slug, or to nothing.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // A page's link record as templates read it, a tag as templates read it, a post's card.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const pageOf = (s) => {
    const card = cards.get(s) ?? cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Every page through its layout, the index pages and the tag pages through theirs. The
  // four render scopes are built once and their one varying key is set per render; renders
  // run one at a time, so no render ever sees another's keys.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const pageVars = { site, tags: allTags, recent, page: null };
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagsVars = { site, tags: allTags, recent };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderOps(nodes, vars, templates);
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    pageVars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, pageVars);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexVars);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    tagVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', tagVars);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsVars);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
