// Flat ESLint config (ESLint 9+). Install with:
//   npm install --save-dev eslint typescript-eslint eslint-config-prettier
//
// This file is itself loaded as CommonJS by Node's flat-config loader, so
// the two require() calls below are correct, not a violation of the
// no-require-imports rule this config enables for TypeScript source files --
// each is disabled individually (a whole-file line-comment disable directive
// was tried first but isn't recognized the same way a block comment is).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tseslint = require("typescript-eslint");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "conversations/**", "my-export/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Matches the codebase's existing style: unused args prefixed with _
      // are intentional (e.g. destructured but unused), everything else
      // should be a real error, not silently ignored.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Rate-limit/staging code intentionally uses `unknown` for
      // not-yet-typed API fields (e.g. background_entries) rather than
      // `any`, so this stays on to keep that discipline enforced.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  eslintConfigPrettier
);
