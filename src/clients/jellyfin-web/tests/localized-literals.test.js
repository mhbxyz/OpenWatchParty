const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const { findUnlocalizedLiterals, findUnlocalizedSources } = require('./localization-check');

const clientRoot = path.join(__dirname, '..');

it('detects short labels, multiline calls and local DOM wrappers', () => {
  const fixtures = [
    "createElement('button', 'join', 'Join');",
    "document.createTextNode('Online');",
    "button.setAttribute(\n 'title',\n 'Close panel'\n);",
    "button['placeholder'] = 'Search';",
    "button.textContent = `Join ${name}`;",
    "button.textContent = ready ? 'Online' : t('offline');",
    "const label = 'Join'; button.textContent = label;",
    "function label(el, text) { el.textContent = text; } label(button, 'Join');",
    "const label = text => document.createTextNode(text); const alias = label; alias('Online');",
    "function label(text) { return createElement('span', '', text); } label('Join');",
    "button.append('Join');"
  ];
  for (const source of fixtures) assert.equal(findUnlocalizedLiterals(source).length, 1, source);
});

it('detects short labels in HTML-writing sinks', () => {
  for (const source of [
    "el.innerHTML = 'Join';", "el.outerHTML = '<span>Online</span>';",
    "el.insertAdjacentHTML('beforeend', 'Online');",
    "el.insertAdjacentText('beforeend', 'Join');",
    "const label = 'Online'; el.innerHTML = label;"
  ]) assert.equal(findUnlocalizedLiterals(source).length, 1, source);
  assert.deepEqual(findUnlocalizedLiterals("el.innerHTML = t('join'); el.insertAdjacentText('beforeend', t('online'));"), []);
});

it('tracks labels through helpers in other files and reports the call site', () => {
  for (const [helper, call] of [
    ["function makeBtn(text) { el.textContent = text; }", "makeBtn('Join');"],
    ["(() => { const OWP = window.OpenWatchParty; const ui = OWP.ui; ui.announce = text => { el.textContent = text; }; })();", "(() => { const OWP = window.OpenWatchParty; OWP.ui.announce('Online'); })();"],
    ["OWP.ui.announce = text => { el.textContent = text; }; OWP.ui.forward = text => OWP.ui.announce(text);", "const label = 'Join'; OWP.ui.forward(label);"],
    ["OWP.ui.announce = text => { el.textContent = text; };", "const announce = OWP.ui.announce; announce('Join');"]
  ]) {
    const violations = findUnlocalizedSources([
      { filename: 'helper.js', source: helper }, { filename: 'caller.js', source: call }
    ]);
    assert.equal(violations.length, 1, call);
    assert.match(violations[0], /^caller\.js:1: Uncatalogued UI literal:/);
  }
  assert.deepEqual(findUnlocalizedSources([
    { filename: 'helper.js', source: "OWP.ui.announce = text => { el.textContent = text; }; OWP.ui.button = (selector, text) => { document.querySelector(selector).textContent = text; }; OWP.ws.send = type => socket.send(type);" },
    { filename: 'caller.js', source: "OWP.ui.announce(t('join')); OWP.ui.button('.join-button', t('join')); OWP.ws.send('ping'); console.log('Online');" }
  ]), []);
});

it('rejects unresolved UI namespace labels instead of silently passing them', () => {
  assert.equal(findUnlocalizedLiterals("OWP.ui.announce('Join');").length, 1);
  assert.deepEqual(findUnlocalizedLiterals("OWP.ui.announce(t('join'));"), []);
});

it('allows translations and internal values without hiding ordinary labels', () => {
  const source = `
    button.textContent = t('join');
    button.setAttribute('title', OWP.i18n.t('closePanel'));
    document.createElement('button');
    button.setAttribute('class', 'Online');
    console.log('Join');
    button.textContent = user.name;
    button.textContent = 'OpenWatchParty';
  `;
  assert.deepEqual(findUnlocalizedLiterals(source), []);
  assert.equal(findUnlocalizedLiterals("button.textContent = 'groups';", 'ui/home.js').length, 1);
  assert.deepEqual(findUnlocalizedLiterals("icon.textContent = 'groups';", 'ui/home.js'), []);
  assert.equal(findUnlocalizedLiterals('button.textContent = `Close panel`;', 'ui/styles.js').length, 1);
  assert.equal(findUnlocalizedLiterals('button.textContent = ;').length, 1, 'parse failures must fail the guard');
});

const sourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.name === 'node_modules' || entry.name === 'tests') return [];
  if (entry.isDirectory()) return sourceFiles(absolute);
  if (!entry.name.endsWith('.js') || absolute.endsWith(path.join('utils', 'i18n.js'))) return [];
  return [absolute];
});

const clientSources = () => sourceFiles(clientRoot).map(file => ({
  filename: path.relative(clientRoot, file).replaceAll('\\', '/'),
  source: fs.readFileSync(file, 'utf8')
}));

it('keeps user-facing English literals in the localization catalog', () => {
  const violations = findUnlocalizedSources(clientSources());
  assert.deepEqual(violations, [], `Uncatalogued user-facing literals:\n${violations.join('\n')}`);
});

it('makes the full client guard reject injected HTML and cross-file labels', () => {
  const violations = findUnlocalizedSources([...clientSources(),
    { filename: 'probe-caller.js', source: "el.innerHTML = 'Join';\nOWP.ui.guardProbe('Online');" },
    { filename: 'probe-helper.js', source: "(() => { const OWP = window.OpenWatchParty; OWP.ui.guardProbe = text => document.createTextNode(text); })();" }
  ]);
  assert.deepEqual(violations, [
    'probe-caller.js:1: Uncatalogued UI literal: Join',
    'probe-caller.js:2: Uncatalogued UI literal: Online'
  ]);
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


it('follows destructured private view exports without treating selectors as labels', () => {
  const helper = "(() => { const OWP = window.OpenWatchParty; const ui = OWP.ui; const views = ui._panelViews = ui._panelViews || {}; const button = (selector, text) => { document.querySelector(selector).textContent = text; }; Object.assign(views, { button }); })();";
  const caller = text => "(() => { const OWP = window.OpenWatchParty; const ui = OWP.ui; const views = ui._panelViews; const { button: makeButton } = views; makeButton('.join-button', " + text + "); })();";
  assert.deepEqual(findUnlocalizedSources([
    { filename: 'helper.js', source: helper },
    { filename: 'caller.js', source: caller("t('join')") }
  ]), []);
  assert.deepEqual(findUnlocalizedSources([
    { filename: 'helper.js', source: helper },
    { filename: 'caller.js', source: caller("'Join'") }
  ]), ['caller.js:1: Uncatalogued UI literal: Join']);
  assert.equal(findUnlocalizedLiterals("const { announce } = OWP.ui; announce('Join');").length, 1);
});

it('rejects a raw label injected into an extracted production view', () => {
  const sources = clientSources();
  const view = sources.find(source => source.filename === 'ui/leave-confirm.js');
  assert.ok(view.source.includes("t('cancel')"));
  view.source = view.source.replace("t('cancel')", "'Cancel'");
  const violations = findUnlocalizedSources(sources);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^ui\/leave-confirm\.js:\d+: Uncatalogued UI literal: Cancel$/);
});
