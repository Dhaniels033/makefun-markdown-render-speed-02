// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer that
// returns exactly the HTML marked 18.1.3 renders with its default options
// (GFM on, breaks off, pedantic off, async off).
//
// Written from the CommonMark/GFM specifications and differential testing
// against marked's output. No part of marked's source is copied here.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

// ASCII punctuation (CommonMark's set).
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.indexOf(ch) !== -1;
}
function isPunct(ch) {
  if (!ch) return false;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return isAsciiPunct(ch);
  return /\p{P}/u.test(ch);
}
function isWhitespace(ch) {
  if (!ch) return false;
  return /\s/u.test(ch);
}
function isWordChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
// Full character (1 or 2 UTF-16 code units) at index i of s.
function charAt(s, i) {
  if (i < 0 || i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xDC00 && d <= 0xDFFF) return s.slice(i, i + 2);
  }
  return s[i];
}
function charBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i - 2 >= 0) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xD800 && d <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

// Expand tabs in string a to spaces, starting at column startCol.
// (A tab advances to the next multiple of 4 columns.)
function expandTabs(a, startCol) {
  if (a.indexOf('\t') === -1) return a;
  let col = startCol || 0;
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Column width of the leading whitespace of a line (space=1, tab to next
// multiple of 4), and how many raw characters that whitespace spans.
function leadingWs(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, chars: i };
}
// Remove the first n columns of indentation from a line. A tab that
// straddles the boundary leaves spaces for its remainder; later tabs in
// the leading whitespace keep expanding from their (new) column, so the
// whole leading run is expanded to spaces first.
function stripCols(line, n) {
  let col = 0, i = 0, out = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; out += ' '; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (out.length >= n) return out.slice(n) + line.slice(i);
  return line.slice(i);
}
// Does the line start an indented code block (4+ columns of indent, or
// 0-3 spaces followed by a tab)?
function isCodeIndent(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; if (col >= 4) return true; }
    else if (ch === '\t') return true;
    else return false;
  }
  return false;
}
// Remove one indented-code indent from a line: up to 3 spaces + a tab,
// or 1-4 spaces (marked's codeRemoveIndent).
function removeCodeIndent(line) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(line);
  return m ? line.slice(m[0].length) : line;
}
function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// ---- escaping -----------------------------------------------------------
// Escape text, leaving valid entity references (&name;, &#123;, &#x1f;)
// untouched; a bare & becomes &amp;. Also escapes < > " '.
const NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);)/g;
function escapeText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(NO_ENCODE_RE, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}
// Escape code content: every & is encoded.
const ENCODE_RE = /[&<>"']/g;
function escapeCode(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ENCODE_RE, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}
// Decode a numeric character reference body ("#65" / "#x41") to a character,
// or U+FFFD when invalid. Returns null when the body is not a valid
// numeric reference form (1-7 decimal digits or 1-6 hex digits).
function decodeNumeric(body) {
  let cp;
  if (body[1] === 'x' || body[1] === 'X') {
    if (body.length < 3 || body.length > 8) return null;
    cp = parseInt(body.slice(2), 16);
    if (Number.isNaN(cp)) return null;
  } else {
    if (body.length < 2 || body.length > 8) return null;
    cp = parseInt(body.slice(1), 10);
    if (Number.isNaN(cp)) return null;
  }
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Encode a link destination the way marked does (encodeURI, then undo
// the %25 encoding so already-escaped sequences stay escaped, with a
// fallback to the raw string when it throws on lone surrogates).
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return href;
  }
}

// ---- inline parsing -----------------------------------------------------
// Node types: 0 text, 1 delimiter, 2 code span, 3 raw html, 4 link open,
// 5 link close, 6 hard break, 7 image, 8 emphasis open, 9 emphasis close,
// 10 decoded numeric reference (a single character, escaped strictly).

function normalizeLabel(s) {
  // Link labels are matched after trimming, collapsing whitespace and
  // case folding only (marked's F); backslash escapes stay in the label.
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function skipLinkWs(s, p) {
  let newlines = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === ' ' || c === '\t') { p++; continue; }
    if (c === '\n') {
      newlines++;
      if (newlines > 1) return -1;
      p++; continue;
    }
    break;
  }
  return p;
}

// Parse an inline link destination + optional title starting at s[pos]=='('.
// Returns {dest, title, end} or null.
function parseInlineLink(s, pos) {
  let p = skipLinkWs(s, pos + 1);
  if (p < 0) return null;
  let dest = '';
  if (s[p] === ')') return { dest: '', title: null, end: p + 1 };
  if (s[p] === '<') {
    let q = p + 1, out = '';
    while (q < s.length) {
      const c = s[q];
      if (c === '\n') return null;
      if (c === '>') break;
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { out += s[q + 1]; q += 2; continue; }
      out += c; q++;
    }
    if (q >= s.length || s[q] !== '>') return null;
    dest = out; p = q + 1;
  } else {
    let q = p, depth = 0, out = '';
    while (q < s.length) {
      const c = s[q];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32 || c === '<') break;
      if (c === '\\' && q + 1 < s.length) {
        const nx = s[q + 1];
        if (nx === ' ' || nx === '\t' || nx === '\n') break;
        if (isAsciiPunct(nx)) { out += nx; q += 2; continue; }
        out += '\\'; q++; continue;
      }
      if (c === '(') { depth++; out += c; q++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; out += c; q++; continue;
      }
      out += c; q++;
    }
    if (depth !== 0 || q === p) return null;
    dest = out; p = q;
  }
  const afterDest = p;
  p = skipLinkWs(s, p);
  if (p < 0) return null;
  let title = null;
  if (s[p] === ')') return { dest, title, end: p + 1 };
  // A title needs whitespace (or a line break) before it.
  if (p === afterDest) return null;
  const q0 = s[p];
  if (q0 !== '"' && q0 !== "'" && q0 !== '(') return null;
  const close = q0 === '(' ? ')' : q0;
  let q = p + 1, out = '', closed = false;
  while (q < s.length) {
    const c = s[q];
    if (c === close) { closed = true; break; }
    if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { out += s[q + 1]; q += 2; continue; }
    if (q0 === '(' && c === '(') return null;
    if (q0 === "'" && c === '\n' && s[q + 1] === '\n') return null;
    out += c; q++;
  }
  if (!closed) return null;
  title = out; p = q + 1;
  p = skipLinkWs(s, p);
  if (p < 0 || s[p] !== ')') return null;
  return { dest, title, end: p + 1 };
}

