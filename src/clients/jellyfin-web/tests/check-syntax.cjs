const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const excludedDirectories = new Set(['node_modules', 'Web']);
let failed = false;

const visit = directory => {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) visit(path.join(directory, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const file = path.join(directory, entry.name);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failed = true;
      process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    }
  }
};

visit(root);
process.exitCode = failed ? 1 : 0;
