const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');

const clientRoot = path.join(__dirname, '..');
const exceptions = new Set([
  "ui/home.js:icon.textContent = 'groups';"
]);

const sourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.name === 'node_modules' || entry.name === 'tests') return [];
  if (entry.isDirectory()) return sourceFiles(absolute);
  if (!entry.name.endsWith('.js') || absolute.endsWith(path.join('utils', 'i18n.js'))) return [];
  return [absolute];
});

it('keeps user-facing English literals in the localization catalog', () => {
  const literalPatterns = [
    /(?:textContent|title|placeholder|ariaLabel)\s*=\s*(['"])[^'"\n]*[A-Za-z][^'"\n]*\1/,
    /setAttribute\(\s*(['"])aria-label\1\s*,\s*(['"])[^'"\n]*[A-Za-z][^'"\n]*\2/,
    /(?:showToast|window\.confirm)\(\s*(['"])[^'"\n]*[A-Za-z][^'"\n]*\1/
  ];
  const violations = [];
  for (const file of sourceFiles(clientRoot)) {
    const relative = path.relative(clientRoot, file).replaceAll('\\', '/');
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!literalPatterns.some(pattern => pattern.test(trimmed))) return;
      if (exceptions.has(`${relative}:${trimmed}`)) return;
      violations.push(`${relative}:${index + 1}: ${trimmed}`);
    });
  }
  assert.deepEqual(violations, [], `Uncatalogued user-facing literals:\n${violations.join('\n')}`);
});

// Any string, template or not, that reads like an English sentence (three or
// more words starting with a capital) belongs in the catalog. Comments, logs
// and internal Error objects are not shown to users.
it('keeps English sentences out of the client code', () => {
  const literal = /(['"`])((?:\\.|(?!\1).)*?)\1/g;
  const sentence = /^[A-Z][a-z']*(?: [A-Za-z'.,:()\/-]+){2,}/;
  const violations = [];
  for (const file of sourceFiles(clientRoot)) {
    const relative = path.relative(clientRoot, file).replaceAll('\\', '/');
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(trimmed) || /console\.|utils\.log\(|new Error\(/.test(trimmed)) return;
      for (const match of trimmed.matchAll(literal)) {
        const text = match[2].replace(/\$\{[^}]*\}/g, '');
        if (sentence.test(text)) violations.push(`${relative}:${index + 1}: ${text}`);
      }
    });
  }
  assert.deepEqual(violations, [], `English sentences outside the catalog:\n${violations.join('\n')}`);
});
