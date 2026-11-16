// parse.js — a from-scratch Markdown renderer whose output matches the
// HTML that marked 18.1.3 produces with its default options (GFM on,
// breaks off, pedantic off). Written for markdown-render-speed-02.
//
// Layout: small character helpers first, then the inline parser (which
// works on node lists with a delimiter stack for emphasis), then the
// block parser (line based, recursing into block quotes and list
// items), and finally the renderers that turn both into HTML strings.

// ---------------------------------------------------------------------
// Character classes and HTML escaping
// ---------------------------------------------------------------------

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isPunct(ch) {
  return ch !== undefined && PUNCT.has(ch);
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

// Unicode-aware whitespace test used by the flanking rules: anything
// JavaScript calls \s plus the zero-width no-break space CommonMark
// counts as punctuation-adjacent. Good enough for the corpus at hand.
function isUniSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}

function isUniPunct(ch) {
  if (ch === undefined) return false;
  if (PUNCT.has(ch)) return true;
  // Symbols and punctuation outside ASCII.
  return /[^\p{L}\p{N}\s]/u.test(ch);
}

// The character an escaped "\&" leaves behind must not be mistaken for
// the start of an entity reference later, so it travels through the
// inline tree as a sentinel and is only expanded while rendering.
const ESCAPED_AMP = '\u0001';

// Numeric character references are decoded while text is rendered:
// &#123; and &#x1F600; become the code point itself, with the usual
// replacement of NUL, surrogates and out-of-range values by U+FFFD.
// A value above 0x10FFFF is not a reference at all and stays literal.
function decodeNumericRefs(s) {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(\d+);|&#[xX]([0-9a-fA-F]+);/g, (whole, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp > 0x10ffff) return whole;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    const ch = String.fromCodePoint(cp);
    return ch === '&' ? ESCAPED_AMP : ch;
  });
}

// Escape text (and attribute values) the way marked does: &, <, >, "
// and ' are escaped, but an & that begins something shaped like a
// named reference (&word;) is left alone.
function escapeHtml(s) {
  return s
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Code blocks and code spans escape every &, with no entity exception.
function escapeCode(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTextNode(raw) {
  return escapeHtml(decodeNumericRefs(raw)).replaceAll(ESCAPED_AMP, '&amp;');
}

// ---------------------------------------------------------------------
// Inline parsing
//
// The scanner walks the source once and leaves a flat list of nodes.
// Square-bracket openers are tracked on their own stack so links and
// images can claim the nodes that follow them, and runs of *, _ and ~
// become delimiter nodes that a later pass folds into emphasis,
// strong and strikethrough nodes.
// ---------------------------------------------------------------------

const AUTOLINK_SCHEME = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTRIBUTE = '\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"\'=<>`]+|\'[^\']*\'|"[^"]*"))?';
const OPEN_TAG = new RegExp(`^<${TAG_NAME}(?:${ATTRIBUTE})*\\s*/?>`);
const CLOSE_TAG = new RegExp(`^</${TAG_NAME}\\s*>`);

// Try to read one raw HTML unit starting at src[i] === '<'. Returns the
// matched string or null. Comments, processing instructions, CDATA
// sections, declarations and ordinary open/close tags are recognised.
function scanHtmlInline(src, i) {
  const rest = src.slice(i);
  if (rest.startsWith('<!--')) {
    // The baseline accepts the two degenerate comments outright and
    // otherwise runs to the first --> even across inner -- pairs.
    if (rest.startsWith('<!-->')) return '<!-->';
    if (rest.startsWith('<!--->')) return '<!--->';
    const end = rest.indexOf('-->', 4);
    if (end === -1) return null;
    return rest.slice(0, end + 3);
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    return end === -1 ? null : rest.slice(0, end + 3);
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    return end === -1 ? null : rest.slice(0, end + 2);
  }
  if (rest.startsWith('<!')) {
    if (/^<![A-Z]/.test(rest)) {
      const end = rest.indexOf('>', 2);
      return end === -1 ? null : rest.slice(0, end + 1);
    }
    return null;
  }
  const m = OPEN_TAG.exec(rest) || CLOSE_TAG.exec(rest);
  return m ? m[0] : null;
}

// Find the ']' that closes a bracket opened just before `from`,
// honouring nesting and backslash escapes. Returns its index or -1.
function findClosingBracket(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Parse the "(destination "title")" part of an inline link starting at
// src[i] === '('. Returns { href, title, end } or null.
function scanLinkTarget(src, i) {
  let p = i + 1;
  const skipWs = () => { while (p < src.length && isSpace(src[p])) p++; };
  skipWs();
  let href = '';
  if (src[p] === '<') {
    p++;
    let buf = '';
    let ok = false;
    while (p < src.length) {
      const c = src[p];
      if (c === '\\' && isPunct(src[p + 1])) { buf += src[p + 1]; p += 2; continue; }
      if (c === '>') { ok = true; p++; break; }
      if (c === '\n' || c === '<') return null;
      buf += c; p++;
    }
    if (!ok) return null;
    href = buf;
  } else {
    let depth = 0;
    let buf = '';
    while (p < src.length) {
      const c = src[p];
      if (c === '\\' && isPunct(src[p + 1])) { buf += src[p + 1]; p += 2; continue; }
      if (c === '(') { depth++; buf += c; p++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; buf += c; p++; continue;
      }
      if (isSpace(c) || c.charCodeAt(0) < 0x20) break;
      buf += c; p++;
    }
    if (depth !== 0) return null;
    href = buf;
  }
  const afterDest = p;
  skipWs();
  let title = null;
  const q = src[p];
  if (p > afterDest && (q === '"' || q === "'" || q === '(')) {
    const close = q === '(' ? ')' : q;
    let buf = '';
    let ok = false;
    p++;
    while (p < src.length) {
      const c = src[p];
      if (c === '\\' && isPunct(src[p + 1])) { buf += src[p + 1]; p += 2; continue; }
      if (c === close) { ok = true; p++; break; }
      if (q === '(' && c === '(') return null;
      buf += c; p++;
    }
    if (!ok) return null;
    title = buf;
    skipWs();
  } else {
    p = afterDest;
    skipWs();
  }
  if (src[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// Read a reference label starting at src[i] === '[' (the second bracket
// pair of a full reference link). Returns { label, end } or null.
function scanRefLabel(src, i) {
  let buf = '';
  let p = i + 1;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\' && isPunct(src[p + 1])) { buf += src[p] + src[p + 1]; p += 2; continue; }
    if (c === ']') return { label: buf, end: p + 1 };
    if (c === '[') return null;
    buf += c; p++;
    if (buf.length > 999) return null;
  }
  return null;
}

function normaliseLabel(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

// The label a reference uses is the bracketed text exactly as written:
// the baseline compares labels without resolving backslash escapes, so
// a reference written [foo\!] does not match a definition for [foo!].
function labelFromRaw(raw) {
  return raw;
}

// GFM extended autolinks: www.…, http(s)://… and bare email addresses
// become links when they show up in running text. Trailing punctuation
// that cannot be part of the address is handed back to the text.
const URL_START = /^(?:[hH][tT][tT][pP][sS]?:\/\/|www\.)[^\s<]+/;
const EMAIL_BODY = "[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+";
const EMAIL_START = new RegExp('^' + EMAIL_BODY);
const MAILTO_START = new RegExp('^(mailto|xmpp):(' + EMAIL_BODY + ')', 'i');

function trimAutolink(url) {
  let s = url;
  // An opening parenthesis with no closing one anywhere after it ends
  // the address: the match is cut back to just before it, repeatedly.
  for (;;) {
    const open = s.lastIndexOf('(');
    if (open === -1 || s.indexOf(')', open) !== -1) break;
    s = s.slice(0, open);
  }
  for (;;) {
    const before = s;
    // A trailing entity-shaped &…; is not part of the link at all.
    const ent = /&[A-Za-z][A-Za-z0-9]*;$/.exec(s);
    if (ent && ent.index > 0) s = s.slice(0, ent.index);
    s = s.replace(/[?!.,:*_~;]+$/, '');
    // Unbalanced closing parentheses are dropped one at a time.
    // The balance is counted only from the first opening
    // parenthesis onward: a closing parenthesis before it is just
    // a character of the address.
    while (s.endsWith(')')) {
      const firstOpen = s.indexOf('(');
      if (firstOpen === -1) { s = s.slice(0, -1); continue; }
      const tail = s.slice(firstOpen);
      const opens = (tail.match(/\(/g) || []).length;
      const closes = (tail.match(/\)/g) || []).length;
      if (closes <= opens) break;
      s = s.slice(0, -1);
    }
    if (s === before) break;
  }
  return s;
}

// Can an extended autolink begin at src[i]? It must not be glued to a
// word character, a dash, a dot or an @ on its left.
function autolinkContextOk(src, i) {
  if (i === 0) return true;
  const prev = src[i - 1];
  return !/[A-Za-z0-9.@\-_~/]/.test(prev);
}

// Where does the bracket opened just before `from` close? The
// baseline locates a link's closing bracket with its own scan:
// nested brackets count, backslash escapes skip a character, and
// backtick runs are consumed in pairs — a run is skipped over
// together with the NEXT run of any length, wherever that leads.
// A run with no successor kills the bracket, except for a run of
// two or more that ends the bracketed text outright (the closing
// bracket is the very next character). Returns the index of the
// closing ']' or -1.
function markedBracketEnd(src, from) {
  let depth = 0;
  let j = from;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (src[k] === '`') k++;
      // The run pairs with the next backtick run, but only if that
      // run comes before the bracket's own closing ']': a run
      // whose partner lies beyond it is unpaired.
      let nxt = -1;
      let d = depth;
      for (let p = k; p < src.length; p++) {
        const ch = src[p];
        if (ch === '\\') { p++; continue; }
        if (ch === '`') { nxt = p; break; }
        if (ch === '[') d++;
        else if (ch === ']') {
          if (d === depth) break;
          d--;
        }
      }
      if (nxt === -1) {
        if (k - j >= 2 && depth === 0 && src[k] === ']') { j = k; continue; }
        return -1;
      }
      let m = nxt;
      while (src[m] === '`') m++;
      j = m;
      continue;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) return j;
      depth--; j++; continue;
    }
    j++;
  }
  return -1;
}

// Does this link text leave a backtick run unmatched when it is
// lexed on its own? Runs pair up with the next run of exactly the
// same length; a run with no such partner is unmatched. Escaped
// backticks do not count.
function textHasUnmatchedBacktick(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] !== '`') { i++; continue; }
    let run = 0;
    while (text[i + run] === '`') run++;
    let j = i + run;
    let found = false;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '`') {
        let r = 0;
        while (text[j + r] === '`') r++;
        if (r === run) { found = true; j += r; break; }
        j += r;
      } else j++;
    }
    if (!found) return true;
    i = j;
  }
  return false;
}

