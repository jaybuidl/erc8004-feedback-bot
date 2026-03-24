module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: require('path').resolve(__dirname, 'tsconfig.json'),
  },
  plugins: [
    '@typescript-eslint',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }], // console.warn and console.error allowed
    'curly': ['error', 'all'],
    'eqeqeq': ['error', 'always'],
    'no-throw-literal': 'error',
    '@typescript-eslint/prefer-const': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
  ],
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off', // Test files can have unused vars for clarity
      },
    },
  ],
};