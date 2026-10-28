// Plain JavaScript rather than jest.config.ts: on Node 20 Jest can read a TypeScript config only
// through ts-node, which is not a dependency.

/**
 * ts-jest transform shared by both projects. No ts-jest `isolatedModules` option is passed:
 * `tsconfig.json` sets `compilerOptions.isolatedModules`, so ts-jest transpiles each file without
 * a semantic type check and `npm run typecheck` is the type gate for sources and tests.
 *
 * @type {import('jest').Config['transform']}
 */
const tsJestTransform = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
};

/**
 * Two projects, selected by `displayName` from the npm scripts: `jest --selectProjects unit` and
 * `jest --selectProjects integration --runInBand`. Only `*.test.ts` files under `tests/unit` and
 * `tests/integration` are collected, so the test helpers, the integration global setup and the
 * Playwright `tests/e2e` and `tests/perf` specs never run under Jest.
 *
 * Coverage (`npx jest --coverage`) is informational and has no threshold.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
  coverageDirectory: '<rootDir>/coverage',
  // The integration project's 30-second limit, set here because jest-circus 30 reads
  // `testTimeout` from the top-level configuration only and ignores it inside a project entry,
  // where it would leave the 5-second default in force. Integration cases that hash or check
  // credentials use real cost-12 bcrypt. Unit tests finish in milliseconds, so the shared limit
  // changes nothing for them.
  testTimeout: 30000,
  projects: [
    {
      displayName: 'unit',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
    },
    {
      displayName: 'integration',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
      // Guards the `_test` database name and applies the migrations once before any suite. Jest
      // runs it only when integration tests are selected, so unit runs need no database.
      globalSetup: '<rootDir>/tests/integration/global-setup.ts',
    },
  ],
};