// Record a dead-bracket zone: the bracket at bracketPos cannot be
// closed by the baseline's scan, but a ']' followed by a complete
// parenthesised part exists — the whole thing is one failed link.
function noteDeadZone(src, bracketPos) {
  const rb = src.indexOf(']', bracketPos + 1);
  if (rb === -1 || src[rb + 1] !== '(') return;
  if (src.indexOf(')', rb + 2) === -1) return;
  deadZones.push([bracketPos, rb]);
}

function parseInlineNodes(src, links) {
  const nodes = [];
  activeNodes = nodes;
  poisonFrom = -1;
  poisonRuns = [];
  deadZones = [];
  const brackets = []; // { node, image, active, delimAt, srcEnd }
  const delims = [];   // delimiter records in document order
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text) { nodes.push({ k: 'text', s: text }); text = ''; }
  };
  const pushText = (s) => { text += s; };

  const flanking = (before, after) => {
    const leftFlank = !isUniSpace(after) && (!isUniPunct(after) || isUniSpace(before) || isUniPunct(before));
    const rightFlank = !isUniSpace(before) && (!isUniPunct(before) || isUniSpace(after) || isUniPunct(after));
    return { leftFlank, rightFlank };
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        // Hard break: the spaces before it were already emitted into
        // the text run only when they are ordinary text; here the
        // backslash form simply breaks.
        flushText();
        nodes.push({ k: 'br' });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (isPunct(next)) {
        pushText(next === '&' ? ESCAPED_AMP : next);
        i += 2;
        continue;
      }
      pushText('\\');
      i += 1;
      continue;
    }

    if (c === '`') {
      poisonRuns.push(i);
      let run = 0;
      while (src[i + run] === '`') run++;
      // Look for a closing run of exactly the same length.
      let j = i + run;
      let closeAt = -1;
      while (j < src.length) {
        if (src[j] === '`') {
          let r = 0;
          while (src[j + r] === '`') r++;
          if (r === run) { closeAt = j; break; }
          j += r;
        } else j++;
      }
      if (closeAt === -1) {
        pushText('`'.repeat(run));
        i += run;
        continue;
      }
      // A span may not swallow the closing bracket of an open link
      // or image: the baseline finds that bracket first (see
      // markedBracketEnd), so a span that would cross it does not
      // form and the backticks stay literal text.
      let crosses = false;
      for (const br of brackets) {
        if (br.endAt > i && br.endAt < closeAt) { crosses = true; break; }
      }
      if (crosses) {
        pushText('`'.repeat(run));
        i += run;
        continue;
      }
      let content = src.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ k: 'code', s: content });
      i = closeAt + run;
      continue;
    }

    if (c === '<') {
      const rest = src.slice(i);
      const auto = AUTOLINK_SCHEME.exec(rest);
      if (auto) {
        flushText();
        const label = { k: 'text', s: auto[1] };
        nodes.push({ k: 'link', href: auto[1], title: null, kids: [label] });
        i += auto[0].length;
        continue;
      }
      const mail = AUTOLINK_EMAIL.exec(rest);
      if (mail) {
        flushText();
        const label = { k: 'text', s: mail[1] };
        nodes.push({ k: 'link', href: 'mailto:' + mail[1], title: null, kids: [label] });
        i += mail[0].length;
        continue;
      }
      const html = scanHtmlInline(src, i);
      if (html) {
        flushText();
        nodes.push({ k: 'raw', s: html });
        noteAnchorTag(html);
        i += html.length;
        continue;
      }
      pushText('<');
      i += 1;
      continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      flushText();
      const node = { k: 'open', image: true };
      nodes.push(node);
      const endAt = markedBracketEnd(src, i + 2);
      if (endAt === -1) noteDeadZone(src, i + 1);
      brackets.push({ node, image: true, active: endAt !== -1, delimAt: delims.length, srcEnd: i + 2, endAt });
      i += 2;
      continue;
    }

    if (c === '[') {
      flushText();
      const node = { k: 'open', image: false };
      nodes.push(node);
      const endAt = markedBracketEnd(src, i + 1);
      if (endAt === -1) noteDeadZone(src, i);
      brackets.push({ node, image: false, active: endAt !== -1, delimAt: delims.length, srcEnd: i + 1, endAt });
      i += 1;
      continue;
    }

    if (c === ']') {
      flushText();
      const br = brackets[brackets.length - 1];
      if (!br || !br.active) {
        if (br) brackets.pop();
        pushText(']');
        i += 1;
        continue;
      }
      const openIdx = nodes.indexOf(br.node);
      // The label of a shortcut/collapsed reference is the raw source
      // between the brackets, which the opener recorded.
      const innerRaw = src.slice(br.srcEnd, i);
      let formed = null;
      let endPos = i + 1;
      let refScanned = false;
      if (src[i + 1] === '(') {
        const t = scanLinkTarget(src, i + 1);
        if (t) {
          formed = { href: t.href, title: t.title };
          endPos = t.end;
        }
      }
      if (!formed && src[i + 1] === '[') {
        const lab = scanRefLabel(src, i + 1);
        if (lab) {
          refScanned = true;
          const key = normaliseLabel(lab.label === '' ? labelFromRaw(innerRaw) : lab.label);
          const def = links.get(key);
          if (def) {
            formed = { href: def.href, title: def.title };
            endPos = lab.end;
          }
        }
      }
      if (!formed && !refScanned) {
        // A failed inline target or an incomplete reference falls back
        // to a shortcut reference on the bracketed text itself; a
        // complete but unknown [label] does not.
        const key = normaliseLabel(labelFromRaw(innerRaw));
        const def = key ? links.get(key) : undefined;
        if (def) formed = { href: def.href, title: def.title };
      }
      brackets.pop();
      if (!formed) {
        pushText(']');
        i += 1;
        continue;
      }
      // Emphasis inside the link text is resolved on its own: delimiter
      // records from the text are sealed off afterwards so they can
      // never pair with delimiters outside the brackets.
      processDelims(delims, br.delimAt);
      delims.length = br.delimAt;
      const kids = nodes.splice(openIdx + 1);
      nodes.pop(); // the opener placeholder itself
      if (!br.image) flattenAutolinks(kids);
      const linkNode = {
        k: br.image ? 'image' : 'link',
        href: formed.href,
        title: formed.title,
        kids,
      };
      nodes.push(linkNode);
      // A link or image whose own text leaves a backtick run
      // unmatched poisons the rest of the paragraph for emphasis:
      // from here on, an emphasis pair forms only when no backtick
      // run follows its closer (see processDelims).
      if (poisonFrom === -1 && textHasUnmatchedBacktick(innerRaw)) poisonFrom = endPos;
      if (!br.image) {
        // A link deactivates every earlier link opener: links cannot
        // contain links. Images stay usable.
        for (let b = brackets.length - 1; b >= 0; b--) {
          if (!brackets[b].image) brackets[b].active = false;
        }
      }
      i = endPos;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (src[i + run] === c) run++;
      if (c === '~' && run > 2) {
        pushText('~'.repeat(run));
        i += run;
        continue;
      }
      const before = i === 0 ? undefined : src[i - 1];
      const after = i + run >= src.length ? undefined : src[i + run];
      const { leftFlank, rightFlank } = flanking(before, after);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isUniPunct(before));
        canClose = rightFlank && (!leftFlank || isUniPunct(after));
      } else { canOpen = leftFlank; canClose = rightFlank; }
      flushText();
      const node = { k: 'delim', ch: c, n: run, orig: run, open: canOpen, close: canClose, pos: i };
      nodes.push(node);
      delims.push({ node, ch: c });
      i += run;
      continue;
    }

    if (c === '\n') {
      // Two trailing spaces (or more) before the line end: hard break.
      let spaces = 0;
      let j = i - 1;
      while (j >= 0 && src[j] === ' ') { spaces++; j--; }
      if (spaces >= 2 && j >= 0 && src[j] !== '\n') {
        // Remove those spaces from the pending text run.
        let cut = spaces;
        while (cut > 0 && text.endsWith(' ')) { text = text.slice(0, -1); cut--; }
        flushText();
        nodes.push({ k: 'br' });
        i += 1;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      pushText('\n');
      i += 1;
      continue;
    }

    // GFM extended autolinks starting inside running text. They are
    // suppressed while an attribute-bearing <a> tag is unclosed
    // anywhere earlier in the document (the baseline tracks that
    // state across blocks).
    if (!aTagOpen && (c === 'w' || c === 'W' || c === 'h' || c === 'H' || c === '@' || /[A-Za-z0-9._%+-]/.test(c)) && autolinkContextOk(src, i)) {
      const rest = src.slice(i);
      const url = URL_START.exec(rest);
      if (url) {
        let rawUrl = url[0];
        // Inside an open bracket the address may not swallow the
        // closing bracket that the link matcher is waiting for.
        if (brackets.some((b) => b.active)) {
          const cut = rawUrl.indexOf(']');
          if (cut !== -1) rawUrl = rawUrl.slice(0, cut);
        }
        const trimmed = trimAutolink(rawUrl);
        const isWww = trimmed.startsWith('www.');
        const plausible = isWww
          ? trimmed.length > 4 && trimmed.slice(4).includes('.')
          : trimmed.length > 7;
        if (plausible) {
          flushText();
          const href = isWww ? 'http://' + trimmed : trimmed;
          nodes.push({ k: 'link', auto: true, href, title: null, kids: [{ k: 'text', s: trimmed }] });
          i += trimmed.length;
          continue;
        }
      }
      {
        // Scheme-prefixed addresses (mailto:, xmpp:) link as a unit;
        // xmpp allows one resource path segment after the address.
        const pm = MAILTO_START.exec(rest);
        if (pm) {
          let full = pm[0];
          if (pm[1].toLowerCase() === 'xmpp') {
            const seg = /^\/[^\s/]*/.exec(rest.slice(full.length));
            if (seg) full += seg[0];
          }
          const afterP = rest[full.length];
          if (afterP === undefined || !/[A-Za-z0-9_-]/.test(afterP)
              || (afterP === '_' && delims.some((d) => d.ch === '_' && d.node.open))) {
            flushText();
            nodes.push({ k: 'link', auto: true, href: full, title: null, kids: [{ k: 'text', s: full }] });
            i += full.length;
            continue;
          }
        }
        const em = EMAIL_START.exec(rest);
        if (em) {
          const afterE = rest[em[0].length];
          if (afterE === undefined || !/[A-Za-z0-9_-]/.test(afterE)
              || (afterE === '_' && delims.some((d) => d.ch === '_' && d.node.open))) {
            flushText();
            nodes.push({ k: 'link', auto: true, href: 'mailto:' + em[0], title: null, kids: [{ k: 'text', s: em[0] }] });
            i += em[0].length;
            continue;
          }
        }
      }
    }

    pushText(c);
    i += 1;
  }
  flushText();
  processDelims(delims, 0);
  return nodes;
}

