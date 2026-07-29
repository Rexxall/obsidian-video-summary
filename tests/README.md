# Pure logic tests

These tests use Node's built-in test runner and do not load Obsidian. The
runner bundles each TypeScript test in an isolated temporary directory, so the
same command works with the plugin's extensionless imports and leaves no
generated files in the repository.

```bash
npm test
```

The command first applies the same strict TypeScript checks as the plugin, then
runs every `tests/*.test.ts` and `tests/*.test.mjs` file. Obsidian is excluded
because the tested modules only use its types.