// Parse a [label] starting at s[pos]=='['. Returns {label, end} or null.
function parseLabel(s, pos) {
  let p = pos + 1, depth = 1, out = '';
  while (p < s.length) {
    const c = s[p];
    if (c === '\n') {
      if (s[p + 1] === '\n') return null;
      out += c; p++; continue;
    }
    if (c === '\\' && p + 1 < s.length && isAsciiPunct(s[p + 1])) { out += c + s[p + 1]; p += 2; continue; }
    if (c === '[') { depth++; out += c; p++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return { label: out, end: p + 1 };
      out += c; p++; continue;
    }
    out += c; p++;
  }
  return null;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Match a domain (labels separated by dots) at s[start]. Returns the end
// index, or null. needDot requires at least one dot in the domain.
function matchDomain(s, start, needDot) {
  let j = start, hasDot = false;
  while (true) {
    if (j >= s.length || !isAlnum(s[j])) return null;
    j++;
    while (j < s.length && (isAlnum(s[j]) || s[j] === '-')) j++;
    if (s[j - 1] === '-') return null;
    if (s[j] === '.') {
      if (j + 1 < s.length && isAlnum(s[j + 1])) { hasDot = true; j++; continue; }
      break;
    }
    break;
  }
  if (needDot && !hasDot) return null;
  return j;
}
// Trim trailing punctuation off an autolink [start, end), keeping balanced
// parens and trimming a trailing entity-like &...; sequence (marked's
// _backpedal).
function trimAutolink(s, start, end) {
  let open = 0, close = 0;
  for (let k = start; k < end; k++) {
    if (s[k] === '(') open++;
    else if (s[k] === ')') close++;
  }
  let e = end;
  while (e > start) {
    const c = s[e - 1];
    if (c === ')') {
      if (close > open) { close--; e--; continue; }
      break;
    }
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' ||
        c === ';' || c === '*' || c === '_' || c === '~' || c === "'" || c === '"') {
      if (c === ';') {
        let k = e - 2;
        while (k >= start && /[A-Za-z0-9#]/.test(s[k])) k--;
        // A trailing entity-like &...; is trimmed from the URL.
        if (k >= start && s[k] === '&') { e = k; continue; }
      }
      e--; continue;
    }
    break;
  }
  return e;
}
// Match an extended (GFM) autolink at s[i]: www., http(s)://, ftp://,
// mailto:/xmpp: schemes, or an email. Follows marked's url regex:
// the email local part is [A-Za-z0-9._+-]+, the domain needs a dot, and
// the character after an email must not be a word character or '-'.
function matchExtAutolink(s, i) {
  const rest = s.slice(i);
  // mailto: / xmpp: scheme autolinks.
  const scheme = /^(mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/.exec(rest);
  if (scheme) {
    const text = scheme[0];
    return { href: text, text, end: i + text.length };
  }
  // www. / http(s):// / ftp:// — the URL runs to the next whitespace
  // or '<', then trailing punctuation is trimmed.
  const web = /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(rest);
  if (web) {
    let end = trimAutolink(s, i, i + web[0].length);
    if (end <= i + 4) return null;
    const text = s.slice(i, end);
    const href = text.startsWith('www.') ? 'http://' + text : text;
    return { href, text, end };
  }
  // Email.
  const em = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(rest);
  if (em) {
    const text = em[0];
    return { href: 'mailto:' + text, text, end: i + text.length };
  }
  return null;
}

// Match a <...> autolink (scheme or email) at s[i]. Returns
// {text, mailto, end} or null.
function matchAutolink(s, i) {
  let j = i + 1;
  if (j < s.length && /[A-Za-z]/.test(s[j])) {
    let k = j + 1;
    while (k < s.length && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - j >= 2 && k - j <= 32 && s[k] === ':') {
      let m = k + 1;
      while (m < s.length && s[m] !== '>' && s[m] !== '<' && !isWhitespace(s[m])) m++;
      if (s[m] === '>') return { text: s.slice(i + 1, m), mailto: false, end: m + 1 };
    }
  }
  const end = s.indexOf('>', i + 1);
  if (end !== -1) {
    const inner = s.slice(i + 1, end);
    if (EMAIL_RE.test(inner)) return { text: inner, mailto: true, end: end + 1 };
  }
  return null;
}

// Match an inline HTML tag starting at s[i] ('<'). Returns the tag text
// or null.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return '<!-->';
    if (s.startsWith('<!--->', i)) return '<!--->';
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return s.slice(i); // unterminated comment runs to EOF
    return s.slice(i, end + 3);
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end === -1) {
      const nl = s.indexOf('\n', i + 9);
      return nl === -1 ? s.slice(i) : s.slice(i, nl);
    }
    return s.slice(i, end + 3);
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    const nl = s.indexOf('\n', i + 2);
    if (end !== -1 && (nl === -1 || end < nl)) return s.slice(i, end + 2);
    if (nl !== -1) return s.slice(i, nl);
    return s.slice(i);
  }
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    const end = s.indexOf('>', i + 2);
    const nl = s.indexOf('\n', i + 2);
    if (end !== -1 && (nl === -1 || end < nl)) return s.slice(i, end + 1);
    if (nl !== -1) return s.slice(i, nl);
    return s.slice(i);
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  while (true) {
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k >= n) return null;
    if (s[k] === '>') return s.slice(i, k + 1);
    if (!closing && s[k] === '/' && s[k + 1] === '>') return s.slice(i, k + 2);
    // A closing tag takes no attributes.
    if (closing) return null;
    if (k === j) return null;
    if (!/[A-Za-z_:]/.test(s[k])) return null;
    while (k < n && /[A-Za-z0-9_.:-]/.test(s[k])) k++;
    let m = k;
    while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (s[m] === '=') {
      m++;
      while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      if (s[m] === '"') {
        const q = s.indexOf('"', m + 1);
        if (q === -1) return null;
        m = q + 1;
      } else if (s[m] === "'") {
        const q = s.indexOf("'", m + 1);
        if (q === -1) return null;
        m = q + 1;
      } else {
        if (m >= n || /[\s"'=<>`]/.test(s[m])) return null;
        while (m < n && !/[\s"'=<>`]/.test(s[m])) m++;
      }
      j = m;
    } else {
      // A bare attribute: leave the whitespace after its name in place,
      // so the next attribute still has its leading whitespace.
      j = k;
    }
  }
}

// Process emphasis for the given delimiter nodes (in document order).
// Wraps the nodes between matched opener/closer pairs with <em>/<strong>
// /<del> markers (node types 8/9).
function processEmphasis(ds, insertAfter, insertBefore, removeNode) {
  for (let ci = 0; ci < ds.length; ci++) {
    const closer = ds[ci];
    if (!closer || closer.done || closer.num === 0 || !closer.canClose) continue;
    while (closer.num > 0 && closer.canClose && !closer.done) {
      let opener = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const cand = ds[oi];
        if (!cand || cand.done || cand.num === 0 || cand.ch !== closer.ch || !cand.canOpen) continue;
        if ((cand.canClose || closer.canOpen) && ((cand.num + closer.num) % 2 === 1)) continue;
        if (cand.next === closer) continue; // nothing between them
        opener = cand; break;
      }
      if (!opener) break;
      const use = (opener.num >= 2 && closer.num >= 2) ? 2 : 1;
      const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      insertAfter({ t: 8, s: '<' + tag + '>' }, opener);
      insertBefore({ t: 9, s: '</' + tag + '>' }, closer);
      opener.num -= use;
      closer.num -= use;
      if (opener.num === 0) removeNode(opener);
      if (closer.num === 0) { removeNode(closer); break; }
    }
  }
}

// Render inline markdown to HTML.
function inlineHtml(s, refs) {
  let head = null, tail = null;
  const delims = [];
  const brackets = [];
  function appendNode(nd) {
    nd.next = null; nd.prev = tail;
    if (tail) tail.next = nd; else head = nd;
    tail = nd;
    return nd;
  }
  function insertAfter(nd, ref) {
    nd.prev = ref; nd.next = ref.next;
    if (ref.next) ref.next.prev = nd; else tail = nd;
    ref.next = nd;
  }
  function insertBefore(nd, ref) {
    nd.next = ref; nd.prev = ref.prev;
    if (ref.prev) ref.prev.next = nd; else head = nd;
    ref.prev = nd;
  }
  function removeNode(nd) {
    if (nd.prev) nd.prev.next = nd.next; else head = nd.next;
    if (nd.next) nd.next.prev = nd.prev; else tail = nd.prev;
    nd.next = nd.prev = null;
  }
  function addText(str) {
    if (!str) return;
    if (tail && tail.t === 0 && !tail.brk) { tail.s += str; return; }
    appendNode({ t: 0, s: str });
  }
  function addDecoded(ch) {
    if (tail && tail.t === 10) { tail.s += ch; return; }
    appendNode({ t: 10, s: ch });
  }

  // Attempt to form a link/image at the ']' at index closeIdx.
  // Returns the index to continue scanning from, or -1 on failure.
  // A ']' always closes the innermost open bracket (the stack top); an
  // inactive bracket makes it literal. A link that forms deactivates
  // enclosing link brackets (a link's text may not contain a link), but
  // an enclosing image bracket shields the brackets outside it (an
  // image's alt text may contain a link), and an image that forms
  // deactivates nothing.
  function tryLink(closeIdx) {
    if (brackets.length === 0) return -1;
    const br = brackets[brackets.length - 1];
    brackets.pop();
    if (!br.active) return -1;
    let pos = closeIdx + 1;
    let dest = null, title = null;
    if (s[pos] === '(') {
      const r = parseInlineLink(s, pos);
      if (r) {
        dest = r.dest; title = r.title; pos = r.end;
      } else {
        // A failed inline link falls back to a shortcut reference link.
        const label = s.slice(br.textStart, closeIdx);
        const ref = refs.get(normalizeLabel(label));
        if (!ref) return -1;
        dest = ref.href; title = ref.title; pos = closeIdx + 1;
      }
    } else if (s[pos] === '[') {
      const r = parseLabel(s, pos);
      if (!r) return -1;
      const label = r.label === '' ? s.slice(br.textStart, closeIdx) : r.label;
      const ref = refs.get(normalizeLabel(label));
      if (!ref) return -1;
      dest = ref.href; title = ref.title; pos = r.end;
    } else {
      const label = s.slice(br.textStart, closeIdx);
      const ref = refs.get(normalizeLabel(label));
      if (!ref) return -1;
      dest = ref.href; title = ref.title;
    }
    // Emphasis inside the link text is resolved on its own: collect the
    // segment's delimiters, process them, and keep them out of the outer
    // emphasis pass (marked never matches emphasis across a link boundary).
    const segDelims = [];
    let nd = br.node.next;
    while (nd) { if (nd.t === 1) segDelims.push(nd); nd = nd.next; }
    processEmphasis(segDelims, insertAfter, insertBefore, removeNode);
    for (const d of segDelims) d.done = true;
    if (br.image) {
      // Plain-text alt: the segment's text with all markup stripped
      // (a nested link contributes its text, a nested image its alt).
      let alt = '';
      nd = br.node.next;
      while (nd) {
        if (nd.t === 0) alt += escapeText(nd.s);
        else if (nd.t === 10) alt += escapeCode(nd.s);
        else if (nd.t === 1) alt += nd.ch.repeat(nd.num);
        else if (nd.t === 2) alt += escapeCode(nd.s);
        else if (nd.t === 3) alt += escapeText(nd.s);
        else if (nd.t === 6) alt += '\n';
        else if (nd.t === 7) alt += nd.alt;
        nd = nd.next;
      }
      if (br.excl) removeNode(br.excl);
      let cur = br.node.next;
      while (cur) { const nx = cur.next; removeNode(cur); cur = nx; }
      removeNode(br.node);
      appendNode({ t: 7, href: cleanHref(dest), title, alt });
    } else {
      const open = { t: 4, href: cleanHref(dest), title };
      open.prev = br.node.prev; open.next = br.node.next;
      if (br.node.prev) br.node.prev.next = open; else head = open;
      if (br.node.next) br.node.next.prev = open; else tail = open;
      appendNode({ t: 5 });
    }
    // A link deactivates enclosing link brackets, stopping at the
    // first enclosing image bracket (it shields the outside); an image
    // deactivates nothing.
    if (!br.image) {
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].image) break;
        brackets[k].active = false;
      }
    }
    return pos;
  }

  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    // Possible extended autolink start. Marked only tries the url
    // token when not inside a link (state.inLink), so an email or
    // www./http(s):// run inside a link bracket stays literal.
    if (isWordChar(ch) && (i === 0 || (!isWordChar(s[i - 1]) && s[i - 1] !== '/' && s[i - 1] !== '.')) &&
        !brackets.some(b => !b.image && b.active)) {
      const ext = matchExtAutolink(s, i);
      if (ext) {
        appendNode({ t: 4, href: cleanHref(ext.href), title: null });
        addText(ext.text);
        appendNode({ t: 5 });
        i = ext.end;
        continue;
      }
    }
    if (ch === '\\') {
      if (i + 1 < n) {
        const nx = s[i + 1];
        if (nx === '\n') {
          // A backslash hard break consumes the leading whitespace of
          // the next line (marked's br token raw includes it).
          appendNode({ t: 6 });
          i += 2;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
          continue;
        }
        if (isAsciiPunct(nx)) {
          // An escaped & must not start an entity when rendered.
          if (nx === '&') addDecoded('&'); else addText(nx);
          i += 2; continue;
        }
      }
      addText('\\'); i++; continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const runLen = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k;
          while (m < n && s[m] === '`') m++;
          if (m - k === runLen) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        let content = s.slice(j, found).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        appendNode({ t: 2, s: content });
        i = found + runLen;
        continue;
      }
      addText('`'.repeat(runLen)); i = j; continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && s[j] === ch) j++;
      const runLen = j - i;
      // A run of 3+ tildes is never strikethrough (marked's del
      // delimiter is 1 or 2 tildes, never adjacent to another tilde).
      if (ch === '~' && runLen >= 3) { addText('~'.repeat(runLen)); i = j; continue; }
      const before = charBefore(s, i);
      const after = charAt(s, j);
      // At the ends of the inline text marked behaves as if a newline
      // followed/preceded the run (its paragraph text keeps the line end),
      // so a run at either end counts as flanked by whitespace there.
      const beforeWs = before === '' || isWhitespace(before);
      const afterWs = after === '' || isWhitespace(after);
      const beforePunct = before !== '' && isPunct(before);
      const afterPunct = after !== '' && isPunct(after);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunct(before));
        canClose = rightFlank && (!leftFlank || isPunct(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      const nd = appendNode({ t: 1, ch, num: runLen, canOpen, canClose });
      delims.push(nd);
      i = j; continue;
    }
    if (ch === '[') {
      const nd = appendNode({ t: 0, s: '[', brk: true });
      brackets.push({ node: nd, image: false, active: true, textStart: i + 1, excl: null });
      i++; continue;
    }
    if (ch === '!') {
      if (s[i + 1] === '[') {
        const excl = appendNode({ t: 0, s: '!', brk: true });
        const nd = appendNode({ t: 0, s: '[', brk: true });
        brackets.push({ node: nd, image: true, active: true, textStart: i + 2, excl });
        i += 2; continue;
      }
      addText('!'); i++; continue;
    }
    if (ch === ']') {
      const pos = tryLink(i);
      if (pos >= 0) { i = pos; continue; }
      addText(']'); i++; continue;
    }
    if (ch === '<') {
      const auto = matchAutolink(s, i);
      if (auto) {
        appendNode({ t: 4, href: cleanHref(auto.mailto ? 'mailto:' + auto.text : auto.text), title: null });
        addText(auto.text);
        appendNode({ t: 5 });
        i = auto.end;
        continue;
      }
      const tag = matchHtmlTag(s, i);
      if (tag !== null) { appendNode({ t: 3, s: tag }); i += tag.length; continue; }
      addText('<'); i++; continue;
    }
    if (ch === '&') {
      if (s[i + 1] === '#') {
        let j = i + 2, hex = false;
        if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
        const start = j;
        while (j < n && (hex ? /[0-9A-Fa-f]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
        if (j > start && s[j] === ';') {
          const decoded = decodeNumeric(s.slice(i + 1, j));
          if (decoded !== null) { addDecoded(decoded); i = j + 1; continue; }
        }
        addText('&'); i++; continue;
      }
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++;
      if (j > i + 1 && s[j] === ';') { addText(s.slice(i, j + 1)); i = j + 1; continue; }
      addText('&'); i++; continue;
    }
    if (ch === '\n') {
      if (tail && tail.t === 0 && !tail.brk) {
        const ts = tail.s;
        let spaces = 0, k = ts.length - 1;
        while (k >= 0 && ts[k] === ' ') { spaces++; k--; }
        if (spaces >= 2) {
          // A two-space hard break consumes the leading whitespace of
          // the next line (marked's br token raw includes it).
          tail.s = ts.slice(0, ts.length - spaces);
          appendNode({ t: 6 });
          i++;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
          continue;
        }
      }
      addText('\n'); i++; continue;
    }
    // Plain text run.
    let j = i;
    while (j < n) {
      const c = s[j];
      if (c === '\\' || c === '`' || c === '*' || c === '_' || c === '~' ||
          c === '[' || c === '!' || c === ']' || c === '<' || c === '&' || c === '\n') break;
      if (j > i && isWordChar(c)) {
        const p = s[j - 1];
        if (!isWordChar(p) && p !== '/' && p !== '.') break;
      }
      j++;
    }
    addText(s.slice(i, j));
    i = j;
  }

  processEmphasis(delims, insertAfter, insertBefore, removeNode);

  let out = '';
  let nd = head;
  while (nd) {
    switch (nd.t) {
      case 0: out += escapeText(nd.s); break;
      case 10: out += escapeCode(nd.s); break;
      case 1: out += nd.ch.repeat(nd.num); break;
      case 2: out += '<code>' + escapeCode(nd.s) + '</code>'; break;
      case 3: out += nd.s; break;
      case 4:
        out += '<a href="' + escapeText(nd.href) + '"' +
          (nd.title != null ? ' title="' + escapeText(nd.title) + '"' : '') + '>';
        break;
      case 5: out += '</a>'; break;
      case 6: out += '<br>'; break;
      case 7:
        out += '<img src="' + escapeText(nd.href) + '" alt="' + nd.alt + '"' +
          (nd.title != null ? ' title="' + escapeText(nd.title) + '"' : '') + '>';
        break;
      case 8: case 9: out += nd.s; break;
    }
    nd = nd.next;
  }
  return out;
}

// ---- block parsing ------------------------------------------------------
// Block tree nodes:
//  {k:'p', lines:[...]} paragraph (raw lines, link-ref defs removed)
//  {k:'h', level, text} heading (raw inline text)
//  {k:'code', info, text} fenced/indented code (text already joined)
//  {k:'hr'}  {k:'html', text}
//  {k:'q', c:[...]} blockquote
//  {k:'l', ordered, start, tight, items:[{task, c:[...]}]} list
//  {k:'table', aligns:[], header:[...], rows:[[...]]}

// Try to parse a link reference definition starting at lines[startIdx].
// Returns {label, href, title, linesUsed} or null.
function tryParseDef(lines, startIdx, refs) {
  const first = lines[startIdx];
  if (first === undefined) return null;
  // Label must start within 3 columns of indent.
  const ws = leadingWs(first);
  if (ws.cols > 3) return null;
  let p = ws.chars;
  if (first[p] !== '[') return null;
  // Scan the label (may span lines, but not a blank line).
  let label = '';
  let li = startIdx, lp = p + 1;
  let closed = false;
  while (li < lines.length) {
    const line = lines[li];
    while (lp < line.length) {
      const c = line[lp];
      if (c === '\\' && lp + 1 < line.length && isAsciiPunct(line[lp + 1])) {
        label += c + line[lp + 1]; lp += 2; continue;
      }
      if (c === '[') return null;
      if (c === ']') { closed = true; lp++; break; }
      label += c; lp++;
    }
    if (closed) break;
    // Continue on the next line (label may span lines).
    li++;
    if (li >= lines.length) return null;
    if (isBlank(lines[li])) return null;
    label += '\n'; lp = 0;
  }
  if (!closed) return null;
  if (label.trim() === '') return null;
  // Expect ':'.
  if (lines[li][lp] !== ':') return null;
  lp++;
  // Skip whitespace, possibly across one line break (but not a blank line).
  let di = li, dp = lp;
  const skipWsLines = () => {
    while (true) {
      while (dp < lines[di].length && (lines[di][dp] === ' ' || lines[di][dp] === '\t')) dp++;
      if (dp < lines[di].length) return true;
      if (di + 1 >= lines.length) return false;
      if (isBlank(lines[di + 1])) return false;
      di++; dp = 0;
    }
  };
  if (!skipWsLines()) return null;
  // Destination.
  let dest = '';
  if (lines[di][dp] === '<') {
    let q = dp + 1, out = '';
    const line = lines[di];
    while (q < line.length) {
      const c = line[q];
      if (c === '>') break;
      if (c === '\\' && q + 1 < line.length && isAsciiPunct(line[q + 1])) { out += line[q + 1]; q += 2; continue; }
      out += c; q++;
    }
    if (q >= line.length || line[q] !== '>') return null;
    dest = out; dp = q + 1;
  } else {
    let q = dp, depth = 0, out = '';
    const line = lines[di];
    while (q < line.length) {
      const c = line[q];
      if (c === ' ' || c === '\t' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && q + 1 < line.length) {
        const nx = line[q + 1];
        if (nx === ' ' || nx === '\t') break;
        if (isAsciiPunct(nx)) { out += nx; q += 2; continue; }
        out += '\\'; q++; continue;
      }
      if (c === '(') { depth++; out += c; q++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; out += c; q++; continue;
      }
      out += c; q++;
    }
    if (depth !== 0 || q === dp) return null;
    dest = out; dp = q;
  }
  // Optional title: separated from the destination by spaces, or by a
  // newline (then it may sit on the next line). A title that does not
  // parse cleanly, or has anything but spaces after it, is dropped and
  // the definition stands without it — but only when the destination
  // line ends there; junk on the destination line voids the definition.
  let title = null;
  let endTi = di;
  let ti = di, tp = dp, sep = false;
  while (tp < lines[ti].length && (lines[ti][tp] === ' ' || lines[ti][tp] === '\t')) { tp++; sep = true; }
  if (tp >= lines[ti].length && ti + 1 < lines.length && !isBlank(lines[ti + 1])) {
    let np = 0;
    const nl = lines[ti + 1];
    while (np < nl.length && (nl[np] === ' ' || nl[np] === '\t')) np++;
    if (np < nl.length && (nl[np] === '"' || nl[np] === "'" || nl[np] === '(')) {
      ti = ti + 1; tp = np; sep = true;
    }
  }
  if (sep && tp < lines[ti].length) {
    const qc = lines[ti][tp];
    if (qc === '"' || qc === "'" || qc === '(') {
      const close = qc === '(' ? ')' : qc;
      let out = '', ok = false, bad = false;
      let qi = ti, qp = tp + 1;
      while (qi < lines.length && !ok && !bad) {
        const line = lines[qi];
        while (qp < line.length) {
          const c = line[qp];
          if (c === close) { ok = true; qp++; break; }
          if (c === '\\' && qp + 1 < line.length && isAsciiPunct(line[qp + 1])) { out += line[qp + 1]; qp += 2; continue; }
          if (qc === '(' && c === '(') { bad = true; break; }
          out += c; qp++;
        }
        if (ok || bad) break;
        qi++;
        if (qi >= lines.length) { bad = true; break; }
        if (isBlank(lines[qi])) { bad = true; break; }
        out += '\n'; qp = 0;
      }
      if (ok) {
        // Only spaces may follow the title on its line.
        let rp = qp;
        while (rp < lines[qi].length && (lines[qi][rp] === ' ' || lines[qi][rp] === '\t')) rp++;
        if (rp >= lines[qi].length) { title = out; endTi = qi; }
      }
      // Otherwise the title is dropped (fall back to no title).
    }
  }
  if (title === null) {
    // No title: only spaces may follow the destination on its line.
    let ep = dp;
    while (ep < lines[di].length && (lines[di][ep] === ' ' || lines[di][ep] === '\t')) ep++;
    if (ep < lines[di].length) return null;
    endTi = di;
  }
  return { label, href: dest, title, linesUsed: endTi - startIdx + 1 };
}

// Remove leading link reference definitions from a paragraph's lines,
// registering them in refs (first definition wins). Returns the remaining
// lines.
function extractDefs(lines, refs) {
  let idx = 0;
  while (idx < lines.length) {
    const d = tryParseDef(lines, idx, refs);
    if (!d) break;
    const key = normalizeLabel(d.label);
    if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    idx += d.linesUsed;
  }
  return lines.slice(idx);
}

function isSetextLine(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}
function isHrLine(line) {
  return /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(line);
}
function atxHeading(line) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return null;
  let p = ws.chars;
  if (line[p] !== '#') return null;
  let n = 0;
  while (line[p + n] === '#') n++;
  if (n > 6) return null;
  const rest = line.slice(p + n);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  let content = rest.trim();
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/[ \t]+#+$/, '');
  return { level: n, text: content };
}
function fenceStart(line) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return null;
  let p = ws.chars;
  const ch = line[p];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (line[p + n] === ch) n++;
  if (n < 3) return null;
  const info = line.slice(p + n).trim();
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len: n, info, indent: ws.chars };
}
// Strip up to indentLen leading whitespace characters from a fenced
// code content line (marked strips by character count, not columns).
function dedentFenceLine(line, indentLen) {
  let k = 0;
  while (k < line.length && k < indentLen && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}
function isFenceEnd(line, fence) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return false;
  let p = ws.chars;
  if (line[p] !== fence.ch) return false;
  let n = 0;
  while (line[p + n] === fence.ch) n++;
  if (n < fence.len) return false;
  return /^[ \t]*$/.test(line.slice(p + n));
}
// Delimiter row of a GFM table? Returns aligns array or null.
function tableDelimiter(line) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return null;
  let cells = line.split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t[0] === ':' && t[t.length - 1] === ':') aligns.push('center');
    else if (t[0] === ':') aligns.push('left');
    else if (t[t.length - 1] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}
