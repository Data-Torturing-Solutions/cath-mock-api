/**
 * Parses HMCTS `ListType.java` into `vendor/list-types.json`.
 *
 * The enum is hand-maintained upstream and changes without notice (see the
 * README's "Schema drift" note), so we never hand-write the list -- we parse
 * the real source out of a git mirror. See scripts/refresh-reference-data.ps1.
 *
 * Usage: node scripts/extract-list-types.mjs <ListType.java> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node extract-list-types.mjs <ListType.java> <out.json>');
  process.exit(1);
}

const source = readFileSync(inPath, 'utf8');

// The enum body runs from `enum ListType {` to the first `;` that terminates
// the constant list (Java allows methods after it, which we do not want).
const bodyStart = source.indexOf('enum ListType {');
if (bodyStart === -1) throw new Error('could not find `enum ListType {`');
const body = source.slice(bodyStart + 'enum ListType {'.length);

// Constants are declared at a 4-space indent as `NAME(...)` or bare `NAME,`.
const constantRe = /^ {4}([A-Z][A-Z0-9_]*)\s*(\(|,|;)/gm;

const listTypes = [];
let match;
while ((match = constantRe.exec(body)) !== null) {
  const name = match[1];

  // Stop at the terminating `;` of the constant list -- anything matching
  // after that point is a static field, not a list type.
  const upTo = body.slice(0, match.index);
  if (/;\s*$/m.test(upTo.split('\n').slice(-3).join('\n').trimEnd()) && listTypes.length > 0) {
    const trailing = upTo.trimEnd();
    if (trailing.endsWith(';')) break;
  }

  // The first string literal inside the constant's arg list is the friendly
  // name where one is given; otherwise we derive one from the enum name.
  let friendlyName = null;
  if (match[2] === '(') {
    const argsStart = match.index + match[0].length;
    let depth = 1;
    let i = argsStart;
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
      i++;
    }
    const args = body.slice(argsStart, i - 1);
    const literal = args.match(/"([^"]*)"/);
    if (literal) friendlyName = literal[1];
  }

  listTypes.push({ name, friendlyName: friendlyName ?? titleCase(name) });
}

function titleCase(enumName) {
  const acronyms = new Set([
    'SJP', 'COP', 'ET', 'SSCS', 'IAC', 'UT', 'FTT', 'RPT', 'CIC', 'CST', 'GRC',
    'SEND', 'AST', 'PHT', 'SIAC', 'WPAFCC', 'PDDA', 'JR', 'KB', 'CHD', 'MHT',
    'CCMCC', 'RCJ', 'PDA',
  ]);
  return enumName
    .split('_')
    .map((word) =>
      acronyms.has(word) ? word : word.charAt(0) + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

const seen = new Set();
const unique = listTypes.filter((lt) => {
  if (seen.has(lt.name)) return false;
  seen.add(lt.name);
  return true;
});

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      source:
        'https://github.com/hmcts/pip-data-models/blob/master/src/main/java/uk/gov/hmcts/reform/pip/model/publication/ListType.java',
      count: unique.length,
      listTypes: unique,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${unique.length} list types -> ${outPath}`);
