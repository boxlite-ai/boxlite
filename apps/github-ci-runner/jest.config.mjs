import { fileURLToPath } from 'node:url'

export default {
  displayName: 'github-ci-runner',
  preset: '../jest.preset.js',
  testEnvironment: 'node',
  transform: { '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleFileExtensions: ['ts', 'js'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text-summary', ['lcov', { projectRoot: fileURLToPath(new URL('../..', import.meta.url)) }]],
  coverageDirectory: '../../target/coverage/github-ci-runner',
}