function splitTableRow(line) {
  let cells = [];
  let cur = '', i = 0;
  // Strip one leading and one trailing pipe (with surrounding spaces).
  let s = line;
  const lead = /^ *\|/.exec(s);
  if (lead) s = s.slice(lead[0].length);
  const trail = /\|[ \t]*$/.exec(s);
  if (trail) s = s.slice(0, s.length - trail[0].length);
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// HTML block start: returns {type, endTag} or null. Types:
// 1 script/pre/style/textarea, 2 comment, 3 <?, 4 <!letter, 5 CDATA,
// 6 block tag, 7 complete tag on its own line.
function htmlBlockStart(line) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return null;
  const s = line.slice(ws.chars);
  if (s[0] !== '<') return null;
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(s);
  if (m1) return { type: 1, endTag: m1[1].toLowerCase() };
  if (s.startsWith('<!--')) return { type: 2 };
  if (s.startsWith('<?')) return { type: 3 };
  if (/^<![A-Za-z]/.test(s)) return { type: 4 };
  if (s.startsWith('<![CDATA[')) return { type: 5 };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|$|>|\/>)/.exec(s);
  if (m6) {
    const name = m6[1].toLowerCase();
    // Type 6: a block tag name followed by space, tab, end of line, > or />.
    if (BLOCK_TAGS.has(name)) return { type: 6 };
  }
  // Type 7: the whole line is one complete open tag (any tag, with
  // attributes) or one complete close tag.
  if (/^<[A-Za-z][A-Za-z0-9-]*(?: +[A-Za-z_:][A-Za-z0-9_.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?>[ \t]*$/.test(s)) return { type: 7 };
  if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(s)) return { type: 7 };
  return null;
}
function htmlBlockEnds(line, h) {
  if (h.type === 1) return line.toLowerCase().indexOf('</' + h.endTag + '>') !== -1;
  if (h.type === 2) return line.indexOf('-->') !== -1;
  if (h.type === 3) return line.indexOf('?>') !== -1;
  if (h.type === 4) return line.indexOf('>') !== -1;
  if (h.type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// List marker at the start of a line (indent <= 3). Returns
// {ordered, marker, delim, indent, content} where content is the rest of
// the line after the marker and following whitespace, or null.
function listMarker(line) {
  const ws = leadingWs(line);
  if (ws.cols > 3) return null;
  const s = line.slice(ws.chars);
  const bm = /^([*+-])(?:[ \t]+(.*))?$/.exec(s);
  if (bm) {
    if (bm[2] === undefined) return { ordered: false, marker: bm[1], indent: ws.cols, after: '' };
    return { ordered: false, marker: bm[1], indent: ws.cols, after: bm[2] };
  }
  const om = /^(\d{1,9})([.)])(?:[ \t]+(.*))?$/.exec(s);
  if (om) {
    if (om[3] === undefined) return { ordered: true, marker: om[1] + om[2], delim: om[2], start: +om[1], indent: ws.cols, after: '' };
    return { ordered: true, marker: om[1] + om[2], delim: om[2], start: +om[1], indent: ws.cols, after: om[3] };
  }
  return null;
}
// Can this list marker interrupt a paragraph? (Non-empty item; ordered
// lists must start at 1.)
function listInterrupts(line) {
  const m = listMarker(line);
  if (!m) return false;
  // A marker alone on its line with nothing after it is empty.
  const s = line.slice(leadingWs(line).chars);
  const after = s.slice(m.marker.length);
  if (after.trim() === '') return false;
  if (m.ordered && m.start !== 1) return false;
  return true;
}

// Parse blocks in lines[lo..hi) into a list of block nodes.
// top=true: "paragraph regex" behaviour (document root and blockquote
// interiors) — indented continuation lines stay in the paragraph verbatim.
// top=false: list-item interiors — a continuation line with 4+ columns of
// indent is merged into the paragraph with the code indent stripped
// (marked's indented-code-cannot-interrupt-a-paragraph rule).
// lastUnterm: the last line of this range has no trailing newline, so a
// spaces-only last line is paragraph text rather than a blank line.
function parseBlocks(lines, lo, hi, refs, top, eofNL, lastUnterm) {
  const out = [];
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    // ATX heading
    const atx = atxHeading(line);
    if (atx) { out.push({ k: 'h', level: atx.level, text: atx.text, _s: i, _e: i + 1 }); i++; continue; }
    // Fenced code
    const fence = fenceStart(line);
    if (fence) {
      let j = i + 1;
      while (j < hi && !isFenceEnd(lines[j], fence)) j++;
      const content = lines.slice(i + 1, j).map((l) => dedentFenceLine(l, fence.indent));
      // A fenced code block ends with exactly one trailing newline: pop
      // one trailing blank content line (marked's fences tokenizer).
      if (content.length && content[content.length - 1] === '') content.pop();
      const text = content.length ? content.join('\n') + '\n' : '';
      const info = (fence.info.split(/[ \t]+/, 1)[0] || '').replace(/\\(.)/g, (m, c) => (isAsciiPunct(c) ? c : m));
      out.push({ k: 'code', info, text, fenced: true, _s: i, _e: j < hi ? j + 1 : j });
      i = j < hi ? j + 1 : j;
      continue;
    }
    // Indented code
    if (isCodeIndent(line)) {
      const content = [];
      let j = i;
      while (j < hi) {
        const l = lines[j];
        if (isCodeIndent(l)) { content.push(removeCodeIndent(l)); j++; continue; }
        if (isBlank(l)) {
          // Include blank lines only when followed by an indented line.
          let k = j + 1;
          while (k < hi && isBlank(lines[k])) k++;
          if (k < hi && isCodeIndent(lines[k])) {
            while (j < k) { content.push(''); j++; }
            continue;
          }
          break;
        }
        break;
      }
      while (content.length && content[content.length - 1] === '') content.pop();
      out.push({ k: 'code', info: '', text: content.length ? content.join('\n') + '\n' : '', _s: i, _e: j });
      i = j;
      continue;
    }
    // Thematic break
    if (isHrLine(line)) { out.push({ k: 'hr', _s: i, _e: i + 1 }); i++; continue; }
    // Blockquote
    const bq = /^ {0,3}>/.exec(line);
    if (bq) {
      // Strip a blockquote marker (with the whitespace expansion marked
      // does) from a marker line; returns the inner text.
      const stripBqMarker = (l) => {
        const m = /^ {0,3}>([ \t]*)/.exec(l);
        const markerCol = m[0].length - m[1].length;
        let col = markerCol, expanded = '';
        for (const ch of m[1]) {
          if (ch === ' ') { expanded += ' '; col++; }
          else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
        }
        return expanded.slice(1) + l.slice(m[0].length);
      };
      // Collect the raw lines (with markers) of the blockquote's extent:
      // marker lines, and lazy paragraph lines while inside a paragraph
      // (a list item or nested blockquote line counts as a paragraph
      // line here, as in marked's blockquote regex). A blank line ends
      // the extent.
      const raw = [];
      let j = i;
      let inPara = false;
      let inFence = null;
      while (j < hi) {
        const l = lines[j];
        const m = /^ {0,3}>([ \t]*)/.exec(l);
        if (m) {
          const rest = stripBqMarker(l);
          raw.push({ rest, marker: true });
          if (!inFence) {
            const f = fenceStart(rest);
            if (f) inFence = f;
          } else if (isFenceEnd(rest, inFence)) inFence = null;
          inPara = !isBlank(rest) && !atxHeading(rest) && !fenceStart(rest) && !isHrLine(rest) &&
            !htmlBlockStart(rest);
          j++; continue;
        }
        if (isBlank(l)) break;
        // A lazy line inside a fence ends the blockquote (marked's
        // chunk loop breaks at it and the fence token ends the quote).
        if (inFence) break;
        // A lazy line that starts a block (heading, fence, break, list,
        // html, blockquote) is not a paragraph continuation.
        if (inPara && !atxHeading(l) && !fenceStart(l) && !isHrLine(l) &&
            !listMarker(l) && !htmlBlockStart(l) && !/^ {0,3}>/.test(l)) {
          raw.push({ rest: l, marker: false }); j++; continue;
        }
        break;
      }
      // Lex the raw lines in chunks (marked's blockquote tokenizer): a
      // chunk is leading lazy lines plus marker lines until the next lazy
      // line. Paragraphs merge across chunks, and an indented code block
      // at the start of a chunk merges into a preceding paragraph.
      const children = [];
      let idx = 0;
      while (idx < raw.length) {
        let chunkEnd = idx;
        let seenMarker = false;
        while (chunkEnd < raw.length) {
          if (raw[chunkEnd].marker) { seenMarker = true; chunkEnd++; }
          else if (!seenMarker) { chunkEnd++; }
          else break;
        }
        const chunk = raw.slice(idx, chunkEnd);
        const inner = [];
        for (let c = 0; c < chunk.length; c++) {
          let rest = chunk[c].rest;
          // A lazy setext underline (not the first line of the chunk)
          // is indented by 4 spaces, so it stays paragraph text.
          if (c > 0 && !chunk[c].marker && isSetextLine(rest)) {
            rest = '    ' + rest.replace(/^ {0,3}/, '');
          }
          inner.push(rest);
        }
        let chunkBlocks = parseBlocks(inner, 0, inner.length, refs, true, false, true);
        let consumedEnd = chunkEnd;
        // A chunk ending in a nested blockquote or a list absorbs the
        // remaining lines (marked re-lexes it with them appended).
        const last0 = chunkBlocks.length ? chunkBlocks[chunkBlocks.length - 1] : null;
        if (last0 && (last0.k === 'q' || last0.k === 'l') && chunkEnd < raw.length) {
          const ext = raw.slice(chunkEnd);
          const allInner = inner.slice();
          for (let c = 0; c < ext.length; c++) {
            let rest = ext[c].rest;
            if (!ext[c].marker && isSetextLine(rest)) rest = '    ' + rest.replace(/^ {0,3}/, '');
            allInner.push(rest);
          }
          const reBlocks = parseBlocks(allInner, 0, allInner.length, refs, true, false, true);
          // Keep only the blocks up to the re-lexed list/blockquote
          // (later blocks come from lines outside it).
          let cut = reBlocks.length;
          for (let t = 0; t < reBlocks.length; t++) {
            if (reBlocks[t].k === 'q' || reBlocks[t].k === 'l') {
              cut = t + 1;
              // The re-lexed block consumed its span of the extended
              // inner lines; map that back to raw lines.
              consumedEnd = chunkEnd + Math.max(0, reBlocks[t]._e - inner.length);
            }
          }
          chunkBlocks = reBlocks.slice(0, cut);
        }
        // Merge across chunks.
        if (chunkBlocks.length && children.length) {
          const prev = children[children.length - 1];
          const first = chunkBlocks[0];
          if (prev.k === 'p' && first.k === 'p') {
            prev.lines.push(...first.lines);
            chunkBlocks.shift();
          } else if (prev.k === 'p' && first.k === 'code' && !first.fenced) {
            const codeLines = first.text === '' ? [] : first.text.replace(/\n$/, '').split('\n');
            prev.lines.push(...codeLines);
            chunkBlocks.shift();
          }
        }
        for (const b of chunkBlocks) children.push(b);
        idx = consumedEnd;
        if (idx >= raw.length) break;
        const last = children.length ? children[children.length - 1] : null;
        // A chunk ending in code, a heading, a break, html or a table
        // ends the blockquote; the remaining lines are not part of it.
        if (last && (last.k === 'code' || last.k === 'h' || last.k === 'hr' ||
                     last.k === 'html' || last.k === 'table')) break;
      }
      out.push({ k: 'q', c: children, _s: i, _e: i + idx });
      i = i + idx;
      continue;
    }
    // List
    const lm = listMarker(line);
    if (lm) {
      const parsed = parseList(lines, i, hi, refs);
      parsed.node._s = i; parsed.node._e = parsed.end;
      out.push(parsed.node);
      i = parsed.next;
      continue;
    }
    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      let j = i + 1;
      let closed = false;
      if (hb.type === 6 || hb.type === 7) {
        while (j < hi && !isBlank(lines[j])) j++;
      } else {
        // Types 1-5 run through blank lines until the closing line.
        let k = i;
        while (k < hi && !htmlBlockEnds(lines[k], hb)) k++;
        if (k < hi) { j = k + 1; closed = true; }
        else j = hi;
      }
      let trail = false;
      if (j >= hi) trail = eofNL;
      else if (closed) trail = !isBlank(lines[j]);
      out.push({ k: 'html', text: lines.slice(i, j).join('\n'), trail, _s: i, _e: j });
      i = j;
      continue;
    }
    // Paragraph (with setext headings, link refs and tables).
    const para = parseParagraph(lines, i, hi, refs, top, lastUnterm);
    if (para.node) { para.node._s = i; para.node._e = para.next; out.push(para.node); }
    i = para.next;
  }
  return out;
}

