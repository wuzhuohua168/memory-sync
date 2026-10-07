module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  extends: ['eslint:recommended'],
  ignorePatterns: ['node_modules/', '.wrangler/', 'docs/'],
  rules: {
    // 生产代码禁止 console / debugger
    'no-console': 'warn',
    'no-debugger': 'error',

    // 代码风格
    semi: ['error', 'always'],
    quotes: ['error', 'single', { avoidEscape: true }],
    indent: ['error', 2, { SwitchCase: 1 }],
    'no-unused-vars': 'warn',
    'no-trailing-spaces': 'error',
    'no-multiple-empty-lines': ['error', { max: 2 }],
    'eol-last': 'error',
    'no-tabs': 'error',

    // 代码质量
    eqeqeq: ['error', 'always'],
    'no-var': 'error',
    'prefer-const': 'error',
    'no-eval': 'error',
    'no-new-func': 'error',
    'no-implicit-coercion': 'error',

    // 安全
    'no-restricted-globals': ['error', 'alert', 'confirm', 'prompt'],
  },
};