// Fold delimiter records into em/strong/del nodes. `bottom` is the
// index in `delims` below which records belong to an outer context
// (the text of an enclosing link, for instance) and stay untouched.
function processDelims(delims, bottom) {
  let ci = bottom;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.node || closer.node.n === 0 || !closer.node.close) { ci++; continue; }
    // Nearest earlier opener of the same character.
    let oi = ci - 1;
    let opener = null;
    let use = 0;
    let blocked = false;
    while (oi >= bottom) {
      const cand = delims[oi];
      if (cand.ch === closer.ch && cand.node && cand.node.n > 0 && cand.node.open) {
        // The "sum of lengths" rule for * and _, on original lengths.
        if (closer.ch !== '~' && (closer.node.open || cand.node.close)) {
          const sum = cand.node.orig + closer.node.orig;
          if (sum % 3 === 0 && (cand.node.orig % 3 !== 0 || closer.node.orig % 3 !== 0)) {
            oi--;
            continue;
          }
        }
        use = closer.ch === '~'
          ? Math.min(2, cand.node.n, closer.node.n)
          : (cand.node.n >= 2 && closer.node.n >= 2 ? 2 : 1);
        // Dead-bracket zones (see noteDeadZone): emphasis pairs
        // wholly inside a failed link's brackets do not form.
        if (deadZones.some(([a, b]) => cand.node.pos > a && closer.node.pos < b)) {
          blocked = true;
          break;
        }
        // Emphasis poison (see parseInlineNodes): after a link or
        // image whose text left a backtick run unmatched, a pair
        // that starts past that link does not form while any
        // backtick run still follows the closer.
        if (poisonFrom >= 0 && cand.node.pos >= poisonFrom
            && poisonRuns.some((p) => p > closer.node.pos)) {
          blocked = true;
          break;
        }
        // A single * never takes one character from a ** opener when
        // a later ** closer is still waiting for that opener: the
        // strong wins and the single closer pairs with nothing.
        if (closer.ch === '*' && closer.node.n === 1 && cand.node.n === 2
            && delims.some((d, j) => j > ci && d.ch === '*' && d.node && d.node.close && d.node.n >= 2)) {
          blocked = true;
          break;
        }
        // The baseline refuses a single-* emphasis whose span holds
        // a strong that is whitespace-separated on its left and
        // glued to an alphanumeric on its right ("*a **b**c*" stays
        // literal). A one-character closer then pairs with nothing
        // at all; a longer closer just skips this opener.
        if (closer.ch === '*' && use === 1 && gluedStrongBetween(cand.node, closer.node)) {
          if (closer.node.n === 1) { blocked = true; break; }
          oi--;
          continue;
        }
        opener = cand;
        break;
      }
      oi--;
    }
    if (blocked) { ci++; continue; }
    if (!opener) { ci++; continue; }
    opener.node.n -= use;
    closer.node.n -= use;
    wrapDelim(opener.node, closer.node, closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', closer.ch);
    // Records between the pair are spent.
    for (let k = oi + 1; k < ci; k++) delims[k].node = null;
    if (opener.node.n === 0) delims[oi].node = null;
    if (closer.node.n === 0) { delims[ci].node = null; ci++; }
  }
}