// Collect a paragraph starting at lines[i]. Handles setext headings,
// link reference definitions and GFM tables.
function parseParagraph(lines, i, hi, refs, top, lastUnterm) {
  const collected = [];
  let j = i;
  let setext = 0;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      // A spaces-only last line with no trailing newline is paragraph
      // text (marked's paragraph regex only excludes spaces-only lines
      // followed by a newline); an empty last line is still a break.
      if (lastUnterm && j === hi - 1 && line.length > 0) { collected.push(line); j++; continue; }
      break;
    }
    if (j > i) {
      // A setext underline? (Not when the paragraph is a table.)
      const st = isSetextLine(line);
      if (st) {
        const aligns = collected.length >= 2 ? tableDelimiter(collected[1]) : null;
        const isTable = aligns && collected[0].indexOf('|') !== -1;
        if (!isTable) {
          // A setext underline only counts when the paragraph has text
          // left after its link reference definitions are removed;
          // otherwise the line is ordinary paragraph text.
          if (extractDefs(collected, refs).length > 0) { setext = st; j++; break; }
          collected.push(line); j++; continue;
        }
      }
      if (atxHeading(line)) break;
      if (fenceStart(line)) break;
      if (isHrLine(line) && !isSetextLine(line)) break;
      if (/^ {0,3}>/.test(line)) break;
      const hb = htmlBlockStart(line);
      if (hb && hb.type !== 7) break;
      // A list marker interrupts a paragraph. At the document root (and
      // in blockquotes) only a non-empty item starting at 1 can; inside
      // a list item any marker can (marked lexes list-item text with
      // state.top false, so the list tokenizer runs on every line).
      if (top ? listInterrupts(line) : listMarker(line)) break;
      if (!top && isCodeIndent(line)) {
        // Indented-code merge: this line and the rest of the code run are
        // appended to the paragraph with the code indent stripped.
        let k = j;
        while (k < hi) {
          const l = lines[k];
          if (isCodeIndent(l)) { collected.push(removeCodeIndent(l)); k++; continue; }
          if (isBlank(l)) {
            let m = k + 1;
            while (m < hi && isBlank(lines[m])) m++;
            if (m < hi && isCodeIndent(lines[m])) {
              while (k < m) { collected.push(''); k++; }
              continue;
            }
            break;
          }
          break;
        }
        while (collected.length && collected[collected.length - 1] === '') collected.pop();
        j = k;
        continue;
      }
    }
    collected.push(line);
    j++;
  }
  if (setext) {
    const rest = extractDefs(collected, refs);
    if (rest.length === 0) return { node: null, next: j };
    return { node: { k: 'h', level: setext, text: rest.join('\n').trim() }, next: j };
  }
  const rest = extractDefs(collected, refs);
  if (rest.length === 0) return { node: null, next: j };
  // GFM table: header line + delimiter row, then body rows. The header
  // and delimiter must have the same number of columns (marked's table
  // tokenizer requires the counts to match).
  if (rest.length >= 2) {
    const aligns = tableDelimiter(rest[1]);
    if (aligns && rest[0].indexOf('|') !== -1 && splitTableRow(rest[0]).length === aligns.length) {
      const header = splitTableRow(rest[0]);
      const rows = [];
      for (let r = 2; r < rest.length; r++) rows.push(splitTableRow(rest[r]));
      return { node: { k: 'table', aligns, header, rows }, next: j };
    }
  }
  // A trailing line that is only spaces is dropped by the caller via
  // trimEnd of the paragraph text at render time.
  return { node: { k: 'p', lines: rest }, next: j };
}

