// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import baseConfig from '@gctp/config/eslint';

export default [
  ...baseConfig,
  {
    rules: {
      // Nest uses param-property decorators that look like unused parameters.
      '@typescript-eslint/no-unused-vars': 'off',
      // Decorators legitimately rely on side-effectful imports.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Nest's emitDecoratorMetadata requires value imports for classes used in
      // constructor types (DI). consistent-type-imports would silently strip them.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
