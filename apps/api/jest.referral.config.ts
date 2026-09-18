/** @jest-config-loader-options {"compilerOptions":{"module":"CommonJS","allowImportingTsExtensions":true}} */
import config from './jest.config.ts'

export default {
  ...config,
  displayName: 'boxlite-referral-integration',
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: [
    '<rootDir>/src/organization-referral/*.integration.spec.ts',
    '<rootDir>/src/organization-referral/*.acceptance.spec.ts',
  ],
}
