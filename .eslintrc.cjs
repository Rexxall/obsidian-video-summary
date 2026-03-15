module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  env: { node: true, es2020: true, browser: true },
  ignorePatterns: ['main.js', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off'
  }
};






