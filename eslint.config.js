import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Client-side JS/JSX files (browser globals)
    files: ['client/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        globalThis: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // React JSX files (client/)
    files: ['client/**/*.jsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        ResizeObserver: 'readonly',
        globalThis: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // JSX usage of imported components/values isn't tracked without eslint-plugin-react.
      // Suppress false positives for PascalCase names (React components) and
      // lowercase names used in JSX expressions.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z]' }],
      'no-console': 'off',
      // Register react-hooks/exhaustive-deps as warn so disable-comments in JSX files are valid.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Test files may use Jest globals
    files: ['test/**/*.js', 'client/src/__tests__/**/*.jsx'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
        // Node.js global object (used for fetch-mocking in tests)
        global: 'readonly',
        // jsdom browser globals used in frontend tests
        window: 'readonly',
        document: 'readonly',
        HashChangeEvent: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'build/', 'coverage/', 'client/dist/', '.claude/worktrees/', 'test/.tmp-*/'],
  },
];
