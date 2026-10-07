module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'chore',
        'build',
        'ci',
        'revert',
        'hotfix',
      ],
    ],
    'subject-max-length': [2, 'always', 50],
    'scope-case': [2, 'always', 'lower-case'],
    'type-case': [2, 'always', 'lower-case'],
    'scope-empty': [0, 'always'],
  },
};
