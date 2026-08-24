const globals = require('globals');

const rules = {
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-unused-vars': ['warn', {
    args: 'after-used',
    caughtErrors: 'none',
    varsIgnorePattern: '^_'
  }]
};

module.exports = [
  {
    ignores: ['node_modules/**', 'Web/**']
  },
  {
    files: ['**/*.js'],
    ignores: ['tests/**', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ApiClient: 'readonly'
      }
    },
    rules
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules
  }
];
