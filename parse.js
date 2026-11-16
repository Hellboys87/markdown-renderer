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
const PRE_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const A_OPEN_RE = /^<a /i;
const A_CLOSE_RE = /^<\/a>/i;

// GFM extended autolinks (bare URLs and e-mail addresses in text).
const URL_HEAD_RE = /^(?:(?:https?|ftp):\/\/|www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/i;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const MAILTO_URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;

/** GFM trailing-punctuation / unbalanced-paren / trailing-entity trimming for bare URLs. */
function backpedalUrl(s) {
  // The reference trims an autolink's tail: trailing punctuation is dropped one
  // character at a time, an unbalanced ')' is dropped, and a ';' that ends a named
  // entity reference is kept. Repeat until the tail is stable.
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (last === ';') {
      // A trailing entity-shaped run is not part of the link at all.
      const ent = /&[A-Za-z0-9]+;$/.exec(s);
      if (ent) {
        s = s.slice(0, s.length - ent[0].length);
        continue;
      }
    }
    if ('?!.,:;*_\'"~'.includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let opens = 0;
      let closes = 0;
      for (const c of s) {
        if (c === '(') opens++;
        else if (c === ')') closes++;
      }
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    return s;
  }
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
 * Try to form a link or image at a ']' (position `closeIdx` in src), where `opener` is the
 * bracket node on top of the stack and `nodes` is the node list built so far (the opener is the
 * last "open" node in it). Returns { end, node } on success, null on failure.
 */
function tryFormLink(src, closeIdx, opener, nodes, refs) {
  const labelRaw = src.slice(opener.start, closeIdx);
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
  // Bare autolinks never survive inside a link or image label in the reference.
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].k === 'auto') kids[i] = { k: 'text', s: kids[i].s, raw: true };
  }
  processEmphasis(kids);
  return { end, node: { k: 'link', href, title, img: opener.img, kids } };
}

/** The delimiter-stack emphasis pass (CommonMark's algorithm), over a node list in place. */
function processEmphasis(nodes, bottomIdx = -1) {
  // Index of delimiter nodes in order.
  let closerIdx = findDelim(nodes, bottomIdx);
  while (closerIdx !== -1) {
    const closer = nodes[closerIdx];
    if (closer.ch === '~' || !closer.close || closer.n === 0) {
      closerIdx = findDelim(nodes, closerIdx);
      continue;
    }
    // Find the nearest earlier opener of the same character.
    let openerIdx = closerIdx - 1;
    let opener = null;
    while (openerIdx > bottomIdx) {
      const cand = nodes[openerIdx];
      if (cand.k === 'delim' && cand.ch === closer.ch && cand.open && cand.n > 0) {
        // Rule of three.
        if (
          (cand.close || closer.open) &&
          (cand.n + closer.n) % 3 === 0 &&
          cand.n % 3 !== 0 &&
          closer.n % 3 !== 0
        ) {
          openerIdx--;
          continue;
        }
        opener = cand;
        break;
      }
      openerIdx--;
    }
    if (!opener) {
      closerIdx = findDelim(nodes, closerIdx);
      continue;
    }
    const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    opener.n -= use;
    closer.n -= use;
    const inner = nodes.splice(openerIdx + 1, closerIdx - openerIdx - 1);
    const wrap = { k: use === 2 ? 'strong' : 'em', ch: closer.ch, kids: inner };
    nodes.splice(openerIdx + 1, 0, wrap);
    // Adjust indices: nodes after the wrap shifted; recompute closer position.
    closerIdx = openerIdx + 2; // position after wrap node (closer may still have n > 0)
    if (closer.n === 0) closerIdx = findDelim(nodes, closerIdx - 1);
    // If the opener is exhausted it stays as an inert delim with n=0; loop continues
    // with the same closer (now at closerIdx) if it still has length.
    if (nodes[closerIdx] !== closer) closerIdx = findDelim(nodes, closerIdx - 1);
  }
}

function findDelim(nodes, afterIdx) {
  for (let i = afterIdx + 1; i < nodes.length; i++) {
    if (nodes[i].k === 'delim') return i;
  }
  return -1;
}

