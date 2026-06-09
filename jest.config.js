/** @type {import('jest').Config} */
const config = {
  // Default environment for backend (Node) tests
  testEnvironment: 'node',

  // ESM support
  extensionsToTreatAsEsm: ['.jsx'],
  transform: {
    // Transform JSX files with babel-jest.
    // modules: false keeps ESM imports intact (required by --experimental-vm-modules).
    '^.+\\.jsx$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' }, modules: false }],
        ['@babel/preset-react', { runtime: 'automatic' }],
      ],
    }],
  },

  // Per-file environment override via @jest-environment docblock
  // Frontend test files declare: @jest-environment jsdom

  // Ignore parallel agent worktrees: they live under .claude/worktrees/ and would
  // otherwise be scanned by the global test run, pulling in foreign (possibly red)
  // tests from other branches and corrupting the test gate.
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/worktrees/'],

  // Keep worktree module copies out of the haste map entirely: duplicate src/ copies
  // under .claude/worktrees/ pollute module resolution (duplicate manual mocks) and can
  // poison the shared transform cache (e.g. a file cached as CJS in one worktree, ESM in
  // main → "Cannot use import statement outside a module"). Pairs with testPathIgnorePatterns.
  modulePathIgnorePatterns: ['/\\.claude/worktrees/'],

  // Module name mapper: silence CSS imports; redirect xterm to manual stubs
  moduleNameMapper: {
    '\\.css$':             '<rootDir>/test/__mocks__/styleMock.js',
    '^@xterm/xterm$':      '<rootDir>/test/__mocks__/@xterm/xterm.js',
    '^@xterm/addon-fit$':  '<rootDir>/test/__mocks__/@xterm/addon-fit.js',
  },
};

export default config;