// wrapDelim needs access to the node list, which lives in the caller;
// parseInlineNodes passes its list through this module-level slot
// while it runs (the parser is single-threaded and non-reentrant
// between a scan and its delimiter pass).
let activeNodes = null;

// Emphasis poison: set when a link or image whose text leaves a
// backtick run unmatched is formed (poisonFrom = the source index
// just past that link), together with the positions of the backtick
// runs the scan has met (poisonRuns). Both live for one inline
// string; parseInlineNodes resets them.
let poisonFrom = -1;
let poisonRuns = [];

// Dead-bracket zones: a bracket the baseline's scan cannot close
// (markedBracketEnd fails) that is nevertheless followed by a
// parenthesised destination is treated as one failed link: code
// spans inside it still form, emphasis does not. Each zone is a
// [start, end] pair of source indices (the '[' and its ']').
let deadZones = [];

// Document-wide anchor state: an inline <a tag (the name followed
// by whitespace, with or without attributes) opens it and an
// inline </a> closes it; while it is open the extended autolinks
// stay off. A bare <a> or <a/> does not open it. Reset for every
// document in parse().
let aTagOpen = false;
function noteAnchorTag(html) {
  if (/^<\/a(?=[\s>])/i.test(html)) { aTagOpen = false; return; }
  if (/^<a(?=\s)/i.test(html)) aTagOpen = true;
}
function wrapDelim(openNode, closeNode, kind, ch) {
  const list = activeNodes;
  const a = list.indexOf(openNode);
  const b = list.indexOf(closeNode);
  const inner = list.splice(a + 1, b - a - 1);
  // A strong closer with characters to spare leaves them inside
  // the strong when they are glued to a nested emphasis through a
  // whitespace-free fragment ("**a *b*c***" keeps the spare star
  // inside); otherwise they stay outside.
  if (kind === 'strong' && closeNode.n > 0 && inner.length >= 2) {
    const last = inner[inner.length - 1];
    let prev = null;
    for (let k = inner.length - 2; k >= 0; k--) {
      if (inner[k].k === 'delim' && inner[k].n === 0) continue;
      prev = inner[k];
      break;
    }
    if (prev && last.k === 'text' && !/\s/.test(last.s)
        && (prev.k === 'em' || prev.k === 'strong' || prev.k === 'del')) {
      inner.push({ k: 'text', s: ch.repeat(closeNode.n) });
      closeNode.n = 0;
    }
  }
  list.splice(a + 1, 0, { k: kind, ch, kids: inner });
}

