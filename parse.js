// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns exactly the HTML
// that marked 18.1.3 returns with its default options (gfm true, breaks false, pedantic false),
// written from scratch as a line-oriented block parser plus a delimiter-stack inline parser.
//
// The implementation is original; the behaviours it encodes are the observable ones of the
// reference: block elements end with a newline, HTML blocks pass through raw, numeric character
// references are decoded in text while named entities pass through, and GFM tables, task lists,
// strikethrough and extended autolinks are supported.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const ESC_ALL_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every HTML-special character (code content, code spans, autolink text). */
function escAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESC_ALL_MAP[ch]);
}

/**
 * Escape like the reference's text renderer: <, >, ", ' always; & only when it does not begin
 * something shaped like a character reference (&#123;, &#x1F; or &name;).
 */
function escText(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)|[<>"']/g, (ch) => ESC_ALL_MAP[ch]);
}

const NUMERIC_REF = /&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));|&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;

/**
 * The reference's text-token cleanup: when a text run contains a numeric character reference,
 * decode each one (NUL, surrogates and values past U+10FFFF become U+FFFD; &#38; becomes &amp;)
 * and turn any other bare ampersand into &amp;. Named references are left alone.
 */
function decodeNumericRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '\uFFFD';
    if (v === 38) return '&amp;';
    return String.fromCodePoint(v);
  });
}

/** The reference's URL cleanup: encodeURI, with %25 folded back to %. Null when it throws. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Link-label normalisation: trim, collapse whitespace runs, case-fold (via upper, for ß). */
function labelKey(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}
function isSpaceChar(ch) {
  return ch === undefined || /\s/.test(ch);
}

/** Remove backslash escapes of Unicode punctuation/symbols (used for hrefs, titles, fence info). */
function unescapePunct(s) {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

/** Trim trailing characters equal to `ch` from the end of `s` (the reference's trimEnd helper). */
function trimEndChar(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

/** Drop trailing blank lines of a raw block the way the reference does for code/html raw text. */
function trimRawBlankLines(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

/** Expand tabs in `s` to spaces, counting columns from `startCol` (tab stops every 4). */
function expandTabs(s, startCol) {
  if (!s.includes('\t')) return s;
  let out = '';
  let col = startCol;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Node kinds: text {s}, html {s}, code {s}, br {}, delim {ch, n, open, close},
// open {img, start, end} (bracket opener; start/end index the label in the source),
// link {href, title, img, kids}, auto {href, s}.

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.includes(ch);
}

// An inline tag: comment, closing tag, open tag with attributes, processing instruction,
// declaration, or CDATA section — the shapes the reference accepts.
const TAG_ATTR = String.raw`\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\`]+))?`;
const TAG_RE = new RegExp(
  String.raw`^(?:<!--(?:-?>|[\s\S]*?-->)|</[A-Za-z][A-Za-z0-9-]*\s*>|<[A-Za-z][A-Za-z0-9-]*(?:${TAG_ATTR})*\s*/?>|<\?[\s\S]*?\?>|<![A-Za-z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)`,
);
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const AUTOLINK_RE_Y = new RegExp(AUTOLINK_RE.source.slice(1), 'y');
const TAG_RE_Y = new RegExp(TAG_RE.source.slice(1), 'y');
const PRE_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const A_OPEN_RE = /^<a /i;
const A_CLOSE_RE = /^<\/a>/i;

// GFM extended autolinks (bare URLs and e-mail addresses in text).
const URL_HEAD_RE = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const MAILTO_URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
const URL_HEAD_RE_Y = new RegExp(URL_HEAD_RE.source.slice(1), 'y');
const EMAIL_RE_Y = new RegExp(EMAIL_RE.source.slice(1), 'y');
const MAILTO_URL_RE_Y = new RegExp(MAILTO_URL_RE.source.slice(1), 'y');

/**
 * GFM trimming for bare URLs: the kept text is the longest prefix that
 * splits into chunks of plain characters (no URI punctuation), balanced
 * parenthesis groups, ampersands that do not start an entity running to
 * the end, and punctuation runs that are not at the very end. Whatever
 * suffix cannot be chunked is dropped, and the process repeats until the
 * text is stable.
 */
const URL_CHUNK_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedalUrl(s) {
  let prev;
  do {
    prev = s;
    const m = URL_CHUNK_RE.exec(s);
    s = m ? m[0] : '';
  } while (s !== prev && s.length > 0);
  return s;
}

/**
 * Parse a link destination and optional title starting at the '(' in src[pos].
 * Returns { href, title, end } (end = index just past ')') or null.
 */
function parseLinkDest(src, pos) {
  let i = pos + 1;
  const n = src.length;
  const skipWs = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
  };
  skipWs();
  let href = '';
  if (src[i] === '<') {
    i++;
    let buf = '';
    let ok = false;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < n) {
        buf += ch + src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '>') {
        ok = true;
        i++;
        break;
      }
      if (ch === '<' || ch === '\n') return null;
      buf += ch;
      i++;
    }
    if (!ok) return null;
    href = buf;
  } else {
    let depth = 0;
    let buf = '';
    while (i < n) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
        buf += ch + src[i + 1];
        i += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch < ' ') break;
      if (ch === '(') {
        depth++;
        if (depth > 32) return null;
      } else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      buf += ch;
      i++;
    }
    if (depth !== 0) return null;
    href = buf;
  }
  const afterDest = i;
  skipWs();
  let title = null;
  if (i < n && src[i] !== ')') {
    if (i === afterDest) return null; // title must be separated by whitespace
    const q = src[i];
    if (q === '"' || q === "'" || q === '(') {
      const close = q === '(' ? ')' : q;
      i++;
      let buf = '';
      let ok = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          buf += ch + src[i + 1];
          i += 2;
          continue;
        }
        if (q === '(' && ch === '(') return null;
        if (ch === close) {
          ok = true;
          i++;
          break;
        }
        buf += ch;
        i++;
      }
      if (!ok) return null;
      title = buf;
      skipWs();
    } else {
      return null;
    }
  }
  if (src[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

/**
 * Find the ']' matching a full/collapsed reference label starting at src[pos] === '['.
 * Returns { label, end } or null. Labels may hold escaped or nested balanced brackets.
 */
function parseRefLabel(src, pos) {
  let i = pos + 1;
  const n = src.length;
  let depth = 0;
  let buf = '';
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < n) {
      buf += ch + src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '[') {
      depth++;
      if (depth > 32) return null;
    } else if (ch === ']') {
      if (depth === 0) {
        if (buf.length > 999) return null;
        return { label: buf, end: i + 1 };
      }
      depth--;
    }
    buf += ch;
    i++;
  }
  return null;
}

/**
 * The matching ']' for a bracket group inside a link label, where the inner
 * content allows one more nesting level but no code-span handling: returns
 * the index just past the closing ']', or -1.
 */
function matchNestedLabel(s, start) {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      let j = i + 1;
      let ok = false;
      while (j < s.length) {
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') return -1;
        if (d === ']') { ok = true; break; }
        j++;
      }
      if (!ok) return -1;
      i = j + 1;
      continue;
    }
    if (c === ']') return i + 1;
    i++;
  }
  return -1;
}

/**
 * The index of the ']' that ends a label starting at `start` (the index
 * just after the opening bracket), following the reference's label
 * pattern: escapes and nested bracket groups are skipped, and a backtick
 * run consumes everything up to the next backtick run (the content may
 * contain ']'). Returns -1 when the pattern cannot match.
 */
function labelScanEnd(s, start) {
  const n = s.length;
  let i = start;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      while (j < n && s[j] !== '`') j++;
      if (j < n) {
        let r2 = 1;
        while (s[j + r2] === '`') r2++;
        i = j + r2;
        continue;
      }
      // No closing run: only a run of 2+ backticks right before ']' works.
      if (run >= 2 && s[i + run] === ']') return i + run;
      return -1;
    }
    if (c === '[') {
      const end = matchNestedLabel(s, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === ']') return i;
    i++;
  }
  return -1;
}

/**
 * Whether a link label can match the reference's label pattern at all:
 * plain characters, escapes and nested bracket groups are fine; a backtick
 * must open a run whose content holds no backticks and which is closed by
 * another run (of any length), except that a run of two or more backticks
 * may sit at the very end of the label. Anything else — most often an
 * unclosed backtick — means no link or image can form here.
 */
function labelPatternOk(label) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    const c = label[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (label[i + run] === '`') run++;
      if (run >= 2 && i + run === n) return true;
      let j = i + run;
      while (j < n && label[j] !== '`') j++;
      if (j >= n) return false;
      let r2 = 1;
      while (label[j + r2] === '`') r2++;
      i = j + r2;
      continue;
    }
    if (c === '[') {
      const end = matchNestedLabel(label, i);
      if (end < 0) return false;
      i = end;
      continue;
    }
    if (c === ']') return false;
    i++;
  }
  return true;
}

/**
 * Try to form a link or image at a ']' (position `closeIdx` in src), where `opener` is the
 * bracket node on top of the stack and `nodes` is the node list built so far (the opener is the
 * last "open" node in it). Returns { end, node } on success, null on failure.
 */
