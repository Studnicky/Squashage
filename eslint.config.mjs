import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Minimal parser that accepts any content without errors.
// Used to silence ESLint warnings on non-code files (JSON, CSS, etc.)
// when litany --changed passes them to ESLint via git status --porcelain.
const noopParser = {
  parseForESLint: () => ({
    ast: {
      type: 'Program', body: [], sourceType: 'module',
      range: [0, 0],
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      tokens: [], comments: []
    },
    visitorKeys: { Program: [] },
    scopeManager: null,
    services: {}
  })
};

const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const CODE_FILES = [...TS_FILES, '**/*.js', '**/*.mjs', '**/*.cjs'];
const NOOP_FILES = ['**/*.json', '**/*.md', '**/*.css', '**/*.html', '**/*.yml', '**/*.yaml'];

export default [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/']
  },
  // No-op entries for non-code files so litany --changed does not fail.
  // git status --porcelain includes all modified files; eslint must not
  // error or warn when passed json/css/md/yml paths.
  {
    files: NOOP_FILES,
    languageOptions: { parser: noopParser },
    rules: {}
  },
  {
    files: CODE_FILES,
    ...js.configs.recommended
  },
  // Scope tseslint configs to TS files only to prevent them applying to json.
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: config.files ?? TS_FILES
  })),
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
    }
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/rdf/**', 'src/shacl/**', 'src/viz/vendor/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'n3',                 message: 'Use src/rdf/Serializer.ts or src/rdf/Parser.ts' },
          { name: 'jsonld',             message: 'Use src/rdf/Serializer.ts or src/rdf/Parser.ts' },
          { name: 'rdf-canonize',       message: 'Use src/rdf/Canonicalize.ts' },
          { name: 'rdf-validate-shacl', message: 'Use src/shacl/ShaclGate.ts' },
          { name: '@rdfjs/data-model',  message: 'Use src/rdf/DataFactory.ts' },
          { name: '@rdfjs/dataset',     message: 'Use src/rdf/Dataset.ts' },
          { name: '@rdfjs/namespace',   message: 'Use src/rdf/Namespaces.ts or src/rdf/Vocab.ts' },
        ],
        patterns: [{ group: ['@semantics/*'], message: 'v1.x only — application code stays behind src/rdf/* wrappers' }],
      }],
    },
  },
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
  },
];