// Does the node span between two delimiters contain an asterisk strong
// that sits after whitespace and directly before an alphanumeric? The
// baseline's emphasis matcher cannot span such a strong with a
// single-* emphasis. Spent delimiter nodes are invisible for this.
function gluedStrongBetween(openNode, closeNode) {
  const list = activeNodes;
  const a = list.indexOf(openNode);
  const b = list.indexOf(closeNode);
  if (a === -1 || b === -1) return false;
  const spent = (n) => n.k === 'delim' && n.n === 0;
  for (let j = a + 1; j < b; j++) {
    const node = list[j];
    if (node.k !== 'strong' || node.ch !== '*') continue;
    let p = j - 1;
    while (p > a && spent(list[p])) p--;
    let q = j + 1;
    while (q < b && spent(list[q])) q++;
    const prev = p > a ? list[p] : null;
    const next = q < b ? list[q] : null;
    if (prev && prev.k === 'text' && /\s$/.test(prev.s)
      && next && next.k === 'text' && /^[\p{L}\p{N}]/u.test(next.s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------

// marked drops or rewrites dangerous destinations: a destination that
// (after trimming) begins with javascript:, vbscript: or a data: URL
// for an HTML page does not survive into the href.
function cleanHref(href) {
  if (/^(?:javascript:|vbscript:|data:text\/html)/i.test(href.trim())) return null;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

function renderHrefAttr(href) {
  const clean = cleanHref(href);
  if (clean === null) return '';
  return ` href="${escapeHtml(clean)}"`;
}

function renderTitleAttr(title) {
  if (title === null || title === undefined) return '';
  return ` title="${escapeHtml(title)}"`;
}

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text': out += renderTextNode(node.s); break;
      case 'raw': out += node.s; break;
      case 'code': out += `<code>${escapeCode(node.s)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'open': out += node.image ? '![' : '['; break;
      case 'delim': out += node.ch.repeat(node.n); break;
      case 'em': out += `<em>${renderInline(node.kids)}</em>`; break;
      case 'strong': out += `<strong>${renderInline(node.kids)}</strong>`; break;
      case 'del': out += `<del>${renderInline(node.kids)}</del>`; break;
      case 'link':
        out += `<a${renderHrefAttr(node.href)}${renderTitleAttr(node.title)}>${renderInline(node.kids)}</a>`;
        break;
      case 'image':
        out += `<img src="${escapeHtml(cleanHref(node.href) ?? '')}" alt="${escapeHtml(plainText(node.kids))}"${renderTitleAttr(node.title)}>`;
        break;
    }
  }
  return out;
}

// The plain-text content of an inline subtree, used for image alt
// attributes: markup falls away, text and code stay.
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text': out += decodeNumericRefs(node.s).replaceAll(ESCAPED_AMP, '&'); break;
      case 'code': out += node.s; break;
      case 'br': out += ' '; break;
      case 'open': out += node.image ? '![' : '['; break;
      case 'delim': out += node.ch.repeat(node.n); break;
      case 'raw': break;
      default: out += plainText(node.kids || []); break;
    }
  }
  return out;
}

// Autolinks never form inside link text in the baseline: any that
// were scanned while the brackets were open are flattened back to
// plain text once the link closes.
function flattenAutolinks(kids) {
  for (let k = 0; k < kids.length; k++) {
    const kid = kids[k];
    if (kid.k === 'link' && kid.auto && kid.kids.length === 1 && kid.kids[0].k === 'text') {
      kids[k] = kid.kids[0];
    } else if (kid.kids) {
      flattenAutolinks(kid.kids);
    }
  }
}

function inlineToHtml(src, links) {
  return renderInline(parseInlineNodes(src, links));
}

// ---------------------------------------------------------------------
// Block parsing
//
// The block parser works on arrays of lines. Containers (block quotes
// and list items) are handled by gathering the lines that belong to
// them, stripping their markers/indentation, and recursing — so the
// main loop only ever deals with one level at a time.
// ---------------------------------------------------------------------

// Leading indentation of a line in columns; a tab advances to the next
// multiple of four.
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove the first n columns of a line. Every character is skipped by
// its column width (a tab advances to the next multiple of four); a
// tab that straddles the boundary is replaced by the spaces that
// remain of it.
function stripColumns(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    const width = c === '\t' ? 4 - (col % 4) : 1;
    if (col + width <= n) { col += width; i++; }
    else return ' '.repeat(col + width - n) + line.slice(i + 1);
  }
  return line.slice(i);
}

// Like stripColumns, but for text that will be parsed as blocks again
// (block quote contents, list item contents): the leading whitespace
// run of the remainder is expanded into plain spaces, each tab keeping
// the column width it had in the original line, so later indentation
// measurements stay true.
function sliceContent(line, n) {
  let col = 0;
  let i = 0;
  let head = '';
  while (i < line.length && col < n) {
    const c = line[i];
    const width = c === '\t' ? 4 - (col % 4) : 1;
    if (col + width <= n) { col += width; i++; }
    else {
      head = ' '.repeat(col + width - n);
      col += width;
      i++;
      break;
    }
  }
  let out = head;
  let vcol = col; // original column of the next unconsumed character
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { out += ' '; vcol++; j++; }
    else {
      const w = 4 - (vcol % 4);
      out += ' '.repeat(w);
      vcol += w;
      j++;
    }
  }
  return out + line.slice(j);
}

// Remove up to n columns of leading whitespace (never touching the
// text itself); a tab that straddles the boundary leaves its remaining
// width behind as spaces.
function stripIndentUpTo(line, n) {
  let col = 0;
  let i = 0;
  let head = '';
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; } else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; } else { head = ' '.repeat(col + w - n); col = n; i++; break; }
    } else break;
  }
  return head + line.slice(i);
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?/;

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Which kind of HTML block (CommonMark's seven types) a line opens, or
// 0 when it opens none. `inParagraph` suppresses type 7.
function htmlBlockStart(line, inParagraph) {
  // Fast path: every HTML block starts with '<' within three spaces.
  let p = 0;
  while (p < 3 && line[p] === ' ') p++;
  if (line[p] !== '<') return 0;
  const m = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(line);
  if (/^ {0,3}<\!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Z]/.test(line)) return 4;
  if (/^ {0,3}<\!\[/.test(line) && /^ {0,3}<\!\[CDATA\[/.test(line)) return 5;
  if (m) {
    const name = m[2].toLowerCase();
    if (m[1] !== '/' && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) {
      const after = line.slice(m[0].length);
      if (after === '' || /^[\s>]/.test(after)) return 1;
    }
    if (BLOCK_TAGS.has(name)) {
      const after = line.slice(m[0].length);
      if (after === '' || /^[\s/>]/.test(after)) return 6;
    }
    if (!inParagraph) {
      // Type 7: a complete open or closing tag alone on the line.
      const rest = line.replace(/^ {0,3}/, '');
      if ((OPEN_TAG.test(rest) || CLOSE_TAG.test(rest)) && /^[ \t]*$/.test(rest.replace((OPEN_TAG.exec(rest) || CLOSE_TAG.exec(rest))[0], ''))) {
        if (!BLOCK_TAGS.has(name)) return 7;
      }
    }
  }
  return 0;
}

// Does this line interrupt a paragraph in progress? Ordered lists
// interrupt a top-level paragraph only when they start at 1; inside
// containers marked lets any start number interrupt.
function interruptsParagraph(line, top) {
  if (FENCE_RE.test(line)) {
    const m = FENCE_RE.exec(line);
    if (!(m[1][0] === '`' && m[2].includes('`'))) return true;
  }
  if (ATX_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  const t = htmlBlockStart(line, true);
  if (t >= 1 && t <= 6) return true;
  const lm = matchListMarker(line);
  if (lm && lm.content.trim() !== '') {
    if (!lm.ordered) return true;
    if (lm.ordered && (lm.start === 1 || !top)) return true;
  }
  return false;
}

// Parse a list marker at the start of a line. Returns null when the
// line does not open a list item.
function matchListMarker(line) {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const rest = stripColumns(line, indent);
  let m = /^([-+*])([ \t]*)(.*)$/.exec(rest);
  let ordered = false;
  let start = null;
  let markerLen = 0;
  let bullet = null;
  let delim = null;
  if (m && (m[2].length > 0 || m[3] === '')) {
    bullet = m[1];
    markerLen = 1;
  } else {
    m = /^(\d{1,9})([.)])([ \t]*)(.*)$/.exec(rest);
    if (!m || (m[3].length === 0 && m[4] !== '')) return null;
    ordered = true;
    start = parseInt(m[1], 10);
    delim = m[2];
    markerLen = m[1].length + 1;
    bullet = null;
  }
  if (!ordered && !bullet) return null;
  const wsPart = ordered ? m[3] : m[2];
  const content = ordered ? m[4] : m[3];
  // Columns of whitespace between the end of the marker and content.
  const markerEndCol = indent + markerLen;
  let spaceCols = 0;
  {
    let col = markerEndCol;
    for (const ch of wsPart) {
      if (ch === ' ') { spaceCols++; col++; }
      else if (ch === '\t') { const w = 4 - (col % 4); spaceCols += w; col += w; }
    }
  }
  let contentCol;
  if (content === '' || spaceCols > 4) contentCol = markerEndCol + 1;
  else contentCol = markerEndCol + spaceCols;
  return { ordered, start, bullet, delim, indent, markerLen, contentCol, content };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

// Split a table row into cell strings. Pipes escaped as \| or sitting
// inside a code span do not split. Leading and trailing pipes are
// structural and come off.
function splitRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let endedWithSplit = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; endedWithSplit = false; continue; }
    // Every unescaped pipe is a delimiter — the baseline does not
    // let code spans protect a pipe inside a table row.
    if (c === '|') { cells.push(cur); cur = ''; endedWithSplit = true; continue; }
    cur += c;
    endedWithSplit = false;
  }
  cells.push(cur);
  // Drop the empty artefacts of a leading/trailing delimiter pipe.
  if (cells.length > 1 && s.startsWith('|')) cells.shift();
  if (cells.length > 1 && endedWithSplit) cells.pop();
  // An escaped pipe in a cell is content, not a delimiter — GFM takes
  // the backslash away here, even inside code spans.
  return cells.map((c) => {
    let out = '';
    const t = c.trim();
    for (let k = 0; k < t.length; k++) {
      if (t[k] === '\\' && t[k + 1] === '|') { out += '|'; k++; }
      else if (t[k] === '\\' && t[k + 1] === '\\') { out += '\\\\'; k++; }
      else out += t[k];
    }
    return out;
  });
}

function isDelimiterRow(line) {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

// Try to read one link reference definition at the start of `text`.
// Returns { label, href, title, end } or null.
function scanDef(text) {
  let p = 0;
  // A definition may sit under up to three columns of indentation.
  while (p < 3 && text[p] === ' ') p++;
  if (text[p] !== '[') return null;
  let label = '';
  p++;
  let closed = false;
  while (p < text.length) {
    const c = text[p];
    if (c === '\\' && isPunct(text[p + 1])) { label += text[p] + text[p + 1]; p += 2; continue; }
    if (c === ']') { closed = true; p++; break; }
    if (c === '[') return null;
    label += c; p++;
  }
  if (!closed || normaliseLabel(label) === '') return null;
  if (text[p] !== ':') return null;
  p++;
  // Optional whitespace with at most one line ending.
  const skipGap = () => {
    while (text[p] === ' ' || text[p] === '\t') p++;
    if (text[p] === '\n') {
      p++;
      while (text[p] === ' ' || text[p] === '\t') p++;
    }
  };
  skipGap();
  let href = '';
  if (text[p] === '<') {
    p++;
    let buf = '';
    let ok = false;
    while (p < text.length) {
      const c = text[p];
      if (c === '\\' && isPunct(text[p + 1])) { buf += text[p + 1]; p += 2; continue; }
      if (c === '>') { ok = true; p++; break; }
      if (c === '\n' || c === '<') return null;
      buf += c; p++;
    }
    if (!ok) return null;
    href = buf;
  } else {
    let depth = 0;
    let buf = '';
    while (p < text.length) {
      const c = text[p];
      if (c === '\\' && isPunct(text[p + 1])) { buf += text[p + 1]; p += 2; continue; }
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      if (isSpace(c)) break;
      buf += c; p++;
    }
    if (buf === '' || depth !== 0) return null;
    href = buf;
  }
  const afterDest = p;
  // The title is tentative: it must be separated from the destination
  // by whitespace and the definition must end cleanly after it. When
  // the title does not parse out, the definition still stands without
  // one, provided it ends right after the destination.
  let title = null;
  let end = -1;
  {
    let q = afterDest;
    let gap = 0;
    while (text[q] === ' ' || text[q] === '\t') { q++; gap++; }
    if (text[q] === '\n') {
      q++;
      gap++;
      while (text[q] === ' ' || text[q] === '\t') q++;
    }
    const qc = text[q];
    if (gap > 0 && (qc === '"' || qc === "'" || qc === '(')) {
      const close = qc === '(' ? ')' : qc;
      let buf = '';
      let ok = false;
      q++;
      while (q < text.length) {
        const c = text[q];
        if (c === '\\' && isPunct(text[q + 1])) { buf += text[q + 1]; q += 2; continue; }
        if (c === close) { ok = true; q++; break; }
        if (qc === '(' && c === '(') { ok = false; break; }
        buf += c; q++;
      }
      if (ok) {
        while (text[q] === ' ' || text[q] === '\t') q++;
        if (q >= text.length || text[q] === '\n') {
          title = buf;
          end = q < text.length ? q + 1 : q;
        }
      }
    }
  }
  if (end === -1) {
    let q = afterDest;
    while (text[q] === ' ' || text[q] === '\t') q++;
    if (q < text.length && text[q] !== '\n') return null;
    end = q < text.length ? q + 1 : q;
  }
  return { label, href, title, end };
}

// Extract the link reference definitions at the start of a paragraph's
// text, registering them in `links`. Returns the remaining text.
function extractDefs(text, links) {
  let rest = text;
  for (;;) {
    const def = scanDef(rest);
    if (!def) break;
    const key = normaliseLabel(def.label);
    if (!links.has(key)) links.set(key, { href: def.href, title: def.title });
    rest = rest.slice(def.end);
    if (rest.trim() === '') return '';
  }
  return rest;
}

// Would the lines gathered so far end inside an open paragraph? Used
// to decide whether a lazy continuation line joins a container. The
// last gathered line decides: a paragraph is open when that line is
// ordinary text, not the end of a fence, heading, code or HTML block.
function endsInParagraph(lines) {
  if (!lines.length) return false;
  let fence = null;
  for (const l of lines) {
    const f = FENCE_RE.exec(l);
    if (f) {
      if (!fence) {
        // A backtick fence whose info string contains a backtick is
        // not a fence at all (it is a code span in a paragraph).
        if (!(f[1][0] === '`' && f[2].includes('`'))) fence = { ch: f[1][0], len: f[1].length };
      }
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && /^[ \t]*$/.test(f[2])) fence = null;
    }
  }
  if (fence) return false;
  const last = lines[lines.length - 1];
  if (isBlank(last)) return false;
  if (ATX_RE.test(last) || HR_RE.test(last) || SETEXT_RE.test(last)) return false;
  if (indentOf(last) >= 4) return false;
  if (htmlBlockStart(last, false) !== 0) return false;
  return true;
}

function parseBlocksFromLines(lines, links, eofNewline, lazyAt, top, info) {
  const blocks = [];
  const blankCands = [];
  let defOnly = 0;
  let i = 0;

  const pushParagraph = (paraLines) => {
    const joined = paraLines.join('\n');
    const text = extractDefs(joined, links);
    if (text.trim() !== '') blocks.push({ t: 'p', text });
    else if (joined.trim() !== '') defOnly++;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      if (blocks.length || defOnly) blankCands.push(blocks.length + defOnly);
      i++;
      continue;
    }
    const indent = indentOf(line);

    // Fenced code.
    const fm = FENCE_RE.exec(line);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      const fenceChar = fm[1][0];
      const fenceLen = fm[1].length;
      const info = fm[2].trim();
      // Content lines of a backtick fence give up as many leading
      // whitespace characters (spaces or tabs, counted one by one)
      // as the fence line has: the baseline counts characters here,
      // not columns, so a tab on a content line is removed whole.
      // A tilde fence's content is not dedented at all.
      const fenceWs = fenceChar === '`' ? /^[ \t]*/.exec(line)[0].length : 0;
      const content = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) { i++; closed = true; break; }
        content.push(l.replace(new RegExp('^[ \\t]{0,' + fenceWs + '}'), ''));
        i++;
      }
      // A closed fence drops one trailing empty content line: the
      // baseline's fence match stops at the newline before the closer.
      if (closed && content.length && content[content.length - 1] === '') content.pop();
      let lang = null;
      if (info) {
        lang = info.split(/\s+/)[0].replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      }
      blocks.push({ t: 'code', lang, text: content.length ? content.join('\n') + '\n' : '' });
      continue;
    }

    // ATX heading.
    const am = ATX_RE.exec(line);
    if (am) {
      let content = (am[2] ?? '').trim();
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]#+$/, '').trimEnd();
      blocks.push({ t: 'heading', depth: am[1].length, text: content });
      i++;
      continue;
    }

    // Thematic break.
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    // Block quote.
    if (QUOTE_RE.test(line)) {
      const inner = [];
      const innerLazy = new Set();
      let innerFence = null;
      while (i < lines.length) {
        const l = lines[i];
        const qm = /^ {0,3}>/.exec(l);
        if (qm) {
          const markerCol = qm[0].length; // spaces plus the '>' itself
          const after = l[qm[0].length];
          const stripped = sliceContent(l, markerCol + (after === ' ' || after === '\t' ? 1 : 0));
          inner.push(stripped);
          const f = FENCE_RE.exec(stripped);
          if (f) {
            if (!innerFence) {
              // A backtick fence whose info contains a backtick is not
              // a fence at all (it is a code span on one line).
              if (!(f[1][0] === '`' && f[2].includes('`'))) innerFence = { ch: f[1][0], len: f[1].length };
            } else if (f[1][0] === innerFence.ch && f[1].length >= innerFence.len && /^[ \t]*$/.test(f[2])) innerFence = null;
          }
          i++;
          continue;
        }
        if (isBlank(l)) break;
        if (innerFence) break;
        // Lazy continuation of an inner paragraph. marked's lexer
        // takes such a line into the quote's paragraph, with two
        // quirks: a setext '=' underline is kept as literal text by
        // indenting it out of underline position, and a line already
        // indented four or more columns gives up four of them.
        if (inner.length && !isBlank(inner[inner.length - 1]) && endsInParagraph(inner) && !interruptsParagraph(l, false)) {
          let lazy = l;
          if (/^ {0,3}=+[ \t]*$/.test(l)) lazy = '    ' + l.trim();
          else if (indentOf(l) >= 4) lazy = stripColumns(l, 4);
          innerLazy.add(inner.length);
          inner.push(lazy);
          i++;
          continue;
        }
        break;
      }
      blocks.push({ t: 'quote', kids: parseBlocksFromLines(inner, links, false, innerLazy) });
      continue;
    }

    // List.
    if (matchListMarker(line)) {
      const parsed = parseList(lines, i, links);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // HTML block.
    const htmlType = indent <= 3 ? htmlBlockStart(line, false) : 0;
    if (htmlType) {
      const gathered = [];
      if (htmlType >= 6) {
        while (i < lines.length && !isBlank(lines[i])) { gathered.push(lines[i]); i++; }
      } else {
        const tag = /pre|script|style|textarea/i.exec(line)?.[0]?.toLowerCase();
        // Types 1-5 end at their terminator, which may sit on the
        // opening line itself.
        while (i < lines.length) {
          const l = lines[i];
          gathered.push(l);
          i++;
          if (htmlType === 1 && tag && l.toLowerCase().includes('</' + tag)) break;
          if (htmlType === 2 && l.includes('-->')) break;
          if (htmlType === 3 && l.includes('?>')) break;
          if (htmlType === 4 && l.includes('>')) break;
          if (htmlType === 5 && l.includes(']]>')) break;
        }
      }
      // The block's text carries the line ending of its last line
      // when another line follows it directly; when a truly empty
      // line (or the end of input without one) closes the block, it
      // does not. A whitespace-only line still counts as a follower
      // for the terminator-ended types.
      let text = gathered.join('\n');
      if (i >= lines.length) {
        if (eofNewline) text += '\n';
      } else if (htmlType <= 5 && lines[i] !== '') {
        text += '\n';
      }
      blocks.push({ t: 'html', text });
      continue;
    }

    // Indented code.
    if (indent >= 4) {
      const content = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          // Keep the blank only if more indented code follows; its own
          // indentation past the code indent is content.
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && indentOf(lines[j]) >= 4) {
            for (let k = i; k < j; k++) content.push(stripColumns(lines[k], 4));
            i = j;
            continue;
          }
          break;
        }
        if (indentOf(l) < 4) break;
        content.push(stripColumns(l, 4));
        i++;
      }
      blocks.push({ t: 'code', lang: null, text: content.join('\n') + '\n' });
      continue;
    }

    // Paragraph, with setext-heading and table conversions. The first
    // line keeps any leading spaces it has: marked renders them.
    const paraLines = [line];
    i++;
    let converted = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A tail of blank lines at the end of a container whose text
        // does not end in a newline is absorbed into the paragraph
        // (the baseline's paragraph match runs to the end of input).
        if (!eofNewline && lines[lines.length - 1] !== '') {
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j === lines.length) {
            while (i < lines.length) { paraLines.push(lines[i]); i++; }
          }
        }
        break;
      }
      // A line the enclosing container marked as a lazy continuation
      // belongs to this paragraph whatever it looks like.
      if (lazyAt && lazyAt.has(i)) { paraLines.push(l); i++; continue; }
      const sm = SETEXT_RE.exec(l);
      if (sm) {
        // Definitions at the start of the paragraph are consumed
        // first; only what remains can become the heading text. If
        // nothing remains, the underline starts fresh instead.
        const rest = extractDefs(paraLines.join('\n'), links);
        if (rest.trim() !== '') {
          blocks.push({ t: 'heading', depth: sm[1][0] === '=' ? 1 : 2, text: rest.trim() });
          i++;
          converted = true;
        }
        break;
      }
      // GFM table: this line is the delimiter row and the paragraph's
      // last line is the header.
      if (paraLines[paraLines.length - 1].includes('|') && isDelimiterRow(l)) {
        const headerCells = splitRow(paraLines[paraLines.length - 1]);
        const delimCells = splitRow(l);
        if (headerCells.length === delimCells.length) {
          const before = paraLines.slice(0, -1);
          if (before.length) pushParagraph(before);
          i++;
          const rows = [];
          while (i < lines.length && !/^ *$/.test(lines[i]) && !QUOTE_RE.test(lines[i])
            && !FENCE_RE.test(lines[i]) && !ATX_RE.test(lines[i]) && !HR_RE.test(lines[i])
            && !matchListMarker(lines[i])
            && htmlBlockStart(lines[i], false) === 0) {
            const cells = splitRow(lines[i]);
            while (cells.length < headerCells.length) cells.push('');
            rows.push(cells.slice(0, headerCells.length));
            i++;
          }
          blocks.push({ t: 'table', align: delimCells.map(alignOf), header: headerCells, rows });
          converted = true;
          break;
        }
      }
      if (interruptsParagraph(l, top)) break;
      paraLines.push(l);
      i++;
    }
    if (!converted) pushParagraph(paraLines);
  }
  if (info) info.blankSeparated = blankCands.some((n) => n < blocks.length + defOnly);
  return blocks;
}

