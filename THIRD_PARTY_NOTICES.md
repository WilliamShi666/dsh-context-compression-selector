# Third-party notices

This community project contains code adapted from the MIT-licensed [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), verified against tag `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

The runtime package distributes tokenizer assets from these pinned official repositories, both under the MIT license:

- [deepseek-ai/DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) at revision `0e1a0e5e52aea73055f50fef6f2423db370265b6`, recorded in `packages/runtime/assets/deepseek-v4/manifest.json`.
- [deepseek-ai/DeepSeek-V4-Flash-Vision-Exp](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp) at revision `6821d6ad3681a4b137b066b76094fa82ebd0a380`, recorded in `packages/runtime/assets/deepseek-v4-vision-exp/manifest.json`. The vision model is served by this distinct tokenizer, never as an alias of the text tokenizer.

Exact file sizes and SHA-256 values are recorded in each directory's `manifest.json`; the upstream license text ships beside the assets.

The install-time production dependency closure also contains `@huggingface/tokenizers` (Apache-2.0), `js-yaml` (MIT), and its `argparse` dependency (Python-2.0). Each dependency ships its own license text in its NPM package.

The names DeepSeek and DeepSeek Harness identify upstream projects only. They do not imply affiliation or endorsement.