function tryFormLink(src, closeIdx, opener, nodes, refs, inLink, state) {
  const labelRaw = src.slice(opener.start, closeIdx);
  // Inside link text, links do not form (images still do), and a label that
  // the reference's label pattern cannot match forms nothing at all.
  if (inLink && !opener.img) return null;
  if (!labelPatternOk(labelRaw)) return null;
  let href = null;
  let title = null;
  let end = closeIdx + 1;
  let isRef = false;

  if (src[end] === '(') {
    const dest = parseLinkDest(src, end);
    if (dest) {
      href = unescapePunct(dest.href);
      title = dest.title === null ? null : unescapePunct(dest.title);
      end = dest.end;
    }
  }
  if (href === null && src[end] === '[') {
    const ref = parseRefLabel(src, end);
    if (ref) {
      const key = labelKey(ref.label === '' ? labelRaw : ref.label);
      if (Object.hasOwn(refs, key)) {
        href = refs[key].href;
        title = refs[key].title;
        end = ref.end;
        isRef = true;
      } else {
        return null;
      }
    }
  }
  if (href === null && !isRef) {
    // Shortcut reference: the label is the bracketed text itself.
    const key = labelKey(labelRaw);
    if (Object.hasOwn(refs, key)) {
      href = refs[key].href;
      title = refs[key].title;
      end = closeIdx + 1;
    }
  }
  if (href === null) return null;

  const kids = nodes.splice(opener.nodeIndex + 1);
  nodes.length = opener.nodeIndex;
  // Bare autolinks never survive inside a link or image label in the
  // reference (angle autolinks do); the suppression applies at any depth.
  const convertAutos = (list) => {
    for (let x = 0; x < list.length; x++) {
      const nd = list[x];
      if (nd.k === 'auto' && !nd.angle) list[x] = { k: 'text', s: nd.s };
      else if (nd.kids) convertAutos(nd.kids);
    }
  };
  convertAutos(kids);
  const labelCtx = makeInlineCtx(labelRaw, refs, true, state);
  labelCtx.base = opener.start;
  processInlineMarked(kids, labelCtx);
  return { end, node: { k: 'link', href, title, img: opener.img, kids } };
}

// ---------------------------------------------------------------------------
// Emphasis and strikethrough pairing.
//
// The reference engine does not use the CommonMark delimiter-stack algorithm:
// it scans the inline source left to right and, at each delimiter run, tries
// to pair it with a later run of the same character using a counting scan
// over the remaining runs. Runs are classified by their neighbours (in a
// masked copy of the source where code spans, links, tags and reference
// labels are blanked out): a run preceded by whitespace and followed by a
// word character counts as an opener and adds to the balance; other runs
// subtract. A rule-of-three check can skip a candidate closer (its length is
// remembered and may still be consumed by a later match). The pair forms an
// <em> when the smaller used length is odd, a <strong> when it is even, and
// any leftover delimiter characters at the edges are reprocessed as content.
// ---------------------------------------------------------------------------

const J_CLASS_RE = /[\s\p{P}\p{S}]/u;
const PUNCT_TEST_RE = /^(?![*_])[\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const ALT0_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/;
const ALT0_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;

/** Class of a single code point for delimiter-run classification. */
function charClass(c) {
  if (c === undefined || c === '') return 'end';
  if (c === '~') return 'tilde';
  if (/\s/.test(c)) return 'ws';
  if (/[\p{P}\p{S}]/u.test(c)) return 'punct';
  return 'word';
}

/** Class of the code point at index `idx` of `str` (idx may sit mid-pair). */
function classAt(str, idx) {
  if (idx < 0 || idx >= str.length) return 'end';
  let i = idx;
  const code = str.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff && i > 0) i--;
  return charClass(String.fromCodePoint(str.codePointAt(i)));
}

/** The code point ending just before index `idx` of `str` ('' at the start). */
function codePointBefore(str, idx) {
  let i = idx - 1;
  if (i < 0) return '';
  const code = str.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
    const hi = str.charCodeAt(i - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) return str.slice(i - 1, idx);
  }
  return str[i];
}

/** Index of the ']' matching the '[' whose content starts at `from`, or -1. */
function matchBracketIn(s, from) {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { i = j + r2; closed = true; break; }
          j += r2;
        } else j++;
      }
      if (!closed) i += run;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Index of the ']' ending a bracketed label that contains no nested '['
 * (code spans are skipped), or -1. Used for inline-link masking, where the
 * reference's skip pattern does not allow nested brackets in the label.
 */
function matchBracketFlat(s, from) {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let close = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { close = j; break; }
          j += r2;
        } else j++;
      }
      if (close < 0) return -1;
      i = close + run;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') return i;
    i++;
  }
  return -1;
}