// Parse a whole list starting at lines[start]. Returns the list block
// and the index of the first line after it.
function parseList(lines, start, links) {
  const first = matchListMarker(lines[start]);
  const items = [];
  let loose = false;
  let listNext = -1;
  let endPending = 0;
  let i = start;

  while (i < lines.length) {
    if (HR_RE.test(lines[i])) break;
    const m = matchListMarker(lines[i]);
    if (!m || !sameListType(m, first)) break;
    const contentCol = m.contentCol;
    const itemLines = [sliceContent(lines[i], contentCol)];
    const itemLazy = new Set();
    i++;

    // Track an unclosed fence inside the item: once it has received
    // a content line it owns every following line, because the fence
    // owns them; before that it owns nothing.
    let fence = null;
    let fenceActive = false;
    const trackFence = (sliced) => {
      const f = FENCE_RE.exec(sliced);
      if (!f) return;
      if (!fence) {
        if (!(f[1][0] === '`' && f[2].includes('`'))) fence = { ch: f[1][0], len: f[1].length };
      } else if (f[1][0] === fence.ch && f[1].length >= fence.len && /^[ \t]*$/.test(f[2])) {
        fence = null;
      }
    };
    trackFence(itemLines[0]);

    let pendingBlanks = 0;
    let itemDone = false;
    while (i < lines.length && !itemDone) {
      const l = lines[i];
      if (isBlank(l)) {
        if (fence) { itemLines.push(''); i++; continue; }
        pendingBlanks++; i++; continue;
      }
      // A thematic break ends the list even when it starts with the
      // list's own bullet character.
      if (HR_RE.test(l) && indentOf(l) < contentCol) { itemDone = true; break; }
      const nm = matchListMarker(l);
      if (nm && sameListType(nm, first) && nm.indent < contentCol) {
        if (pendingBlanks > 0) loose = true; // blank line between items
        itemDone = true;
        break;
      }
      // A fence that has started receiving content owns the lines
      // that follow it, however they are indented, until it closes.
      // A fence that has not received a content line yet owns
      // nothing: the item simply ends before an under-indented line.
      if (fence && fenceActive) {
        const pushed = indentOf(l) >= contentCol ? sliceContent(l, contentCol) : l;
        itemLines.push(pushed);
        trackFence(pushed);
        if (!fence) fenceActive = false;
        i++;
        continue;
      }
      if (indentOf(l) >= contentCol) {
        if (pendingBlanks > 0) {
          // An item that has no content yet stays empty: content that
          // only arrives after a blank line is not part of the item.
          if (!itemLines.some((x) => !isBlank(x))) { itemDone = true; break; }
          for (let k = 0; k < pendingBlanks; k++) itemLines.push('');
          pendingBlanks = 0;
        }
        const pushed = sliceContent(l, contentCol);
        itemLines.push(pushed);
        const wasOpen = fence !== null;
        trackFence(pushed);
        fenceActive = wasOpen && fence !== null;
        i++;
        continue;
      }
      // Possibly a lazy continuation of the item's last paragraph.
      // The baseline keeps such a line verbatim, except that a line
      // indented by four columns or more gives up exactly four.
      if (pendingBlanks === 0 && itemLines.length && !isBlank(itemLines[itemLines.length - 1])
          && endsInParagraph(itemLines) && !interruptsParagraph(l, false)) {
        itemLazy.add(itemLines.length);
        itemLines.push(indentOf(l) >= 4 ? stripIndentUpTo(l, 4) : l);
        i++;
        continue;
      }
      itemDone = true;
    }
    // Trailing blank lines of an item are not content.
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    endPending = pendingBlanks;
    const itemInfo = { blankSeparated: false };
    items.push(parseBlocksFromLines(itemLines, links, false, itemLazy, false, itemInfo));
    if (itemInfo.blankSeparated) loose = true;
    // If the line that stopped the gathering is not a sibling item,
    // the list is over. Blank lines the gatherer only peeked at (the
    // trailing pending blanks) are handed back to the caller, so it
    // can see them as block separators.
    if (i < lines.length) {
      if (HR_RE.test(lines[i])) { listNext = i - endPending; break; }
      const nm = matchListMarker(lines[i]);
      if (!nm || !sameListType(nm, first)) { listNext = i - endPending; break; }
    } else {
      listNext = i - endPending;
    }
  }

  return {
    block: { t: 'list', ordered: first.ordered, start: first.start, loose, items },
    next: listNext >= 0 ? listNext : i,
  };
}

