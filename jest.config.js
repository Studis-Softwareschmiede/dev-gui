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

  // Module name mapper: silence CSS imports; redirect xterm to manual stubs
  moduleNameMapper: {
    '\\.css$':             '<rootDir>/test/__mocks__/styleMock.js',
    '^@xterm/xterm$':      '<rootDir>/test/__mocks__/@xterm/xterm.js',
    '^@xterm/addon-fit$':  '<rootDir>/test/__mocks__/@xterm/addon-fit.js',
  },
};

export default config;
