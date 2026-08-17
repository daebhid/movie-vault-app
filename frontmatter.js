/* Surgical frontmatter editing.
 *
 * Deliberately NOT a YAML library. Parsing to an object and re-serialising
 * would reorder keys, restyle lists and reflow the long folded `plot:` blocks —
 * turning a one-tap rating change into a whole-file rewrite and mangling files
 * hand-edited in Typora. Everything here replaces only the lines it targets and
 * leaves every other byte untouched.
 *
 * Kept in its own file so it can be tested outside the browser.
 */

(function (root) {
  'use strict';

  const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

  function splitFile(text) {
    const m = text.match(FM_RE);
    if (!m) throw new Error('File has no frontmatter');
    return { fm: m[1], body: m[2] };
  }

  const joinFile = (fm, body) => `---\n${fm}\n---\n${body}`;

  /** Quote only when plain YAML would misread the value. */
  function yamlValue(v) {
    const s = String(v);
    const safe = /^[A-Za-z0-9][A-Za-z0-9 '&.\-\/()]*$/.test(s) && !/:\s/.test(s);
    return safe ? s : JSON.stringify(s);
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Replace a single-line scalar in place. Only safe for keys whose value is on
   * one line — never use it for `plot`, which folds across several.
   */
  function setScalar(fm, key, value) {
    const re = new RegExp(`^${escapeRe(key)}:.*$`, 'm');
    const line = `${key}: ${value}`;
    return re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
  }

  /**
   * Replace a block list (`genres:`, `watchlists:`) in place, keeping its
   * position. Handles both `key: []` and `key:` followed by `- item` lines.
   */
  function setList(fm, key, values) {
    const rendered = values.length
      ? [`${key}:`, ...values.map((v) => `- ${yamlValue(v)}`)]
      : [`${key}: []`];

    const head = new RegExp(`^${escapeRe(key)}:`);
    const lines = fm.split('\n');
    const out = [];
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      if (!found && head.test(lines[i])) {
        found = true;
        out.push(...rendered);
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) i++;
        continue;
      }
      out.push(lines[i]);
    }
    if (!found) out.push(...rendered);
    return out.join('\n');
  }

  /** Read a block list back out of raw frontmatter text. */
  function getList(fm, key) {
    const head = new RegExp(`^${escapeRe(key)}:`);
    const lines = fm.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!head.test(lines[i])) continue;
      if (/\[\s*\]\s*$/.test(lines[i])) return [];
      const out = [];
      for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) {
        out.push(lines[j].replace(/^\s*-\s+/, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim());
      }
      return out;
    }
    return [];
  }

  /** Replace the review body, leaving the frontmatter untouched. */
  function setBody(text, body) {
    const { fm } = splitFile(text);
    return joinFile(fm, body.replace(/\r\n/g, '\n'));
  }

  const api = { splitFile, joinFile, yamlValue, setScalar, setList, getList, setBody };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FM = api;
})(typeof self !== 'undefined' ? self : this);