/**
 * Strikethrough pairing, reference-style: an opening run of one or two '~' pairs with the
 * next run of exactly the same length that can close; the content between is a finished
 * inline fragment. Runs before emphasis processing.
 */
function processDel(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const open = nodes[i];
    if (open.k !== 'delim' || open.ch !== '~' || !open.open || open.n === 0 || open.n > 2) {
      i++;
      continue;
    }
    let j = i + 1;
    let done = false;
    while (j < nodes.length) {
      const close = nodes[j];
      if (close.k === 'delim' && close.ch === '~' && close.close && close.n === open.n) {
        const inner = nodes.splice(i + 1, j - i - 1);
        processDel(inner);
        processEmphasis(inner);
        nodes.splice(i, 2, { k: 'del', kids: inner });
        done = true;
        break;
      }
      j++;
    }
    i = done ? i + 1 : i + 1;
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
 * Tokenise + process an inline fragment. `refs` is the document's link-reference map.
 * When `inLinkText` is set (inside an <a> tag's span or a link label being re-parsed) bare
 * autolinks are suppressed the way the reference suppresses them.
 */
function renderInline(src, refs) {
  const nodes = [];
  const stack = []; // indices into `nodes` of bracket openers still unmatched
  let inRawBlock = false;
  let inLinkTag = false;
  let textBuf = '';
  const flushText = () => {
    if (textBuf.length > 0) {
      nodes.push({ k: 'text', s: inRawBlock ? textBuf : decodeNumericRefs(textBuf), raw: inRawBlock });
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
        nodes.push({ k: 'text', s: next, raw: false });
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
      // Find a closing run of exactly the same length.
      let j = i + run;
      let closeStart = -1;
      while (j < n) {
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
      const rest = src.slice(i);
      const auto = AUTOLINK_RE.exec(rest);
      if (auto) {
        flushText();
        const text = auto[1];
        const href = text.includes('@') && !text.includes(':') ? `mailto:${text}` : text;
        // Scheme autolinks keep their text; e-mail autolinks get mailto:.
        const isEmail = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/.test(text);
        nodes.push({ k: 'auto', s: text, href: isEmail ? `mailto:${text}` : text });
        i += auto[0].length;
        continue;
      }
      const tag = TAG_RE.exec(rest);
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
      const opener = { k: 'open', img: true, start: i + 2, nodeIndex: nodes.length };
      nodes.push(opener);
      stack.push(opener);
      i += 2;
      continue;
    }

    if (ch === '[') {
      flushText();
      const opener = { k: 'open', img: false, start: i + 1, nodeIndex: nodes.length };
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
      if (opener.dead) {
        // An inactive opener: this ']' is literal, and the opener leaves the stack.
        stack.pop();
        opener.k = 'text';
        opener.s = opener.img ? '![' : '[';
        delete opener.img;
        textBuf += ']';
        i++;
        continue;
      }
      flushText();
      const formed = tryFormLink(src, i, opener, nodes, refs);
      if (formed) {
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
      nodes.push({ k: 'delim', ch, n: run, open, close });
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
    if (!inLinkTag && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W' || ch === 'm' || ch === 'x')) {
      const rest = src.slice(i);
      const mail = MAILTO_URL_RE.exec(rest);
      if (mail && (mail[0].startsWith('mailto:') || mail[0].startsWith('xmpp:'))) {
        flushText();
        nodes.push({ k: 'auto', s: mail[0], href: mail[0] });
        i += mail[0].length;
        continue;
      }
      const url = URL_HEAD_RE.exec(rest);
      if (url) {
        const isWww = /^www\./i.test(url[0]);
        const prev = i > 0 ? src[i - 1] : undefined;
        if (!isWww || prev === undefined || /[\s*_~(]/.test(prev)) {
          flushText();
          const text = backpedalUrl(url[0]);
          if (text.length > 0) {
            nodes.push({ k: 'auto', s: text, href: isWww ? `http://${text}` : text });
            i += text.length;
            continue;
          }
        }
      }
    }
    if (!inLinkTag && /[A-Za-z0-9]/.test(ch)) {
      const prev = i > 0 ? src[i - 1] : undefined;
      if (prev === undefined || !/[A-Za-z0-9._%+-]/.test(prev)) {
        const em = EMAIL_RE.exec(src.slice(i));
        if (em) {
          flushText();
          nodes.push({ k: 'auto', s: em[0], href: `mailto:${em[0]}` });
          i += em[0].length;
          continue;
        }
      }
    }

    textBuf += ch;
    i++;
  }
  flushText();

  processDel(nodes);
  processEmphasis(nodes);
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
function htmlType7(line) {
  const rest = line.slice(lead3(line));
  const open = new RegExp(String.raw`^<[A-Za-z][A-Za-z0-9-]*(?:${TAG_ATTR})*\s*/?>[ \t]*$`).exec(rest);
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
  while (j < lines.length && !isBlank(lines[j]) && !tableBodyInterrupt(lines[j])) {
    rows.push(splitRow(lines[j], header.length));
    j++;
  }
  return { node: { t: 'table', header, align, rows }, next: j };
}

function tableBodyInterrupt(line) {
  if (isHR(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (isIndented(line)) return true;
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

function stripQuoteLine(line) {
  const m = QUOTE_RE.exec(line);
  let rest = line.slice(m[0].length);
  const ws = /^[ \t]+/.exec(rest);
  if (ws) {
    const expanded = expandTabs(ws[0], m[0].length);
    rest = expanded + rest.slice(ws[0].length);
    if (rest.startsWith(' ')) rest = rest.slice(1);
  }
  return rest;
}

/** Whether lines[j] would interrupt a paragraph (the reference's continuation lookaheads). */
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

/** Whether an unmarked line may lazily continue a blockquote's open paragraph. */
function lazyInterrupt(lines, j) {
  const ln = lines[j];
  if (isHR(ln)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(ln)) return true;
  if (QUOTE_RE.test(ln)) return true;
  if (matchFenceStart(ln)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(ln)) return true;
  if (htmlBlockStart(ln)) return true;
  return false;
}

/** A line with every leading blockquote marker stripped (for classification only). */
function effLine(line) {
  let s = line;
  for (;;) {
    if (QUOTE_RE.test(s)) {
      s = stripQuoteLine(s);
      continue;
    }
    // A list marker's content is what decides the innermost open construct.
    const bm = matchBullet(s);
    if (bm) {
      const rest = s.slice(bm.prefix.length);
      if (rest === '' || rest[0] === ' ' || rest[0] === '\t') {
        s = rest.replace(/^[ \t]+/, '');
        continue;
      }
    }
    return s;
  }
}

/** Whether the inner lines collected so far end inside an open paragraph. */
function innerEndsWithParagraph(inner) {
  const lines = inner.map(effLine);
  let start = lines.length - 1;
  while (start > 0 && !isBlank(lines[start - 1])) start--;
  let para = false;
  let inFence = false;
  let fenceCh = '';
  let fenceLen = 0;
  for (let idx = start; idx < lines.length; idx++) {
    const ln = lines[idx];
    if (inFence) {
      if (isFenceClose(ln, fenceCh, fenceLen)) inFence = false;
      para = false;
      continue;
    }
    if (para) {
      if (setextDepth(ln)) {
        para = false;
        continue;
      }
      if (interruptsParagraph(lines, idx)) {
        para = false;
        // fall through: ln starts a new block
      } else {
        continue;
      }
    }
    const f = matchFenceStart(ln);
    if (f) {
      inFence = true;
      fenceCh = f.ch;
      fenceLen = f.len;
      para = false;
    } else if (
      matchATX(ln) ||
      isHR(ln) ||
      QUOTE_RE.test(ln) ||
      matchBullet(ln) ||
      htmlBlockStart(ln) ||
      isIndented(ln) ||
      tableAhead(lines, idx)
    ) {
      para = false;
    } else {
      para = true;
    }
  }
  return para && !inFence;
}

function collectQuote(lines, i, refs) {
  const inner = [];
  const forced = new Set();
  let j = i;
  let prevBlank = true;
  let prevLazy = false;
  while (j < lines.length) {
    const ln = lines[j];
    if (QUOTE_RE.test(ln)) {
      const stripped = stripQuoteLine(ln);
      inner.push(stripped);
      prevBlank = isBlank(stripped);
      prevLazy = false;
      j++;
      continue;
    }
    if (isBlank(ln)) break;
    if (!prevBlank && innerEndsWithParagraph(inner) && !lazyInterrupt(lines, j)) {
      // A lazy setext underline that does not start a segment is rewritten by the
      // reference with a four-space indent, which keeps it as paragraph text.
      if (prevLazy && /^ {0,3}(?:=+|-+)[ \t]*$/.test(ln)) {
        inner.push(`    ${ln.slice(lead3(ln))}`);
      } else if (isIndented(ln)) {
        // A lazy indented line joins the paragraph as merged code text: its indent
        // is removed and it may not start a block of its own.
        inner.push(stripCodeIndent(ln));
        forced.add(inner.length - 1);
      } else {
        inner.push(ln);
      }
      prevBlank = false;
      prevLazy = true;
      j++;
      continue;
    }
    break;
  }
  return { node: { t: 'quote', kids: parseBlocks(inner, refs, true, forced) }, next: j };
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
function beginsBlock(line, n, bulletAny) {
  if (bulletAny && new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)`).test(line)) return true;
  if (new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})[ \\t]*$`).test(line)) return true;
  if (new RegExp(`^ {0,${n}}(?:\`{3,}|~{3,})`).test(line)) return true;
  if (new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`).test(line)) return true;
  if (bulletAny && new RegExp(`^ {0,${n}}>`).test(line)) return true;
  if (htmlBeginAt(line, n)) return true;
  return false;
}

function htmlBeginAt(line, n) {
  const sub = line.slice(Math.min(n, lead3(line)));
  const rest = line.slice(lead3(line));
  void sub;
  if (rest[0] !== '<') return false;
  if (HTML_TYPE1_RE.test(line)) return true;
  if (rest.startsWith('<!--') || rest.startsWith('<?') || /^<![A-Za-z]/.test(rest) || rest.startsWith('<![CDATA[')) return true;
  if (HTML_TYPE6_RE.test(line)) return true;
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
  const parsed = items.map((got) => {
    const blocks = parseBlocks(got.text.split('\n'), refs, false);
    return { text: got.text, blocks };
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
    node: { t: 'list', ordered: first.ordered, start: first.start, loose, items: parsed },
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
      // paragraph content in the reference, not a blank separator.
      if (j === lines.length - 1 && ln.length > 0) {
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
    if (interruptsParagraph(lines, j)) break;
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

function renderBlocks(blocks, refs, looseList = false) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, looseList);
  return out;
}

function renderBlock(b, refs, looseList = false) {
  switch (b.t) {
    case 'para':
      return `<p>${renderInline(b.text, refs)}</p>\n`;
    case 'text':
      return looseList
        ? `<p>${renderInline(b.text, refs)}</p>\n`
        : renderInline(b.text, refs);
    case 'heading':
      return `<h${b.depth}>${renderInline(b.text, refs)}</h${b.depth}>\n`;
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
      return `<blockquote>\n${renderBlocks(b.kids, refs)}</blockquote>\n`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      let out = `<${tag}${startAttr}>\n`;
      for (const item of b.items) {
        let inner = renderBlocks(item.blocks, refs, b.loose);
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
        head += `${a ? `<th align="${a}">` : '<th>'}${renderInline(b.header[c], refs)}</th>\n`;
      }
      let out = `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n`;
      if (b.rows.length > 0) {
        let body = '';
        for (const row of b.rows) {
          let cells = '';
          for (let c = 0; c < row.length; c++) {
            const a = b.align[c];
            cells += `${a ? `<td align="${a}">` : '<td>'}${renderInline(row[c], refs)}</td>\n`;
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
  return renderBlocks(blocks, refs);
}