/** Index of the ')' matching the '(' whose content starts at `from`, or -1. */
function matchParenIn(s, from) {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Build the masked copy of an inline source used for delimiter scanning:
 * code spans, inline links/images, HTML tags and autolinks are replaced by
 * a bracketed run of "a"s of the same length, escaped punctuation becomes
 * "++", and the label part of a resolved reference link is blanked the
 * same way. Lengths are preserved, so positions line up with the source.
 */
function maskInlineString(s, refs) {
  // The mask only ever rewrites escapes, code spans, tags and bracketed
  // constructs; with none of those characters present it is the identity.
  if (!/[`[<\\]/.test(s)) return s;
  const a = s.split('');
  const hide = (from, to) => {
    if (to - from < 2) return;
    a[from] = '[';
    for (let x = from + 1; x < to - 1; x++) a[x] = 'a';
    a[to - 1] = ']';
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && isPunctChar(s[i + 1])) {
      a[i] = '+';
      a[i + 1] = '+';
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let close = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { close = j; break; }
          j += r2;
        } else j++;
      }
      if (close >= 0) {
        hide(i, close + run);
        i = close + run;
        continue;
      }
      i += run;
      continue;
    }
    if (c === '<') {
      const m = /^<(?! )[^<>]*?>/.exec(s.slice(i));
      if (m) {
        hide(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const start = i;
      const textStart = c === '!' ? i + 2 : i + 1;
      const closeFlat = matchBracketFlat(s, textStart);
      if (closeFlat >= 0 && s[closeFlat + 1] === '(') {
        const closeP = matchParenIn(s, closeFlat + 2);
        if (closeP >= 0) {
          hide(start, closeP + 1);
          i = closeP + 1;
          continue;
        }
      }
      const closeB = matchBracketIn(s, textStart);
      if (closeB >= 0) {
        let maskedLabel = false;
        if (s[closeB + 1] === '[') {
          const lEnd = s.indexOf(']', closeB + 2);
          if (lEnd >= 0) {
            const lab = s.slice(closeB + 2, lEnd);
            if (lab !== '' && Object.hasOwn(refs, labelKey(lab))) {
              hide(closeB + 1, lEnd + 1);
              maskedLabel = true;
            }
          }
        } else if (Object.hasOwn(refs, labelKey(s.slice(textStart, closeB)))) {
          hide(start, closeB + 1);
          i = closeB + 1;
          continue;
        }
        if (maskedLabel) {
          // Only the label is hidden; the bracketed text stays scannable.
          i = textStart;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return a.join('');
}

/**
 * For each delimiter character, the start index of the last run in the
 * masked source whose preceding character is not whitespace — no closer
 * can begin after it.
 */
function lastCloserIndices(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const c = masked[s];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    let e = s + 1;
    while (e < n && masked[e] === c) e++;
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      out[c] = s;
    }
    s = e - 1;
  }
  return out;
}

/**
 * Classify a candidate closer run for an emphasis opener of character `r`
 * by the classes of the characters around it: 'closer' subtracts from the
 * balance, 'pool' adds (it acts as an opener), 'branch' subtracts but is
 * subject to the rule-of-three skip and the same-char break, null skips it.
 */
function classifyEm(r, P, N) {
  if (r === '*') {
    if (P === 'punct' && (N === 'ws' || N === 'end')) return 'closer';
    if ((P === 'word' || P === 'tilde') && (N === 'ws' || N === 'punct' || N === 'tilde' || N === 'end')) return 'closer';
    if ((P === 'ws' || P === 'punct') && (N === 'word' || N === 'tilde')) return 'pool';
    if (P === 'ws' && N === 'punct') return 'pool';
    if (P === 'punct' && N === 'punct') return 'branch';
    if ((P === 'word' || P === 'tilde') && N === 'word') return 'branch';
    return null;
  }
  if ((P === 'punct' || P === 'tilde') && (N === 'ws' || N === 'end')) return 'closer';
  if (P === 'word' && (N === 'ws' || N === 'punct' || N === 'tilde' || N === 'end')) return 'closer';
  if ((P === 'ws' || P === 'punct' || P === 'tilde') && N === 'word') return 'pool';
  if (P === 'ws' && (N === 'punct' || N === 'tilde')) return 'pool';
  if ((P === 'punct' || P === 'tilde') && (N === 'punct' || N === 'tilde')) return 'branch';
  return null;
}

/** Classify a candidate closer run for a strikethrough opener. */
function classifyDel(P, N) {
  if (P === 'punct' && (N === 'ws' || N === 'end')) return 'closer';
  if (P === 'word' && (N === 'ws' || N === 'punct' || N === 'end')) return 'closer';
  if ((P === 'ws' || P === 'punct') && N === 'word') return 'pool';
  if (P === 'ws' && N === 'punct') return 'pool';
  if (P === 'punct' && N === 'punct') return 'closer';
  if (P === 'word' && N === 'word') return 'closer';
  return null;
}

function makeInlineCtx(s, refs, inLink = false, state = null) {
  // With no emphasis/strikethrough characters anywhere, no pairing scan
  // can run, so the mask and closer table would never be consulted.
  if (!/[*_~]/.test(s)) {
    return {
      s,
      masked: s,
      last: { '*': -1, '_': -1, '~': -1 },
      base: 0,
      refs,
      inLink,
      state: state || { inLink: false, inRawBlock: false },
    };
  }
  const masked = maskInlineString(s, refs);
  return {
    s,
    masked,
    last: lastCloserIndices(masked),
    base: 0,
    refs,
    inLink,
    state: state || { inLink: false, inRawBlock: false },
  };
}

/** The last raw character of a text node (from the source when known). */
function lastRawChar(nd, ctx) {
  if (nd.end !== undefined) {
    const idx = nd.end - ctx.base - 1;
    if (idx >= 0 && idx < ctx.s.length) return ctx.s[idx];
  }
  return nd.s ? nd.s[nd.s.length - 1] : '';
}

/**
 * Try to pair the '*'/'_' delimiter node at index `i` with a later run,
 * the reference engine's way. On success the span is replaced in place and
 * true is returned.
 */
function tryEmStrong(nodes, i, ctx, param) {
  const nd = nodes[i];
  const r = nd.ch;
  const pos = nd.pos - ctx.base;
  const k = nd.n;
  const s = ctx.s;
  const masked = ctx.masked;
  // The character after the run decides the opening gate.
  const F = pos + k < s.length ? s[pos + k] : undefined;
  // Without a following punctuation or non-space character there is no
  // opening delimiter at all.
  if (F === undefined || /\s/.test(F)) return false;
  let d = '';
  let s4 = false;
  if (F !== r) {
    if (F !== '~' && /[\p{P}\p{S}]/u.test(F)) d = F;
    else if (r === '_') s4 = true;
  }
  // The run may extend backwards into identical characters already passed.
  let l = pos;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = codePointBefore(masked, l);
  const h = p !== '' && J_CLASS_RE.test(p);
  let nParam = param;
  if (l < pos) nParam = p;
  const u = l < pos ? h : PUNCT_TEST_RE.test(nParam);
  if (s4 && nParam !== '' && ALNUM_RE.test(nParam)) return false;
  if (!(d === '' || nParam === '' || u)) return false;
  const canClose = p.trim() !== '' && (d !== '' || (r === '*' && !h));
  const y = pos - l + k;
  const oBreak = param === r;
  // A run of this character sitting inside the first opposite pair is skipped.
  let skipPos = -1;
  const m0 = (r === '*' ? ALT0_AST : ALT0_UND).exec(masked.slice(pos + k));
  if (m0) {
    const dbl = r === '*' ? '__' : '**';
    const di = m0[0].indexOf(dbl);
    const ri = m0[0].indexOf(r, di + 2);
    if (ri >= 0) skipPos = pos + k + ri;
  }
  let m = k;
  let f = 0;
  const bound = ctx.last[r];
  for (let j = i + 1; j < nodes.length; j++) {
    const C = nodes[j];
    if (C.k !== 'delim' || C.ch !== r || C.n === 0) continue;
    const q = C.pos - ctx.base;
    if (q > bound) break;
    // Only runs visible in the masked string can close: a run the mask
    // hid (inside a code span, a link, a tag) does not exist for the scan,
    // and a partially hidden run counts with its visible length only.
    if (masked[q] !== r) continue;
    let b = 0;
    while (masked[q + b] === r) b++;
    if (skipPos >= q && skipPos < q + b) continue;
    const cls = classifyEm(r, classAt(masked, q - 1), classAt(masked, q + b));
    if (cls === null) continue;
    if (cls === 'pool') {
      m += b;
      continue;
    }
    if (cls === 'branch' || canClose) {
      if (oBreak && cls === 'branch') return false;
      if (y % 3 !== 0 && (y + b) % 3 === 0) {
        f += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) continue;
    const bUsed = Math.min(b, b + m + f);
    const isEm = Math.min(k, bUsed) % 2 === 1;
    const uo = isEm ? 1 : 2;
    // The content is re-lexed as its own inline string: tokens whose match
    // depends on the following character (bare autolinks, e-mail addresses)
    // resolve against the content's end, not the outer text.
    const contentStr = s.slice(pos + uo, q + bUsed - uo);
    const kids = scanInline(contentStr, ctx.refs, ctx.inLink, ctx.state);
    processInlineMarked(kids, makeInlineCtx(contentStr, ctx.refs, ctx.inLink, ctx.state));
    const repl = [{ k: isEm ? 'em' : 'strong', kids }];
    if (C.n > bUsed) repl.push({ k: 'delim', ch: r, n: C.n - bUsed, pos: C.pos + bUsed });
    nodes.splice(i, j - i + 1, ...repl);
    return true;
  }
  return false;
}

/**
 * Try to pair the '~' delimiter node at index `i` with a later run of the
 * same length, the reference engine's way.
 */
function tryDel(nodes, i, ctx, param) {
  const nd = nodes[i];
  const o = nd.n;
  if (o > 2) return false;
  const pos = nd.pos - ctx.base;
  const s = ctx.s;
  const masked = ctx.masked;
  const F = pos + o < s.length ? s[pos + o] : undefined;
  if (F === undefined || F === '~' || /\s/.test(F)) return false;
  const s1 = /[\p{P}\p{S}]/u.test(F) ? F : '';
  if (!(s1 === '' || param === '' || PUNCT_TEST_RE.test(param))) return false;
  let p = o;
  const bound = ctx.last['~'];
  for (let j = i + 1; j < nodes.length; j++) {
    const C = nodes[j];
    if (C.k !== 'delim' || C.ch !== '~' || C.n === 0) continue;
    const q = C.pos - ctx.base;
    if (q > bound) break;
    if (masked[q] !== '~') continue;
    let visLen = 0;
    while (masked[q + visLen] === '~') visLen++;
    if (visLen !== o) continue;
    const cls = classifyDel(classAt(masked, q - 1), classAt(masked, q + visLen));
    if (cls === null) continue;
    if (cls === 'pool') {
      p += o;
      continue;
    }
    p -= o;
    if (p > 0) continue;
    const contentStr = s.slice(pos + o, q);
    const kids = scanInline(contentStr, ctx.refs, ctx.inLink, ctx.state);
    processInlineMarked(kids, makeInlineCtx(contentStr, ctx.refs, ctx.inLink, ctx.state));
    nodes.splice(i, j - i + 1, { k: 'del', kids });
    return true;
  }
  return false;
}

/**
 * One left-to-right pass over a node list pairing emphasis and
 * strikethrough runs, tracking the "previous character" the reference
 * engine threads through its token stream (the last character of the
 * preceding text token, reset after any non-text token; a text token
 * ending in '_' leaves it unchanged).
 */
function processInlineMarked(nodes, ctx) {
  let prevText = false;
  let prevChar = '';
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.k === 'delim' && nd.n > 0 && !nd.inert && (nd.ch === '*' || nd.ch === '_')) {
      if (tryEmStrong(nodes, i, ctx, prevText ? prevChar : '')) {
        prevText = false;
        i++;
        continue;
      }
      if (nd.n > 1) {
        // A failed attempt consumes one character of the run as text; the
        // remaining characters are tried again as a fresh run.
        nodes.splice(i, 0, { k: 'delim', ch: nd.ch, n: 1, pos: nd.pos, inert: true });
        nd.n -= 1;
        nd.pos += 1;
        prevText = true;
        if (nd.ch !== '_') prevChar = nd.ch;
        i++;
        continue;
      }
      prevText = true;
      if (nd.ch !== '_') prevChar = nd.ch;
      i++;
      continue;
    }
    if (nd.k === 'delim' && nd.inert) {
      prevText = true;
      if (nd.ch !== '_') prevChar = nd.ch;
      i++;
      continue;
    }
    if (nd.k === 'delim' && nd.n > 0 && nd.ch === '~') {
      if (tryDel(nodes, i, ctx, prevText ? prevChar : '')) {
        prevText = false;
        i++;
        continue;
      }
      prevText = true;
      prevChar = '~';
      i++;
      continue;
    }
    if (nd.k === 'text' && !nd.esc) {
      prevText = true;
      const lastCh = lastRawChar(nd, ctx);
      if (lastCh !== '' && lastCh !== '_') prevChar = lastCh;
      i++;
      continue;
    }
    if (nd.k === 'open') {
      prevText = true;
      prevChar = '[';
      i++;
      continue;
    }
    prevText = false;
    i++;
  }
}


/** Render a node list to HTML. `alt` renders the plain-text form used for image alt text. */
function renderNodes(nodes, alt = false) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text':
        out += alt ? nd.s : nd.raw ? nd.s : escText(nd.s);
        break;
      case 'html':
        out += nd.s;
        break;
      case 'code':
        out += alt ? nd.s : `<code>${escAll(nd.s)}</code>`;
        break;
      case 'br':
        out += alt ? '' : '<br>';
        break;
      case 'delim':
        out += nd.ch.repeat(nd.n);
        break;
      case 'open':
        out += nd.img ? '![' : '[';
        break;
      case 'em':
        out += alt ? renderNodes(nd.kids, true) : `<em>${renderNodes(nd.kids)}</em>`;
        break;
      case 'strong':
        out += alt ? renderNodes(nd.kids, true) : `<strong>${renderNodes(nd.kids)}</strong>`;
        break;
      case 'del':
        out += alt ? renderNodes(nd.kids, true) : `<del>${renderNodes(nd.kids)}</del>`;
        break;
      case 'auto': {
        if (alt) {
          out += nd.s;
          break;
        }
        const href = cleanUrl(nd.href);
        if (href === null) {
          out += escAll(nd.s);
        } else {
          out += `<a href="${escAll(href)}">${escAll(nd.s)}</a>`;
        }
        break;
      }
      case 'link': {
        if (nd.img) {
          const altText = renderNodes(nd.kids, true);
          const href = cleanUrl(nd.href);
          if (href === null) {
            out += alt ? altText : escText(altText);
          } else if (alt) {
            out += altText;
          } else {
            let tag = `<img src="${escText(href)}" alt="${escText(altText)}"`;
            if (nd.title !== null) tag += ` title="${escText(nd.title)}"`;
            out += tag + '>';
          }
        } else if (alt) {
          out += renderNodes(nd.kids, true);
        } else {
          const inner = renderNodes(nd.kids);
          const href = cleanUrl(nd.href);
          if (href === null) {
            out += inner;
          } else {
            let tag = `<a href="${escText(href)}"`;
            if (nd.title !== null) tag += ` title="${escText(nd.title)}"`;
            out += `${tag}>${inner}</a>`;
          }
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Tokenise an inline fragment into a node list. `refs` is the document's
 * link-reference map. When `inLink` is set (a link label's own parse), bare
 * autolinks are suppressed and links do not form, the way the reference
 * suppresses them inside link text.
 */
function scanInline(src, refs, inLink, state = { inLink: false, inRawBlock: false }) {
  const nodes = [];
  const stack = []; // indices into `nodes` of bracket openers still unmatched
  // The reference threads its in-link-tag / in-raw-block state through the
  // whole document's inline pass: an unclosed <a> or <pre> in one fragment
  // still suppresses autolinks (or escaping) in the next. The state is
  // seeded from, and written back to, the shared object.
  let inRawBlock = state.inRawBlock;
  let inLinkTag = state.inLink;
  let textBuf = '';
  const flushText = () => {
    if (textBuf.length > 0) {
      nodes.push({ k: 'text', s: inRawBlock ? textBuf : decodeNumericRefs(textBuf), raw: inRawBlock, end: i });
      textBuf = '';
    }
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n' && /\S/.test(src.slice(i + 2))) {
        flushText();
        nodes.push({ k: 'br' });
        i += 2;
        // A hard break also consumes the next line's leading spaces and tabs.
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (next !== undefined && isAsciiPunct(next)) {
        flushText();
        nodes.push({ k: 'text', s: next, raw: false, esc: true });
        i += 2;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      // Find a closing run of exactly the same length. Inside brackets the
      // search may not cross the ']' that ends the innermost label (the
      // reference matches the label before it ever looks for code spans).
      let limit = n;
      if (stack.length > 0) {
        const topOpener = stack[stack.length - 1];
        if (topOpener.labelEnd === undefined) topOpener.labelEnd = labelScanEnd(src, topOpener.start);
        if (topOpener.labelEnd >= 0) limit = topOpener.labelEnd;
      }
      let j = i + run;
      let closeStart = -1;
      while (j < limit) {
        if (src[j] === '`') {
          let r2 = 1;
          while (src[j + r2] === '`') r2++;
          if (r2 === run) {
            closeStart = j;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (closeStart === -1) {
        textBuf += src.slice(i, i + run);
        i += run;
        continue;
      }
      flushText();
      let content = src.slice(i + run, closeStart).replace(/\n/g, ' ');
      if (/[^ ]/.test(content) && content.startsWith(' ') && content.endsWith(' ')) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = closeStart + run;
      continue;
    }

    if (ch === '<') {
      AUTOLINK_RE_Y.lastIndex = i;
      const auto = AUTOLINK_RE_Y.exec(src);
      if (auto) {
        flushText();
        const text = auto[1];
        const href = text.includes('@') && !text.includes(':') ? `mailto:${text}` : text;
        // Scheme autolinks keep their text; e-mail autolinks get mailto:.
        const isEmail = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/.test(text);
        nodes.push({ k: 'auto', s: text, href: isEmail ? `mailto:${text}` : text, angle: true });
        i += auto[0].length;
        continue;
      }
      TAG_RE_Y.lastIndex = i;
      const tag = TAG_RE_Y.exec(src);
      if (tag) {
        flushText();
        nodes.push({ k: 'html', s: tag[0] });
        if (!inRawBlock && PRE_OPEN_RE.test(tag[0])) inRawBlock = true;
        else if (inRawBlock && PRE_CLOSE_RE.test(tag[0])) inRawBlock = false;
        if (!inLinkTag && A_OPEN_RE.test(tag[0])) inLinkTag = true;
        else if (inLinkTag && A_CLOSE_RE.test(tag[0])) inLinkTag = false;
        i += tag[0].length;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      flushText();
      const opener = { k: 'open', img: true, start: i + 2, nodeIndex: nodes.length, snap: { inLink: inLinkTag, inRawBlock } };
      nodes.push(opener);
      stack.push(opener);
      i += 2;
      continue;
    }

    if (ch === '[') {
      flushText();
      const opener = { k: 'open', img: false, start: i + 1, nodeIndex: nodes.length, snap: { inLink: inLinkTag, inRawBlock } };
      nodes.push(opener);
      stack.push(opener);
      i++;
      continue;
    }

    if (ch === ']') {
      // Refresh nodeIndex values (splices during earlier formations may have shifted them).
      let opener = null;
      while (stack.length > 0) {
        const cand = stack[stack.length - 1];
        cand.nodeIndex = nodes.indexOf(cand);
        if (cand.nodeIndex === -1) {
          stack.pop();
          continue;
        }
        opener = cand;
        break;
      }
      if (!opener) {
        textBuf += ']';
        i++;
        continue;
      }
      let formed = null;
      if (!opener.dead) {
        flushText();
        formed = tryFormLink(src, i, opener, nodes, refs, inLink, state);
      }
      if (formed) {
        // The reference parses the label with its tag state saved and
        // restored: transitions inside the label do not leak out.
        inLinkTag = opener.snap.inLink;
        inRawBlock = opener.snap.inRawBlock;
        stack.pop();
        nodes.push(formed.node);
        if (!formed.node.img) {
          // A formed link deactivates every earlier link opener (they stay on the
          // stack, marked inactive, until a ']' discards them one by one).
          for (const cand of stack) {
            if (!cand.img) cand.dead = true;
          }
        }
        i = formed.end;
        continue;
      }
      // No link forms here. A bare URL that was cut short at this ']' gets
      // its full length back, swallowing the ']' as the reference's URL
      // tokeniser would.
      const lastNode = nodes[nodes.length - 1];
      if (lastNode && lastNode.k === 'auto' && lastNode.trunc === i && textBuf === (lastNode.tail || '')) {
        textBuf = '';
        const m2 = URL_HEAD_RE.exec(src.slice(lastNode.pos));
        const full = backpedalUrl(m2[0]);
        lastNode.s = full;
        lastNode.href = /^www\./.test(m2[0]) ? `http://${full}` : full;
        delete lastNode.trunc;
        stack.pop();
        opener.k = 'text';
        opener.s = opener.img ? '![' : '[';
        delete opener.img;
        i = lastNode.pos + full.length;
        continue;
      }
      // No link: the opener is consumed as literal text, ']' is literal too.
      stack.pop();
      opener.k = 'text';
      opener.s = opener.img ? '![' : '[';
      delete opener.img;
      textBuf += ']';
      i++;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (src[i + run] === ch) run++;
      const prev = i > 0 ? src[i - 1] : undefined;
      const next = src[i + run];
      const prevIsSpace = isSpaceChar(prev);
      const prevIsPunct = isPunctChar(prev);
      const nextIsSpace = isSpaceChar(next);
      const nextIsPunct = isPunctChar(next);
      const leftFlank = !nextIsSpace && (!nextIsPunct || prevIsSpace || prevIsPunct);
      const rightFlank = !prevIsSpace && (!prevIsPunct || nextIsSpace || nextIsPunct);
      let open;
      let close;
      if (ch === '*') {
        open = leftFlank;
        close = rightFlank;
      } else if (ch === '_') {
        open = leftFlank && (!rightFlank || prevIsPunct);
        close = rightFlank && (!leftFlank || nextIsPunct);
      } else {
        // '~': the reference pairs single or double runs; a run opens when followed by a
        // non-space, non-'~' character or punctuation, closes when preceded likewise.
        open = !nextIsSpace && next !== '~';
        close = !prevIsSpace && prev !== '~';
      }
      flushText();
      nodes.push({ k: 'delim', ch, n: run, open, close, pos: i });
      i += run;
      continue;
    }

    if (ch === '\n') {
      // Hard break: two or more spaces (or a tab's worth) before the newline, with more
      // content after it.
      let sp = 0;
      let back = textBuf.length - 1;
      while (back >= 0 && textBuf[back] === ' ') {
        sp++;
        back--;
      }
      if (sp >= 2 && /\S/.test(src.slice(i + 1))) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        flushText();
        nodes.push({ k: 'br' });
        i++;
        // A hard break also consumes the next line's leading spaces and tabs.
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    // GFM bare autolinks: protocol URLs anywhere, www. and e-mail at word boundaries,
    // unless inside an <a> tag span.
    if (!inLink && !inLinkTag && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W' || ch === 'm' || ch === 'x')) {
      MAILTO_URL_RE_Y.lastIndex = i;
      const mail = MAILTO_URL_RE_Y.exec(src);
      if (mail && (mail[0].startsWith('mailto:') || mail[0].startsWith('xmpp:'))) {
        flushText();
        nodes.push({ k: 'auto', s: mail[0], href: mail[0] });
        i += mail[0].length;
        continue;
      }
      URL_HEAD_RE_Y.lastIndex = i;
      const url = URL_HEAD_RE_Y.exec(src);
      if (url) {
        const isWww = /^www\./.test(url[0]);
        const prev = i > 0 ? src[i - 1] : undefined;
        if (!isWww || prev === undefined || /[\s*_~(]/.test(prev)) {
          flushText();
          if (stack.length > 0) {
            // Inside brackets the match may not swallow the closing ']':
            // cap at the bracket first, then trim the capped text, so
            // trailing delimiters stay in the stream as delimiter runs.
            // If the bracket does not form a link, the ']' handling gives
            // the URL its full length back.
            const rb = url[0].indexOf(']');
            if (rb >= 0) {
              const cut = backpedalUrl(url[0].slice(0, rb));
              if (cut.length > 0) {
                nodes.push({
                  k: 'auto',
                  s: cut,
                  href: isWww ? `http://${cut}` : cut,
                  pos: i,
                  trunc: i + rb,
                  tail: url[0].slice(cut.length, rb),
                });
                i += cut.length;
                continue;
              }
            }
          }
          const text = backpedalUrl(url[0]);
          if (text.length > 0) {
            nodes.push({ k: 'auto', s: text, href: isWww ? `http://${text}` : text, pos: i });
            i += text.length;
            continue;
          }
        }
      }
    }
    if (!inLink && !inLinkTag && /[A-Za-z0-9]/.test(ch)) {
      const prev = i > 0 ? src[i - 1] : undefined;
      if (prev === undefined || !/[A-Za-z0-9._%+-]/.test(prev)) {
        EMAIL_RE_Y.lastIndex = i;
        const em = EMAIL_RE_Y.exec(src);
        if (em) {
          flushText();
          nodes.push({ k: 'auto', s: em[0], href: `mailto:${em[0]}` });
          i += em[0].length;
          continue;
        }
      }
    }

    // Second tier: characters whose own dispatch is always the plain
    // fallthrough (spaces, most punctuation, non-ASCII) batch together;
    // the following character is dispatched normally, so token boundaries
    // after them are unaffected.
    const code0 = src.charCodeAt(i);
    if (
      code0 >= 128 || code0 === 32 || code0 === 9 || code0 === 34 ||
      code0 === 35 || code0 === 36 || code0 === 38 || code0 === 39 || code0 === 40 ||
      code0 === 41 || code0 === 44 || code0 === 47 || code0 === 58 || code0 === 59 ||
      code0 === 61 || code0 === 62 || code0 === 63 || code0 === 64 || code0 === 94 ||
      code0 === 123 || code0 === 124 || code0 === 125
    ) {
      let j = i + 1;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (
          c >= 128 || c === 32 || c === 9 || c === 34 ||
          c === 35 || c === 36 || c === 38 || c === 39 || c === 40 ||
          c === 41 || c === 44 || c === 47 || c === 58 || c === 59 ||
          c === 61 || c === 62 || c === 63 || c === 64 || c === 94 ||
          c === 123 || c === 124 || c === 125
        ) {
          j++;
        } else break;
      }
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }
    // Plain text: a run of characters that cannot start a token and
    // cannot follow a token boundary (letters/digits that never begin a
    // URL, mail or e-mail token from inside a word) is consumed at once.
    if (
      (code0 >= 48 && code0 <= 57) ||
      (code0 >= 65 && code0 <= 90 && code0 !== 72 && code0 !== 70) ||
      (code0 >= 97 && code0 <= 122 && code0 !== 104 && code0 !== 102 && code0 !== 109 && code0 !== 120) ||
      code0 === 46 || code0 === 37 || code0 === 43 || code0 === 45
    ) {
      let j = i + 1;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (
          (c >= 48 && c <= 57) ||
          (c >= 65 && c <= 90 && c !== 72 && c !== 70) ||
          (c >= 97 && c <= 122 && c !== 104 && c !== 102 && c !== 109 && c !== 120) ||
          c === 46 || c === 37 || c === 43 || c === 45
        ) {
          j++;
        } else break;
      }
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }
    textBuf += ch;
    i++;
  }
  flushText();
  state.inLink = inLinkTag;
  state.inRawBlock = inRawBlock;
  return nodes;
}

/** Tokenise + process an inline fragment (see scanInline). */
function renderInline(src, refs, state = { inLink: false, inRawBlock: false }) {
  const nodes = scanInline(src, refs, false, state);
  processInlineMarked(nodes, makeInlineCtx(src, refs, false, state));
  return renderNodes(nodes);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

/** Leading-space prefix length (spaces only, at most 3) used by most block constructs. */
function lead3(line) {
  let s = 0;
  while (s < 3 && line[s] === ' ') s++;
  return s;
}

/** Whether the line starts an indented code block: four spaces, or up to 3 spaces then a tab. */
function isIndented(line) {
  return /^ {4}/.test(line) || /^ {0,3}\t/.test(line);
}

/** Remove one level of code indentation from a line, the reference's way. */
function stripCodeIndent(line) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(line);
  return m ? line.slice(m[0].length) : line;
}

const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
function isHR(line) {
  return HR_RE.test(line);
}

const ATX_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/;
function matchATX(line) {
  const m = ATX_RE.exec(line);
  if (!m) return null;
  let text = m[2].trim();
  if (text.endsWith('#')) {
    const stripped = trimEndChar(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth: m[1].length, text };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
function matchFenceStart(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  const marker = m[1];
  const info = m[2];
  if (marker[0] === '`' && info.includes('`')) return null;
  return { ch: marker[0], len: marker.length, info, indent: line.length - line.trimStart().length };
}

function isFenceClose(line, ch, len) {
  const s = lead3(line);
  let run = 0;
  while (line[s + run] === ch) run++;
  if (run < len) return false;
  return /^[ \t]*$/.test(line.slice(s + run));
}

const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
function setextDepth(line) {
  const m = SETEXT_RE.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_TYPE1_RE = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_TYPE6_RE = new RegExp(String.raw`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \t]+|[ \t]*\/?>|$)`, 'i');
const HTML_TAGNAME_RE = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)/;

/** Start-of-HTML-block conditions that also interrupt a paragraph (types 1-6). */
function htmlBlockStart(line) {
  if (!line.includes('<')) return null;
  const s = lead3(line);
  const rest = line.slice(s);
  if (rest[0] !== '<') return null;
  if (HTML_TYPE1_RE.test(line)) return 'raw';
  if (rest.startsWith('<!--')) return 'comment';
  if (rest.startsWith('<?')) return 'pi';
  if (/^<![A-Za-z]/.test(rest)) return 'decl';
  if (rest.startsWith('<![CDATA[')) return 'cdata';
  if (HTML_TYPE6_RE.test(line)) return 'tag';
  return null;
}

/** A complete open or close tag ending the line (HTML block type 7; does not interrupt). */
const HTML_TYPE7_OPEN_RE = new RegExp(String.raw`^<[A-Za-z][A-Za-z0-9-]*(?:${TAG_ATTR})*\s*/?>[ \t]*$`);
function htmlType7(line) {
  if (!line.includes('<')) return false;
  const rest = line.slice(lead3(line));
  const open = HTML_TYPE7_OPEN_RE.exec(rest);
  if (open) return true;
  // A closing tag on its own line counts too, but it may not carry attributes.
  return /^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(rest);
}

/**
 * Consume an HTML block starting at lines[i]; returns { text, next } with the raw text
 * (trailing blank lines trimmed the reference's way) and the next unconsumed line index.
 */
function consumeHtmlBlock(lines, i) {
  const kind = htmlBlockStart(lines[i]) ?? 'tag7';
  let j = i;
  const findIn = (from, needle) => {
    const low = needle.toLowerCase();
    for (let k = from; k < lines.length; k++) {
      if (lines[k].toLowerCase().includes(low)) return k;
    }
    return -1;
  };
  // After a raw/comment/pi/decl/cdata block ends, the reference absorbs following
  // newline characters only: exactly-empty lines join the raw, spaces-only lines do not.
  const absorbEmpty = () => {
    while (j + 1 < lines.length && lines[j + 1] === '') j++;
  };
  if (kind === 'raw') {
    const tag = HTML_TYPE1_RE.exec(lines[i])[1].toLowerCase();
    const close = findIn(i, `</${tag}`);
    j = close === -1 ? lines.length - 1 : close;
    absorbEmpty();
  } else if (kind === 'comment') {
    const close = findIn(i, '-->');
    j = close === -1 ? lines.length - 1 : close;
    absorbEmpty();
  } else if (kind === 'pi') {
    const close = findIn(i, '?>');
    j = close === -1 ? lines.length - 1 : close;
    absorbEmpty();
  } else if (kind === 'decl') {
    const close = findIn(i, '>');
    j = close === -1 ? lines.length - 1 : close;
    absorbEmpty();
  } else if (kind === 'cdata') {
    const close = findIn(i, ']]>');
    j = close === -1 ? lines.length - 1 : close;
    absorbEmpty();
  } else {
    // 'tag' / 'tag7': through the first blank line; trailing blank lines (even
    // spaces-only ones, which the reference's tail pattern allows) join the raw.
    j = i;
    while (j + 1 < lines.length && !isBlank(lines[j + 1])) j++;
    while (j + 1 < lines.length && isBlank(lines[j + 1])) j++;
  }
  const raw = rawFor(lines, i, j);
  return { text: trimRawBlankLines(raw), next: j + 1 };
}

/** The raw source text of lines[a..b] inclusive, with the final newline when there is one. */
function rawFor(lines, a, b) {
  let raw = lines.slice(a, b + 1).join('\n');
  if (b < lines.length - 1) raw += '\n';
  return raw;
}

// --- Link reference definitions ---------------------------------------------

const DEF_RE =
  /^ {0,3}\[((?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]:[ \t]*(?:\n[ \t]*)?([^<\s][^\s]*|<[^>\n]*>)(?:(?:[ \t]+(?:\n[ \t]*)?|[ \t]*\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))?[ \t]*(?:\n+|$)/;

/** Balanced-parens test for definition destinations (the reference's helper). */
function parensBalanced(s) {
  if (!s.includes('(') && !s.includes(')')) return true;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Try to consume a link reference definition at lines[i]. On success registers it in refs
 * (first definition of a label wins) and returns the next line index; else null.
 */
function consumeDef(lines, i, refs) {
  // A definition cannot span an exactly-empty line (its title pattern forbids it).
  let limit = i;
  while (limit < lines.length && limit < i + 40 && lines[limit] !== '') limit++;
  const joined = lines.slice(i, limit).join('\n') + '\n';
  const m = DEF_RE.exec(joined);
  if (!m) return null;
  let href = m[2];
  if (!href.startsWith('<') && !parensBalanced(href)) return null;
  if (href.startsWith('<')) href = href.slice(1, -1);
  href = unescapePunct(href);
  let title = null;
  if (m[3] !== undefined) title = unescapePunct(m[3].slice(1, -1));
  const key = labelKey(m[1]);
  if (key === '') return null;
  if (!Object.hasOwn(refs, key)) refs[key] = { href, title };
  const used = m[0];
  const nl = (used.match(/\n/g) || []).length;
  return i + Math.max(1, nl);
}

// --- Tables ------------------------------------------------------------------

const TABLE_DELIM_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

/** Split a table row into cells, the reference's way (unescaped pipes are delimiters). */
function splitRow(str, count) {
  let t = '';
  for (let idx = 0; idx < str.length; idx++) {
    const ch = str[idx];
    if (ch === '|') {
      let bs = 0;
      let p = idx - 1;
      while (p >= 0 && str[p] === '\\') {
        bs++;
        p--;
      }
      t += bs % 2 === 1 ? '|' : ' |';
    } else {
      t += ch;
    }
  }
  const cells = t.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    while (cells.length < count) cells.push('');
  }
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function matchTable(lines, i) {
  if (i + 1 >= lines.length) return null;
  const delimLine = lines[i + 1];
  const dm = TABLE_DELIM_RE.exec(delimLine);
  if (!dm) return null;
  if (!/[:|]/.test(delimLine)) return null;
  const header = splitRow(lines[i]);
  const delimCells = delimLine
    .replace(/^\||\| *$/g, '')
    .split('|');
  if (header.length !== delimCells.length) return null;
  const align = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  // Row collection stops at a line of nothing but spaces (a tab-only line
  // still counts as a row) or at a line starting another block.
  while (j < lines.length && !/^ *$/.test(lines[j]) && !tableBodyInterrupt(lines[j])) {
    rows.push(splitRow(lines[j], header.length));
    j++;
  }
  return { node: { t: 'table', header, align, rows }, next: j };
}

function tableBodyInterrupt(line) {
  if (isHR(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const ind = /^(?: {4}| {0,3}\t)/.exec(line);
  if (ind && line.length > ind[0].length) return true;
  if (matchFenceStart(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) return true;
  if (htmlBlockStart(line)) return true;
  return false;
}

/** Whether lines[j] + lines[j+1] look like a table header + delimiter (regex-level). */
function tableAhead(lines, j) {
  if (j + 1 >= lines.length) return false;
  if (!/^ *[^\n ]/.test(lines[j])) return false;
  // A delimiter row with neither '|' nor ':' is a setext underline, not a table.
  if (!/[:|]/.test(lines[j + 1])) return false;
  return TABLE_DELIM_RE.test(lines[j + 1]);
}

// --- Blockquotes ---------------------------------------------------------------

const QUOTE_RE = /^ {0,3}>/;

/** The content of a marked line after the ` {0,3}> ?` prefix. */
function quoteContent(line) {
  const m = /^ {0,3}> ?/.exec(line);
  return line.slice(m[0].length);
}

/**
 * Whether a line interrupts the reference's blockquote continuation
 * pattern (the block-text lookahead set: blank, thematic break, heading,
 * quote marker, fence, list marker, HTML start).
 */
function keInterrupts(line) {
  if (isBlank(line)) return true;
  if (isHR(line)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (matchFenceStart(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) return true;
  if (htmlBeginAt(line, 3)) return true;
  return false;
}

/** Strip one segment's quote markers the way the reference does. */
function stripQuoteSegment(h) {
  let s = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length));
  s = s.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
  s = s.replace(/^ {0,3}>[ \t]?/gm, '');
  return s;
}

function interruptsParagraph(lines, j) {
  const ln = lines[j];
  if (isHR(ln)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(ln)) return true;
  if (QUOTE_RE.test(ln)) return true;
  if (matchFenceStart(ln)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(ln)) return true;
  if (htmlBlockStart(ln)) return true;
  if (tableAhead(lines, j)) return true;
  return false;
}

function interruptsTextRun(lines, j) {
  const ln = lines[j];
  if (isHR(ln)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(ln)) return true;
  if (QUOTE_RE.test(ln)) return true;
  if (matchFenceStart(ln)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(ln)) return true;
  if (htmlBlockStart(ln) || htmlType7(ln)) return true;
  if (tableAhead(lines, j)) return true;
  return false;
}

/**
 * Collect a blockquote starting at lines[i], following the reference's
 * algorithm: a chunk of marked lines (each extended through following
 * unmarked lines that do not interrupt its continuation pattern) is
 * processed in segments of leading unmarked lines plus marked lines.
 * Each segment is stripped and lexed separately into one shared block
 * list; a segment ending in a code/heading/hr/html/table block ends the
 * quote, and a trailing nested quote or list is re-lexed together with
 * the remaining chunk lines so it can absorb them.
 */
function collectQuote(lines, i, refs) {
  const chunk = [];
  let j = i;
  while (j < lines.length && QUOTE_RE.test(lines[j])) {
    chunk.push(lines[j]);
    const content = quoteContent(lines[j]);
    j++;
    if (!/^[ \t]*$/.test(content)) {
      while (j < lines.length && !keInterrupts(lines[j])) {
        chunk.push(lines[j]);
        j++;
      }
    }
  }
  const blocks = [];
  let pos = 0;
  let endPos = 0;
  while (pos < chunk.length) {
    const seg = [];
    let seenMarked = false;
    while (pos < chunk.length) {
      if (QUOTE_RE.test(chunk[pos])) {
        seg.push(chunk[pos]);
        seenMarked = true;
        pos++;
      } else if (!seenMarked) {
        seg.push(chunk[pos]);
        pos++;
      } else break;
    }
    const u = stripQuoteSegment(seg.join('\n'));
    let uLines = u === '' ? [] : u.split('\n');
    // Cross-segment merges into a trailing paragraph: leading blank lines
    // (at most one) are transparent; a leading definition or indented
    // chunk folds into the paragraph as literal text instead of forming
    // its own token, and the segment's first paragraph merges too.
    let leadBlanks = 0;
    while (leadBlanks < uLines.length && isBlank(uLines[leadBlanks])) leadBlanks++;
    const lastBlock = () => blocks[blocks.length - 1];
    if (lastBlock() && lastBlock().t === 'para' && leadBlanks <= 1) {
      let rest = uLines.slice(leadBlanks);
      let merged = true;
      while (merged && rest.length > 0) {
        merged = false;
        const probe = consumeDef(rest, 0, new Map());
        if (probe !== null) {
          lastBlock().text += `\n${rest.slice(0, probe).join('\n')}`;
          rest = rest.slice(probe);
          merged = true;
          continue;
        }
        if (isIndented(rest[0])) {
          let k = 0;
          while (k < rest.length && (isCodeLine(rest[k]) || isBlank(rest[k]))) k++;
          const raw = trimRawBlankLines(rawFor(rest, 0, k - 1));
          const text = raw.split('\n').map(stripCodeIndent).join('\n');
          lastBlock().text += `\n${text.replace(/\n$/, '')}`;
          rest = rest.slice(k);
          merged = true;
        }
      }
      uLines = rest;
    }
    const segBlocks = parseBlocks(uLines, refs, true);
    if (
      segBlocks.length > 0 &&
      segBlocks[0].t === 'para' &&
      lastBlock() &&
      lastBlock().t === 'para' &&
      leadBlanks <= 1
    ) {
      lastBlock().text += `\n${segBlocks[0].text}`;
      segBlocks.shift();
    }
    blocks.push(...segBlocks);
    endPos = pos;
    if (pos >= chunk.length) break;
    const last = lastBlock();
    if (!last) continue;
    if (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'quote') {
      const remaining = chunk.slice(pos);
      const mLines = (last.rawLines || []).concat(
        remaining.map((l) => l.replace(/^ {0,3}>[ \t]?/, '')),
      );
      const f = collectQuote(mLines, 0, refs);
      const leftover = mLines.length - f.next;
      const absorbed = Math.max(0, remaining.length - leftover);
      blocks[blocks.length - 1] = f.node;
      pos += absorbed;
      endPos = pos;
      if (pos < chunk.length && QUOTE_RE.test(chunk[pos])) continue;
      break;
    }
    if (last.t === 'list') {
      const remaining = chunk.slice(pos);
      const bLines = (last.rawLines || []).concat(remaining);
      const m2 = collectList(bLines, 0, refs);
      if (m2) {
        const extra = Math.max(0, m2.next - (m2.trailingGap || 0) - (last.rawLines || []).length);
        if (extra > 0) {
          blocks[blocks.length - 1] = m2.node;
          pos += extra;
          endPos = pos;
        }
      }
      continue;
    }
  }
  const node = { t: 'quote', kids: blocks, rawLines: chunk.slice(0, endPos) };
  return { node, next: i + endPos };
}

// --- Lists ---------------------------------------------------------------------

function matchBullet(line) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker[0] >= '0' && marker[0] <= '9';
  return {
    marker,
    ordered,
    start: ordered ? parseInt(marker, 10) : null,
    delim: marker[marker.length - 1],
    prefix: m[0],
  };
}

/** Block-begin tests that end a list item's continuation, at the clamped indent. */
const beginsBlockCache = [];
function beginsBlockRes(n) {
  let r = beginsBlockCache[n];
  if (!r) {
    r = {
      bullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)`),
      hr: new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})[ \\t]*$`),
      fence: new RegExp(`^ {0,${n}}(?:\`{3,}|~{3,})`),
      heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
      quote: new RegExp(`^ {0,${n}}>`),
    };
    beginsBlockCache[n] = r;
  }
  return r;
}
function beginsBlock(line, n, bulletAny) {
  const r = beginsBlockRes(n);
  if (bulletAny && r.bullet.test(line)) return true;
  if (r.hr.test(line)) return true;
  if (r.fence.test(line)) return true;
  if (r.heading.test(line)) return true;
  if (bulletAny && r.quote.test(line)) return true;
  if (htmlBeginAt(line, n)) return true;
  return false;
}

function htmlBeginAt(line, n) {
  // The tag must begin within the first n columns (spaces only; a leading
  // tab puts the line beyond the clamp, as in the reference's tests).
  let sp = 0;
  while (line[sp] === ' ') sp++;
  if (sp > n) return false;
  const rest = line.slice(sp);
  if (rest[0] !== '<') return false;
  if (HTML_TYPE1_RE.test(rest)) return true;
  if (rest.startsWith('<!--') || rest.startsWith('<?') || /^<![A-Za-z]/.test(rest) || rest.startsWith('<![CDATA[')) return true;
  if (HTML_TYPE6_RE.test(rest)) return true;
  return false;
}

/**
 * Gather one list item starting at lines[j] (whose bullet match is bm), following the
 * reference's list algorithm. Returns { text, next, raw }.
 */
function gatherItem(lines, j, bm) {
  const b = bm.prefix.length;
  const restRaw = lines[j].slice(b);
  const leadWs = /^[ \t]+/.exec(restRaw);
  const m = leadWs ? expandTabs(leadWs[0], b) + restRaw.slice(leadWs[0].length) : restRaw;
  const firstBlank = !m.trim();
  let R;
  let d;
  if (firstBlank) {
    R = b + 1;
    d = '';
  } else {
    let r = m.search(/\S/);
    if (r > 4) r = 1;
    d = m.slice(r);
    R = r + b;
  }
  // Blank first line followed by a blank line: the item ends there.
  if (firstBlank && j + 1 < lines.length && isBlank(lines[j + 1])) {
    return { text: d, next: j + 2, raw: rawFor(lines, j, j + 1), last: j + 1 };
  }
  const beginIndent = Math.max(0, Math.min(3, R - 1));
  let prevM = m;
  let prevBlank = firstBlank;
  let k = j + 1;
  let last = j;
  while (k < lines.length) {
    const f = lines[k];
    const leadWsF = /^[ \t]+/.exec(f);
    const Z = leadWsF ? expandTabs(leadWsF[0], 0) + f.slice(leadWsF[0].length) : f;
    if (beginsBlock(f, beginIndent, true)) break;
    const firstNs = Z.search(/\S/);
    if (firstNs >= R || isBlank(f)) {
      d += `\n${Z.slice(R)}`;
    } else {
      // Lazy continuation or the end of the item.
      if (prevBlank) break;
      const pm = prevM.replace(/\t/g, '    ');
      if (
        pm.search(/\S/) >= 4 ||
        beginsBlock(pm, beginIndent, false)
      ) {
        break;
      }
      if (/^ {0,3}(?:=+|-+) *$/.test(f) && setextDepth(f) !== 0 && isLheadingPair(prevM, f)) {
        d += `\n    ${Z.replace(/^ {0,3}/, '')}`;
      } else {
        d += `\n${f}`;
      }
    }
    prevBlank = isBlank(f);
    prevM = Z.slice(R);
    last = k;
    k++;
  }
  return { text: d, next: k, raw: rawFor(lines, j, last), last };
}

function isLheadingPair(prevLine, underline) {
  // The reference tests its setext pattern against "previous content line + underline":
  // the content may not begin with a bullet, code indent, fence, quote, heading, a
  // complete tag line, or a table delimiter row.
  if (setextDepth(underline) === 0) return false;
  if (prevLine.trim().length === 0) return false;
  if (isIndented(prevLine)) return false;
  if (matchFenceStart(prevLine)) return false;
  if (QUOTE_RE.test(prevLine)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(prevLine)) return false;
  if (isHR(prevLine)) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(prevLine)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(prevLine)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\||)+[:\- ]*$/.test(prevLine) && prevLine.includes('|')) return false;
  return true;
}

/** Whether a line really starts a list item (marker followed by space, tab or end). */
function startsList(line) {
  const bm = matchBullet(line);
  if (!bm) return false;
  const after = line[bm.prefix.length];
  return after === undefined || after === ' ' || after === '\t';
}

function collectList(lines, i, refs) {
  const first = matchBullet(lines[i]);
  if (!first) return null;
  const after = lines[i][first.prefix.length];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  const items = [];
  let j = i;
  let loose = false;
  let prevDoubleBlank = false;
  while (j < lines.length) {
    if (isHR(lines[j])) break;
    const bm = matchBullet(lines[j]);
    if (!bm) break;
    if (bm.ordered !== first.ordered) break;
    if (first.ordered && bm.delim !== first.delim) break;
    if (!first.ordered && bm.marker !== first.marker) break;
    const afterCh = lines[j][bm.prefix.length];
    if (afterCh !== undefined && afterCh !== ' ' && afterCh !== '\t') break;
    const startJ = j;
    const got = gatherItem(lines, j, bm);
    if (prevDoubleBlank) loose = true;
    if (/\n[ \t]*\n[ \t]*$/.test(got.raw)) prevDoubleBlank = true;
    items.push(got);
    j = got.next;
    if (got.next <= startJ) break;
  }
  if (items.length === 0) return null;
  const parsed = items.map((got, idx) => {
    // The reference trims the last item's text before lexing it.
    const text = idx === items.length - 1 ? got.text.trimEnd() : got.text;
    const blocks = parseBlocks(text.split('\n'), refs, false);
    return { text, blocks };
  });
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx];
    if (item.blocks.looseSpace) loose = true;
    if (idx < parsed.length - 1 && item.blocks.trailingLoose) loose = true;
  }
  // Blank lines the last item gathered after its final content line: the list's
  // own raw is end-trimmed, so they reappear as a space gap after the list.
  let trailingGap = 0;
  {
    const lastItem = items[items.length - 1];
    let g = lastItem.last;
    while (g > i && isBlank(lines[g])) {
      trailingGap++;
      g--;
    }
    if (g === i && isBlank(lines[g])) trailingGap = 0;
  }
  // Task list items.
  for (const item of parsed) {
    item.task = false;
    item.checked = false;
    if (/^\[[ xX]\][ \t]+\S/.test(item.text)) {
      const firstBlock = item.blocks[0];
      if (firstBlock && (firstBlock.t === 'para' || firstBlock.t === 'text')) {
        item.task = true;
        item.checked = item.text[1] !== ' ';
        firstBlock.text = firstBlock.text.replace(/^\[[ xX]\][ \t]+/, '');
      }
    }
  }
  return {
    node: {
      t: 'list',
      ordered: first.ordered,
      start: first.start,
      loose,
      items: parsed,
      rawLines: lines.slice(i, j - trailingGap),
    },
    next: j,
    trailingGap,
  };
}

// --- Paragraphs ------------------------------------------------------------------

/** Whether the collected paragraph lines may become a setext heading. */
function setextContentValid(collected) {
  for (let idx = 1; idx < collected.length; idx++) {
    const ln = collected[idx];
    if (isIndented(ln)) return false;
    if (/^ {0,3}<[^\n>]+>$/.test(ln)) return false;
    if (/^ {0,3}\|?(?:[:\- ]*\||)+[:\- ]*$/.test(ln) && ln.includes('|')) return false;
  }
  return true;
}

function collectParagraph(lines, i, top, forced) {
  const collected = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const ln = lines[j];
    if (forced && forced.has(j)) {
      collected.push(ln);
      j++;
      continue;
    }
    if (isBlank(ln)) {
      // A spaces-only final line (nothing follows it, not even a newline) is
      // paragraph content in the reference's top-level paragraph pattern,
      // not a blank separator. In list-item context it is a space token.
      if (top && j === lines.length - 1 && ln.length > 0) {
        collected.push(ln);
        j++;
      }
      break;
    }
    const sd = setextDepth(ln);
    if (sd) {
      if (setextContentValid(collected)) {
        return {
          node: { t: 'heading', depth: sd, text: collected.join('\n').trim() },
          next: j + 1,
        };
      }
      break;
    }
    // In list-item context an indented line starts a code chunk, which the block
    // loop may merge into this paragraph; it is not a plain continuation.
    if (!top && isIndented(ln)) break;
    if (!top ? interruptsTextRun(lines, j) : interruptsParagraph(lines, j)) break;
    collected.push(ln);
    j++;
  }
  return { node: { t: top ? 'para' : 'text', text: collected.join('\n') }, next: j };
}

// --- The block loop ----------------------------------------------------------------

function isCodeLine(line) {
  if (/^ {4}/.test(line)) return line.length > 4;
  const m = /^ {0,3}\t/.exec(line);
  if (m) return line.length > m[0].length;
  return false;
}

function parseBlocks(lines, refs, top, forced) {
  const blocks = [];
  // Looseness evidence for an enclosing list: a space token whose raw holds two
  // newlines appeared in this token stream (looseSpace), possibly only at the very
  // end (trailingLoose — the caller discounts it for a final list item, whose text
  // the reference trims before lexing).
  blocks.looseSpace = false;
  blocks.trailingLoose = false;
  let i = 0;
  let blanks = 0;
  // Blank lines a just-finished list re-exposes: its raw is end-trimmed by the
  // reference, so blanks its last item gathered become a space gap after it.
  let pendingGap = 0;
  let processedAny = false;
  // Whether the immediately preceding token was a paragraph/text block; the
  // reference merges a following def or indented chunk into such a block, but
  // not when any other token (including a def) intervened.
  let prevWasParaText = false;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      blanks++;
      i++;
      continue;
    }
    const gap = blanks + pendingGap;
    const spaceBefore = gap;
    blanks = 0;
    pendingGap = 0;
    if (gap >= 2 || (gap >= 1 && processedAny)) blocks.looseSpace = true;
    let node = null;
    let handled = false;
    let next = i + 1;
    let newPending = 0;

    if (isIndented(line)) {
      // Indented code chunk: code lines and the blank lines among/after them.
      let k = i;
      while (k < lines.length && (isCodeLine(lines[k]) || isBlank(lines[k]))) k++;
      const raw = trimRawBlankLines(rawFor(lines, i, k - 1));
      const text = raw.split('\n').map(stripCodeIndent).join('\n');
      const prev = blocks[blocks.length - 1];
      if (!top && prev && prevWasParaText && spaceBefore === 0) {
        prev.text += `\n${text.replace(/\n$/, '')}`;
        handled = true;
      } else {
        node = { t: 'code', lang: null, text };
      }
      next = k;
    } else if (matchFenceStart(line)) {
      const f = matchFenceStart(line);
      let k = i + 1;
      const content = [];
      while (k < lines.length && !isFenceClose(lines[k], f.ch, f.len)) {
        content.push(lines[k]);
        k++;
      }
      const closed = k < lines.length;
      if (closed) k++; // consume the closing fence
      // An unclosed fence at the end of input: the final empty string produced by a
      // trailing newline is not a content line.
      let phantom = false;
      if (!closed && content.length > 0 && content[content.length - 1] === '') {
        content.pop();
        phantom = true;
      }
      // The reference's content capture drops exactly one trailing newline: the
      // content is the joined lines, plus their final terminator when there is one,
      // minus one newline.
      let text = content.join('\n');
      if (content.length > 0 && (closed || phantom || k < lines.length)) text += '\n';
      if (text.endsWith('\n')) text = text.slice(0, -1);
      if (f.ch === '`' && f.indent > 0) {
        const indentStr = line.slice(0, f.indent);
        text = text
          .split('\n')
          .map((cl) => {
            const mm = /^\s+/.exec(cl);
            if (!mm) return cl;
            return cl.slice(Math.min(mm[0].length, indentStr.length));
          })
          .join('\n');
      }
      node = { t: 'code', lang: unescapePunct(f.info.trim()), text };
      next = k;
    } else if (matchATX(line)) {
      const h = matchATX(line);
      node = { t: 'heading', depth: h.depth, text: h.text };
    } else if (isHR(line)) {
      node = { t: 'hr' };
    } else if (QUOTE_RE.test(line)) {
      const got = collectQuote(lines, i, refs);
      node = got.node;
      next = got.next;
    } else if (matchBullet(line)) {
      const got = collectList(lines, i, refs);
      if (got) {
        node = got.node;
        next = got.next;
        newPending = got.trailingGap;
      }
    }

    if (!node && !handled) {
      if (htmlBlockStart(line) || htmlType7(line)) {
        const got = consumeHtmlBlock(lines, i);
        node = { t: 'html', text: got.text };
        next = got.next;
      } else {
        const defNext = consumeDef(lines, i, refs);
        if (defNext !== null) {
          const prev = blocks[blocks.length - 1];
          if (prev && prevWasParaText && spaceBefore === 0) {
            const raw = lines.slice(i, defNext).join('\n');
            prev.text += `\n${raw}`;
          } else {
            prevWasParaText = false;
          }
          processedAny = true;
          // A definition's raw absorbs following empty lines outright.
          i = defNext;
          while (i < lines.length && lines[i] === '') i++;
          continue;
        }
        const tbl = matchTable(lines, i);
        if (tbl) {
          node = tbl.node;
          next = tbl.next;
        } else {
          const got = collectParagraph(lines, i, top, forced);
          node = got.node;
          next = got.next;
        }
      }
    }

    if (handled) {
      i = next;
      continue;
    }
    node.spaceBefore = spaceBefore;
    blocks.push(node);
    processedAny = true;
    prevWasParaText = node.t === 'para' || node.t === 'text';
    pendingGap = newPending;
    i = next;
  }
  if ((blanks >= 1 || pendingGap >= 1) && processedAny) blocks.trailingLoose = true;
  return blocks;
}

// --- Rendering -----------------------------------------------------------------------

function renderBlocks(blocks, refs, looseList = false, state = { inLink: false, inRawBlock: false }) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, looseList, state);
  return out;
}

