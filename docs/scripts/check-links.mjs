import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { load } from 'cheerio';

const output = resolve('dist');
const base = (process.env.SITE_BASE ?? '/OpenWatchParty').replace(/\/$/, '');
const failures = new Set();
const pages = new Map();

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      const document = load(html);
      const ids = new Set(document('[id]').map((_, node) => document(node).attr('id')).get());
      pages.set(path, { document, ids, html });
    }
  }
}

async function targetFile(pathname) {
  const relative = pathname.slice(base.length).replace(/^\//, '');
  const candidate = resolve(output, relative);
  if (candidate !== output && !candidate.startsWith(output + '/')) return;
  try {
    return (await stat(candidate)).isDirectory() ? join(candidate, 'index.html') : candidate;
  } catch { return; }
}

await walk(output);
let checked = 0;
for (const [file, { document, html }] of pages) {
  const route = file.slice(output.length).replace(/index\.html$/, '');
  const current = new URL(base + route, 'https://site.invalid');
  if (/\|\s*relative_url|\{%\s*(include|raw)/.test(html)) failures.add(`${route}: unconverted Jekyll markup`);
  const references = document('[href], [src], [poster]').toArray().flatMap(node =>
    ['href', 'src', 'poster'].map(attribute => document(node).attr(attribute)).filter(Boolean));
  for (const reference of references) {
    // Absolute URLs are deliberate external references, including release links.
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) continue;
    const url = new URL(reference, current);
    if (base && url.pathname !== base && !url.pathname.startsWith(base + '/')) {
      failures.add(`${route}: link escapes deployment base: ${reference}`);
      continue;
    }
    const target = await targetFile(decodeURIComponent(url.pathname));
    if (!target) failures.add(`${route}: missing target: ${reference}`);
    else if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) {
      failures.add(`${route}: missing heading: ${reference}`);
    }
    checked += 1;
  }
}

for (const route of JSON.parse(await readFile(new URL('./legacy-routes.json', import.meta.url), 'utf8'))) {
  if (!pages.has(join(output, route, 'index.html'))) failures.add(`Missing existing public route: ${route}`);
}
for (const path of ['/jellyfin-plugin-repo/manifest.json', '/assets/video/watch-party-host.mp4', '/assets/video/watch-party-guest.mp4', '/pagefind/pagefind.js']) {
  if (!await targetFile(base + path)) failures.add(`Missing required public asset: ${path}`);
}

if (failures.size) {
  console.error([...failures].join('\n'));
  console.error(`${failures.size} broken site references.`);
  process.exitCode = 1;
} else console.log(`Verified ${pages.size} pages and ${checked} local references; existing URLs, recordings, plugin manifest and search index are present.`);
