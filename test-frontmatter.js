/* Proves the surgical editors never disturb anything they weren't aimed at.
 *
 * Runs every editor over every real film file and asserts that the ONLY lines
 * that differ are the ones being targeted. A regression here would quietly
 * corrupt the collection, so this is the test worth having.
 *
 *   node test-frontmatter.js ../movie-vault-data
 */

const fs = require('fs');
const path = require('path');
const FM = require('./frontmatter.js');

const dataDir = process.argv[2] || '../movie-vault-data';
const moviesDir = path.join(dataDir, 'movies');
const files = fs.readdirSync(moviesDir).filter((f) => f.endsWith('.md'));

let checked = 0;
const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

/** Lines present in `a` but not `b`, and vice versa. */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const removed = [], added = [];
  const countOf = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = countOf(A), cb = countOf(B);
  for (const [l, n] of ca) { const d = n - (cb.get(l) || 0); for (let i = 0; i < d; i++) removed.push(l); }
  for (const [l, n] of cb) { const d = n - (ca.get(l) || 0); for (let i = 0; i < d; i++) added.push(l); }
  return { removed, added };
}

for (const file of files) {
  const full = path.join(moviesDir, file);
  const original = fs.readFileSync(full, 'utf8');
  let parts;
  try { parts = FM.splitFile(original); }
  catch { fail(file, 'no frontmatter'); continue; }
  checked++;

  // 1. Round trip with no change must be byte-identical.
  if (FM.joinFile(parts.fm, parts.body) !== original) fail(file, 'round trip altered the file');

  // 2. Rating: exactly one line differs, and it is the rating line.
  //    Pick a value the film does not already have, or the diff is empty.
  {
    const existing = (parts.fm.match(/^rating:\s*(.*)$/m) || [])[1];
    const target = existing && existing.trim() === '4.5' ? 3 : 4.5;
    const out = FM.joinFile(FM.setScalar(parts.fm, 'rating', target), parts.body);
    const { removed, added } = lineDiff(original, out);
    if (added.length !== 1 || !added[0].startsWith('rating:')) fail(file, `rating added ${JSON.stringify(added)}`);
    if (removed.length !== 1 || !removed[0].startsWith('rating:')) fail(file, `rating removed ${JSON.stringify(removed)}`);
  }

  // 3. Clearing the rating must produce valid `null`, not an empty value.
  {
    const out = FM.joinFile(FM.setScalar(parts.fm, 'rating', 'null'), parts.body);
    if (!/^rating: null$/m.test(out)) fail(file, 'clearing rating did not write null');
  }

  // 4. Watchlists: only the watchlists block may change, and it must read back.
  {
    const before = FM.getList(parts.fm, 'watchlists');
    const next = [...before, 'testlist'];
    const fm2 = FM.setList(parts.fm, 'watchlists', next);
    if (JSON.stringify(FM.getList(fm2, 'watchlists')) !== JSON.stringify(next)) {
      fail(file, 'watchlists did not read back');
    }
    const { removed, added } = lineDiff(original, FM.joinFile(fm2, parts.body));
    const allowed = (l) => l.startsWith('watchlists:') || /^-\s/.test(l);
    if (!added.every(allowed) || !removed.every(allowed)) {
      fail(file, `watchlists touched other lines: -${JSON.stringify(removed)} +${JSON.stringify(added)}`);
    }
  }

  // 5. Genres collapsed to one — the core cleanup operation.
  {
    const fm2 = FM.setList(parts.fm, 'genres', ['Historical']);
    if (JSON.stringify(FM.getList(fm2, 'genres')) !== '["Historical"]') fail(file, 'genre did not read back');
    const { removed, added } = lineDiff(original, FM.joinFile(fm2, parts.body));
    const allowed = (l) => l.startsWith('genres:') || /^-\s/.test(l);
    if (!added.every(allowed) || !removed.every(allowed)) {
      fail(file, `genre touched other lines: -${JSON.stringify(removed)} +${JSON.stringify(added)}`);
    }
  }

  // 6. Emptying a list must use `[]`, matching the existing convention.
  {
    const fm2 = FM.setList(parts.fm, 'watchlists', []);
    if (!/^watchlists: \[\]$/m.test(fm2)) fail(file, 'empty list not written as []');
  }

  // 7. Review body: frontmatter must be untouched.
  {
    const out = FM.setBody(original, 'A new review.');
    if (FM.splitFile(out).fm !== parts.fm) fail(file, 'setBody altered the frontmatter');
    if (FM.splitFile(out).body.trim() !== 'A new review.') fail(file, 'setBody did not set the body');
  }
}

// 8. Values needing quotes.
const q = FM.yamlValue;
const quoteCases = [
  ['Coming of Age', 'Coming of Age'], ['Science Fiction', 'Science Fiction'],
  ['Self Destruction', 'Self Destruction'], ['law of sines', 'law of sines'],
  ['the huh', 'the huh'], ['Film Noir', 'Film Noir'],
  ['yes: no', '"yes: no"'], ['- dash', '"- dash"'], ['#hash', '"#hash"'],
];
for (const [input, expected] of quoteCases) {
  if (q(input) !== expected) failures.push(`yamlValue(${JSON.stringify(input)}) = ${q(input)}, expected ${expected}`);
}

console.log(`checked ${checked} films`);
if (failures.length) {
  console.error(`\nFAILED — ${failures.length} problem(s):`);
  failures.slice(0, 20).forEach((f) => console.error('  ' + f));
  process.exit(1);
}
console.log('all editors leave every untargeted byte intact');
