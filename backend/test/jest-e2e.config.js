/**
 * @type {import('jest').Config}
 * Jest configuration for integration suites. Kept as JavaScript because Jest
 * reads this file directly; the JSON variant cannot carry a config comment.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30000,
  /**
   * MODULE 09 made suite order matter: whether BUY orders draw from LP
   * commitments depends on global `liquidity_providers` rows, which every
   * suite can see. The USDT and Liquidity suites each reset Module 09's tables
   * in `beforeAll` and purge their own rows in `afterAll`, which is only a
   * complete isolation story when exactly one suite runs at a time - so e2e
   * files run serially. Unit tests still run in parallel.
   */
  maxWorkers: 1,
};