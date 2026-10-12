const { Linter } = require('eslint');

const displayProperties = new Set(['textContent', 'innerText', 'innerHTML', 'outerHTML', 'title', 'placeholder', 'ariaLabel', 'alt']);
const displayAttributes = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'alt', 'label']);
const nameOf = node => node?.type === 'Identifier' ? node.name : node?.value;
const callName = node => node.callee.type === 'MemberExpression' ? nameOf(node.callee.property) : nameOf(node.callee);

// Scan the scripts together without flattening their IIFE scopes. Track shared
// OWP exports and preserve original file/line locations for diagnostics.
const findUnlocalizedSources = sources => {
  let nextLine = 1;
  const sections = sources.map(({ filename, source }) => {
    const start = nextLine;
    nextLine += source.split('\n').length + 1;
    return { filename, source, start };
  });
  const location = line => {
    const section = sections.findLast(item => item.start <= line);
    return { filename: section?.filename || 'fixture.js', line: line - (section?.start || 1) + 1 };
  };
  const source = sections.map(section => section.source).join('\n;\n');
  return new Linter().verify(source, [{
  plugins: { localization: { rules: { literals: {
    create(context) {
      const calls = [];
      const sinks = [];
      const exports = new Map();
      const variable = node => {
        for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
          if (scope.set.has(node.name)) return scope.set.get(node.name);
        }
        return null;
      };
      const namespace = (node, seen = new Set()) => {
        if (!node || seen.has(node)) return null;
        seen.add(node);
        if (node.type === 'ChainExpression') return namespace(node.expression, seen);
        if (node.type === 'AssignmentExpression') return namespace(node.left, seen);
        if (node.type === 'LogicalExpression') return namespace(node.left, seen);
        if (node.type === 'Identifier') {
          if (node.name === 'OWP') return 'OWP';
          for (const def of variable(node)?.defs || []) {
            if (def.type === 'Variable') {
              let value = namespace(def.node.init, seen);
              if (value && def.node.id.type === 'ObjectPattern') {
                const property = def.node.id.properties.find(item => item.type === 'Property' && item.value === def.name);
                const key = property && nameOf(property.key);
                value = typeof key === 'string' ? `${value}.${key}` : null;
              }
              if (value) return value;
            }
          }
        }
        if (node.type === 'MemberExpression') {
          const owner = namespace(node.object, seen);
          const key = node.computed ? node.property.value : node.property.name;
          if (owner && typeof key === 'string') return `${owner}.${key}`;
        }
        return null;
      };
      const resolveFunction = (node, seen = new Set()) => {
        if (!node || seen.has(node)) return null;
        seen.add(node);
        if (node.type === 'ChainExpression') return resolveFunction(node.expression, seen);
        if (['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(node.type)) return node;
        const exported = exports.get(namespace(node));
        if (exported) return resolveFunction(exported, seen);
        if (node.type !== 'Identifier') return null;
        for (const def of variable(node)?.defs || []) {
          const result = resolveFunction(def.type === 'FunctionName' ? def.node : def.node.init, seen);
          if (result) return result;
        }
        return null;
      };
      return {
        AssignmentExpression(node) {
          const exported = namespace(node.left);
          if (exported) exports.set(exported, node.right);
          if (node.left.type !== 'MemberExpression' || !displayProperties.has(nameOf(node.left.property))) return;
          const filename = location(node.loc.start.line).filename;
          // Stylesheets and Material icon glyph names are not UI labels.
          if (filename === 'ui/styles.js' && nameOf(node.left.object) === 'style' && nameOf(node.left.property) === 'textContent') return;
          if (filename === 'ui/home.js' && nameOf(node.left.object) === 'icon' && node.right.value === 'groups') return;
          if (filename === 'ui/guest-controls.js'
            && node.left.object.type === 'CallExpression'
            && callName(node.left.object) === 'querySelector'
            && node.left.object.arguments[0]?.value === '.owp-guest-lock-icon'
            && node.right.type === 'ConditionalExpression'
            && node.right.consequent.value === 'hourglass_empty'
            && node.right.alternate.value === 'lock') return;
          sinks.push(node.right);
        },
        CallExpression(node) {
          const filename = location(node.loc.start.line).filename;
          calls.push(node);
          if (node.callee.type === 'MemberExpression' && node.callee.object.name === 'Object'
            && nameOf(node.callee.property) === 'assign') {
            const owner = namespace(node.arguments[0]);
            if (owner) for (const source of node.arguments.slice(1)) {
              if (source.type !== 'ObjectExpression') continue;
              for (const property of source.properties) {
                if (property.type !== 'Property') continue;
                const key = property.computed ? property.key.value : nameOf(property.key);
                if (typeof key === 'string') exports.set(`${owner}.${key}`, property.value);
              }
            }
          }
          const name = callName(node);
          if (['createTextNode', 'showToast', 'confirm', 'alert'].includes(name)) sinks.push(node.arguments[0]);
          if (name === 'createElement' && !(filename === 'ui/cards.js' && node.arguments[1]?.value === 'material-icons' && node.arguments[2]?.value === 'groups')) sinks.push(node.arguments[2]);
          if (name === 'setAttribute' && displayAttributes.has(node.arguments[0]?.value)) sinks.push(node.arguments[1]);
          if (['append', 'prepend', 'replaceChildren'].includes(name)) sinks.push(...node.arguments);
          if (['insertAdjacentHTML', 'insertAdjacentText'].includes(name)) sinks.push(node.arguments[1]);
        },
        'Program:exit'() {
          // An unknown UI helper must not quietly accept a new English label.
          // Known helpers are followed by parameter position, preserving their
          // internal selector/protocol arguments. Translations stay opaque.
          for (const call of calls) {
            if (namespace(call.callee)?.startsWith('OWP.ui.') && !resolveFunction(call.callee)) sinks.push(...call.arguments);
          }
          const seen = new Set();
          const inspect = node => {
            if (!node || seen.has(node)) return;
            seen.add(node);
            if (node.type === 'Literal' && typeof node.value === 'string' && /[A-Za-z]/.test(node.value) && node.value !== 'OpenWatchParty') {
              context.report({ node, message: `Uncatalogued UI literal: ${node.value}` });
            } else if (node.type === 'TemplateLiteral') {
              for (const quasi of node.quasis) {
                if (/[A-Za-z]/.test(quasi.value.cooked || '') && quasi.value.cooked.trim() !== 'ms') context.report({ node: quasi, message: `Uncatalogued UI template: ${quasi.value.cooked}` });
              }
              node.expressions.forEach(inspect);
            } else if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
              inspect(node.left);
              inspect(node.right);
            } else if (node.type === 'ConditionalExpression') {
              inspect(node.consequent);
              inspect(node.alternate);
            } else if (node.type === 'Identifier') {
              for (const def of variable(node)?.defs || []) {
                if (def.type === 'Variable') inspect(def.node.init);
                if (def.type === 'Parameter') {
                  const index = def.node.params.indexOf(def.name);
                  for (const call of calls) {
                    if (resolveFunction(call.callee) === def.node) inspect(call.arguments[index]);
                  }
                }
              }
            }
          };
          sinks.forEach(inspect);
        }
      };
    }
  } } } },
  rules: { 'localization/literals': 'error' }
}]).map(message => {
    const original = location(message.line);
    return `${original.filename}:${original.line}: ${message.message}`;
  });
};

const findUnlocalizedLiterals = (source, filename = 'fixture.js') => findUnlocalizedSources([{ filename, source }]);

module.exports = { findUnlocalizedLiterals, findUnlocalizedSources };
