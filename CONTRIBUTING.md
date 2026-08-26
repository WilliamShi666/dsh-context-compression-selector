# Contributing

Thank you for helping improve this community plugin.

1. Open an issue before large behavior or compatibility changes.
2. Keep every production change inside this repository; do not require a DeepSeek Harness core patch.
3. Add a failing regression first for compression, surface/recovery, preset, tokenizer, or cache-prefix behavior.
4. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm typecheck
   pnpm build
   pnpm verify:release
   pnpm pack:dry-run
   ```

5. Never commit API keys, `.env` files, real Session logs, prompts/tool results, user paths, generated tarballs, or NPM tokens.

Pull requests should explain the evidence for “triggered”, “enabled but skipped”, and fail-open behavior separately. A code path existing is not runtime proof. Changes to tokenizer/model compatibility require an official source, pinned revision, license, byte length, SHA-256, and negative tests.
