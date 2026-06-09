import baseConfig from '../../eslint.config.mjs'

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Decorator[expression.callee.name="InjectRepository"] > CallExpression > Identifier[name="Box"]',
          message: 'Do not use @InjectRepository(Box). Use the custom BoxRepository instead.',
        },
      ],
    },
  },
]
