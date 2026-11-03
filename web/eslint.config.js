import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // R2: không im lặng khi lỗi.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Lõi mô phỏng phải chạy được bằng Node, không DOM, không three/react (R3).
    files: ['src/sim/**/*.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'three', message: 'R3: src/sim/ không được import three.' },
            { name: 'react', message: 'R3: src/sim/ không được import react.' },
            { name: 'react-dom', message: 'R3: src/sim/ không được import react-dom.' },
            { name: 'zustand', message: 'R3: src/sim/ không được import zustand.' },
          ],
          patterns: [
            { group: ['three/*', 'react/*', 'react-dom/*', 'zustand/*'], message: 'R3: src/sim/ phải thuần dữ liệu.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'R3: src/sim/ không dùng DOM.' },
        { name: 'document', message: 'R3: src/sim/ không dùng DOM.' },
        { name: 'performance', message: 'R3: src/sim/ không dùng performance.now.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'R3: dùng RNG mulberry32 có seed.' },
        { object: 'Date', property: 'now', message: 'R3: sim/ không đọc đồng hồ hệ thống.' },
      ],
    },
  },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
);