// ---------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------

function renderTableCell(text, links) {
  return inlineToHtml(text, links);
}

function renderBlocks(blocks, links, tight) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        out += tight ? inlineToHtml(b.text, links) : `<p>${inlineToHtml(b.text, links)}</p>\n`;
        break;
      case 'heading':
        out += `<h${b.depth}>${inlineToHtml(b.text, links)}</h${b.depth}>\n`;
        break;
      case 'code':
        out += `<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ''}>${escapeCode(b.text)}</code></pre>\n`;
        break;
      case 'html':
        out += b.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'quote':
        out += `<blockquote>\n${renderBlocks(b.kids, links, false)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(b, links);
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        b.header.forEach((cell, ci) => {
          const a = b.align[ci];
          out += `<th${a ? ` align="${a}"` : ''}>${renderTableCell(cell, links)}</th>\n`;
        });
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            row.forEach((cell, ci) => {
              const a = b.align[ci];
              out += `<td${a ? ` align="${a}"` : ''}>${renderTableCell(cell, links)}</td>\n`;
            });
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

const TASK_RE = /^\[([ xX])\] /;

function renderList(list, links) {
  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  let out = `<${tag}${startAttr}>\n`;
  for (const item of list.items) {
    out += '<li>';
    // A task list item: the checkbox replaces the "[ ] " prefix of the
    // item's first paragraph.
    let checkbox = '';
    let firstPara = null;
    if (item.length && item[0].t === 'p') {
      const tm = TASK_RE.exec(item[0].text);
      if (tm) {
        checkbox = tm[1] === ' '
          ? '<input disabled="" type="checkbox"> '
          : '<input checked="" disabled="" type="checkbox"> ';
        firstPara = { t: 'p', text: item[0].text.slice(tm[0].length) };
      }
    }
    if (list.loose) {
      item.forEach((b, bi) => {
        if (bi === 0 && firstPara) {
          out += `<p>${checkbox}${inlineToHtml(firstPara.text, links)}</p>\n`;
        } else {
          out += renderBlocks([b], links, false);
        }
      });
    } else {
      item.forEach((b, bi) => {
        if (bi === 0 && firstPara) {
          out += checkbox + inlineToHtml(firstPara.text, links);
        } else {
          out += renderBlocks([b], links, true);
        }
      });
    }
    out += '</li>\n';
  }
  out += `</${tag}>\n`;
  return out;
}

// ---------------------------------------------------------------------
// The entry point the harness's driver calls.
// ---------------------------------------------------------------------

export function parse(src) {
  if (!src) return '';
  aTagOpen = false;
  const normalised = src.replace(/\r\n|\r/g, '\n');
  const eofNewline = normalised.endsWith('\n');
  const lines = normalised.split('\n');
  if (eofNewline) lines.pop();
  const links = new Map();
  const blocks = parseBlocksFromLines(lines, links, eofNewline, undefined, true);
  return renderBlocks(blocks, links, false);
}