// Parse a list starting at lines[i]. Returns {node, next}.
// Follows marked 18.1.3's list tokenizer: a following item is a sibling
// when its bullet matches (same char for unordered, same delimiter for
// ordered) and its marker indent is <= min(3, R-1) where R is the previous
// item's content indent; otherwise it is nested content. A line after a
// blank line inside an item is never a lazy continuation. An item is loose
// when it ends with a blank line before another item, or when two of its
// direct child blocks are separated by a blank line.
function parseList(lines, i, hi, refs) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const marker = first.marker;
  const delim = first.delim || null;
  const start = first.start || 0;
  // Content indent of the first item, computed the way marked does:
  // the marker plus the whitespace after it (tabs expanded from the
  // marker's column); if that whitespace is wider than 4 columns the
  // content indent is just marker + 1.
  function contentIndent(line, mk) {
    const s = line.slice(leadingWs(line).chars);
    const afterMarker = s.slice(mk.marker.length);
    if (afterMarker.trim() === '') return mk.indent + mk.marker.length + 1;
    const expanded = expandTabs(afterMarker, mk.indent + mk.marker.length);
    const firstNonWs = expanded.search(/[^ ]/);
    const w = firstNonWs === -1 ? expanded.length : firstNonWs;
    if (w > 4) return mk.indent + mk.marker.length + 1;
    return mk.indent + mk.marker.length + w;
  }
  // Is this line the start of a sibling item of the list (same bullet /
  // delimiter, marker indent within the limit for the previous item)?
  function isSibling(line, prevCi) {
    const mk = listMarker(line);
    if (!mk || mk.ordered !== ordered) return false;
    if (ordered ? mk.delim !== delim : mk.marker !== marker) return false;
    return mk.indent <= Math.min(3, prevCi - 1);
  }
  const items = [];
  let loose = false;
  let prevEndedBlank = false;
  let contentEnd = i + 1;
  let j = i;
  while (j < hi) {
    const line = lines[j];
    // A thematic break ends the list (marked tests its hr rule here).
    if (j > i && isHrLine(line)) break;
    const mk = listMarker(line);
    if (!mk || mk.ordered !== ordered || (ordered ? mk.delim !== delim : mk.marker !== marker)) break;
    if (j > i && !isSibling(line, items.length ? items[items.length - 1].ci : 0)) break;
    if (j > i && isHrLine(line) && mk.marker === '-' && line.trim() === '---') break;
    const ci = contentIndent(line, mk);
    contentEnd = j + 1;
    // First line's content.
    const s = line.slice(leadingWs(line).chars);
    const afterMarker = s.slice(mk.marker.length);
    const expandedFirst = expandTabs(afterMarker, mk.indent + mk.marker.length);
    let firstContent;
    if (afterMarker.trim() === '') firstContent = '';
    else if (expandedFirst.search(/[^ ]/) > 4) firstContent = expandedFirst.slice(1);
    else firstContent = expandedFirst.slice(expandedFirst.search(/[^ ]/));
    const itemLines = [];
    if (firstContent !== '' || afterMarker.trim() !== '') itemLines.push(firstContent);
    else if (afterMarker.trim() === '') itemLines.push('');
    let k = j + 1;
    let endedBlank = false;
    let inPara = firstContent !== '';
    let inFence = fenceStart(firstContent);
    let afterBlank = false;
    // An empty item followed by a blank line ends the item at once
    // (marked skips the content loop and marks the item blank-ended).
    if (firstContent === '' && k < hi && isBlank(lines[k])) {
      endedBlank = true;
      const children = parseBlocks([], 0, 0, refs, false, false);
      if (prevEndedBlank) loose = true;
      items.push({ task: false, c: children, rawLines: [], ci });
      prevEndedBlank = true;
      j = k;
      if (j < hi && isBlank(lines[j])) {
        let m = j;
        while (m < hi && isBlank(lines[m])) m++;
        if (m < hi && isSibling(lines[m], ci)) { j = m; continue; }
      }
      break;
    }
    while (k < hi) {
      const l = lines[k];
      if (isBlank(l)) {
        // Blank lines belong to the item when followed by item content.
        let m = k + 1;
        while (m < hi && isBlank(lines[m])) m++;
        if (m < hi) {
          const nl = lines[m];
          const nIndent = leadingWs(nl).cols;
          if (isSibling(nl, ci) || nIndent >= ci || (inPara && !afterBlank && !isBlank(nl))) {
            while (k < m) { itemLines.push(''); k++; }
            endedBlank = true;
            afterBlank = true;
            continue;
          }
        }
        break;
      }
      if (isSibling(l, ci)) break;
      // A block-starting line at indent < ci - 1 ends the item.
      const indent = leadingWs(l).cols;
      if (indent < ci) {
        const expanded = expandTabs(l, 0);
        const eIndent = leadingWs(expanded).cols;
        if (eIndent <= ci - 1) {
          const nmk = listMarker(l);
          if (atxHeading(l) || fenceStart(l) || isHrLine(l) || /^ {0,3}>/.test(l) ||
              htmlBlockStart(l) || (nmk && nmk.indent <= ci - 1)) break;
        }
        // Lazy paragraph continuation (never after a blank line).
        if (inPara && !afterBlank && !inFence && !atxHeading(l) && !fenceStart(l) && !isHrLine(l) &&
            !listInterrupts(l) && !htmlBlockStart(l) && !/^ {0,3}>/.test(l)) {
          // A lazy setext underline is indented by 4 spaces (marked's
          // list tokenizer), so it stays paragraph text.
          const prev = itemLines.length ? itemLines[itemLines.length - 1] : '';
          if (prev !== '' && isSetextLine(l)) {
            itemLines.push('    ' + l.replace(/^ {0,3}/, ''));
          } else {
            itemLines.push(l);
          }
          inPara = true;
          contentEnd = k + 1;
          k++; continue;
        }
        break;
      }
      // Indented content line: strip ci columns.
      const stripped = stripCols(l, ci);
      itemLines.push(stripped);
      if (!inFence) {
        const f = fenceStart(stripped);
        if (f) inFence = f;
      } else if (isFenceEnd(stripped, inFence)) inFence = null;
      inPara = !isBlank(stripped) && !atxHeading(stripped) && !fenceStart(stripped) &&
        !isHrLine(stripped) && !listMarker(stripped) && !htmlBlockStart(stripped);
      endedBlank = false;
      afterBlank = false;
      contentEnd = k + 1;
      k++;
    }
    // Loose when the previous item ended with a blank line, when two of
    // this item's direct child blocks are separated by a blank line, or
    // when a blank line at the item level (not inside a nested block)
    // has item-level content on both sides (marked's space token, which
    // also appears before a link reference definition).
    if (prevEndedBlank) loose = true;
    // Trim trailing blank lines from the item's content.
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const children = parseBlocks(itemLines, 0, itemLines.length, refs, false, false);
    let itemLoose = false;
    for (let t = 1; t < children.length; t++) {
      if (children[t]._s > children[t - 1]._e) { itemLoose = true; break; }
    }
    if (!itemLoose) {
      for (let p = 0; p < itemLines.length; p++) {
        if (itemLines[p] !== '') continue;
        let inside = false;
        for (const ch of children) { if (p >= ch._s && p < ch._e) { inside = true; break; } }
        if (inside) continue;
        let before = false, after = false;
        for (const ch of children) { if (ch._e <= p) before = true; if (ch._s > p) after = true; }
        for (let q = 0; q < p && !before; q++) {
          if (itemLines[q] !== '' && !children.some((ch) => q >= ch._s && q < ch._e)) before = true;
        }
        for (let q = p + 1; q < itemLines.length && !after; q++) {
          if (itemLines[q] !== '' && !children.some((ch) => q >= ch._s && q < ch._e)) after = true;
        }
        if (before && after) { itemLoose = true; break; }
      }
    }
    if (itemLoose) loose = true;
    if (endedBlank && k < hi) prevEndedBlank = true; else prevEndedBlank = false;
    items.push({ task: false, c: children, rawLines: itemLines, ci });
    j = k;
    // A following blank line separates items (already consumed into the
    // item when it belonged to it); move on.
    if (j < hi && isBlank(lines[j])) {
      // Blank lines after the last item do not belong to the list.
      let m = j;
      while (m < hi && isBlank(lines[m])) m++;
      if (m < hi && isSibling(lines[m], ci)) {
        j = m;
        continue;
      }
      break;
    }
  }
  // Task list markers live on the item's first paragraph.
  for (const it of items) {
    const firstBlock = it.c[0];
    if (firstBlock && firstBlock.k === 'p' && firstBlock.lines.length) {
      const m = /^\[([ xX])\][ \t]+(?=\S)/.exec(firstBlock.lines[0]);
      if (m) {
        it.task = true;
        it.taskChecked = m[1] !== ' ';
        firstBlock.lines[0] = firstBlock.lines[0].slice(m[0].length);
        if (firstBlock.lines[0] === '' && firstBlock.lines.length > 1) firstBlock.lines.shift();
        if (firstBlock.lines.length === 1 && firstBlock.lines[0] === '') firstBlock.lines.length = 0;
      }
    }
  }
  return {
    node: { k: 'l', ordered, start, tight: !loose, items },
    next: j,
    // End of the list's last non-blank content line (trailing blank
    // lines consumed into the last item do not extend the list's span).
    end: contentEnd,
  };
}