function renderBlock(b, refs, looseList = false, state = { inLink: false, inRawBlock: false }) {
  switch (b.t) {
    case 'para':
      return `<p>${renderInline(b.text, refs, state)}</p>\n`;
    case 'text':
      return looseList
        ? `<p>${renderInline(b.text, refs, state)}</p>\n`
        : renderInline(b.text, refs, state);
    case 'heading':
      return `<h${b.depth}>${renderInline(b.text, refs, state)}</h${b.depth}>\n`;
    case 'code': {
      const body = b.text ? `${b.text.replace(/\n$/, '')}\n` : '';
      const langWord = b.lang ? b.lang.match(/^\S*/)[0] : '';
      const cls = langWord ? ` class="language-${escText(langWord)}"` : '';
      return `<pre><code${cls}>${escAll(body)}</code></pre>\n`;
    }
    case 'html':
      return b.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return `<blockquote>\n${renderBlocks(b.kids, refs, false, state)}</blockquote>\n`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      let out = `<${tag}${startAttr}>\n`;
      for (const item of b.items) {
        let inner = renderBlocks(item.blocks, refs, b.loose, state);
        if (item.task) {
          const box = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
          if (b.loose) {
            inner = inner.replace(/^<p>/, `<p>${box}`);
          } else {
            inner = box + inner;
          }
        }
        out += `<li>${inner}</li>\n`;
      }
      return `${out}</${tag}>\n`;
    }
    case 'table': {
      let head = '';
      for (let c = 0; c < b.header.length; c++) {
        const a = b.align[c];
        head += `${a ? `<th align="${a}">` : '<th>'}${renderInline(b.header[c], refs, state)}</th>\n`;
      }
      let out = `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n`;
      if (b.rows.length > 0) {
        let body = '';
        for (const row of b.rows) {
          let cells = '';
          for (let c = 0; c < row.length; c++) {
            const a = b.align[c];
            cells += `${a ? `<td align="${a}">` : '<td>'}${renderInline(row[c], refs, state)}</td>\n`;
          }
          body += `<tr>\n${cells}</tr>\n`;
        }
        out += `<tbody>${body}</tbody>`;
      }
      return `${out}</table>\n`;
    }
    default:
      return '';
  }
}

/** The HTML the reference renders for `markdown`, with its default options. */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const refs = Object.create(null);
  const blocks = parseBlocks(src.split('\n'), refs, true);
  return renderBlocks(blocks, refs, false, { inLink: false, inRawBlock: false });
}