// ---- rendering ----------------------------------------------------------

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}
function renderBlock(b, refs) {
  switch (b.k) {
    case 'h': {
      const t = inlineHtml(b.text, refs);
      return '<h' + b.level + '>' + t + '</h' + b.level + '>\n';
    }
    case 'code': {
      const cls = b.info !== '' ? ' class="language-' + escapeText(b.info) + '"' : '';
      return '<pre><code' + cls + '>' + escapeCode(b.text) + '</code></pre>\n';
    }
    case 'hr': return '<hr>\n';
    case 'html': return b.text + (b.trail ? '\n' : '');
    case 'p': {
      const text = b.lines.join('\n');
      if (text === '') return '';
      return '<p>' + inlineHtml(text, refs) + '</p>\n';
    }
    case 'q': {
      const inner = renderBlocks(b.c, refs);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.header.length; c++) {
        const al = b.aligns[c];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inlineHtml(b.header[c], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let c = 0; c < b.header.length; c++) {
            const cell = c < row.length ? row[c] : '';
            const al = b.aligns[c];
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inlineHtml(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    case 'l': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const it of b.items) {
        const inner = renderListItem(it, refs, b.tight);
        out += '<li>' + inner + '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
  }
  return '';
}
function renderListItem(it, refs, tight) {
  const task = it.task ? (it.taskChecked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') : '';
  if (it.c.length === 0) return task;
  let out = '';
  for (let idx = 0; idx < it.c.length; idx++) {
    const b = it.c[idx];
    if (tight && b.k === 'p' && b.lines.length) {
      // Tight item: paragraph without <p> wrapper.
      const text = b.lines.join('\n');
      if (text === '') continue;
      out += (idx === 0 ? task : '') + inlineHtml(text, refs);
      continue;
    }
    const rendered = renderBlock(b, refs);
    if (rendered === '') continue;
    if (idx === 0 && task && b.k === 'p') {
      out += rendered.replace(/^<p>/, '<p>' + task);
    } else if (idx === 0 && task) {
      out += task + rendered;
    } else {
      out += rendered;
    }
  }
  return out;
}

// ---- entry point --------------------------------------------------------

// parse(markdown) -> HTML, byte-identical to marked 18.1.3 (default options,
// GFM on) on the competition's case set.
export function parse(markdown) {
  let src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline produces a final empty line; drop it.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const blocks = parseBlocks(lines, 0, lines.length, refs, true, src.endsWith('\n'), !src.endsWith('\n'));
  return renderBlocks(blocks, refs);
}
export default parse;
