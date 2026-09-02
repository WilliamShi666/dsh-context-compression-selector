# Third-party notices

Portions of this package are adapted from the MIT-licensed DeepSeek Harness, verified against `dsh-v0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`).

## DeepSeek Harness MIT notice

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

This package also distributes `tokenizer.json` and `tokenizer_config.json` from these pinned official repositories, both under the MIT license:

- `deepseek-ai/DeepSeek-V4-Pro` revision `0e1a0e5e52aea73055f50fef6f2423db370265b6` (serves `deepseek-v4-flash` and `deepseek-v4-pro`), in `assets/deepseek-v4/`.
- `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp` revision `6821d6ad3681a4b137b066b76094fa82ebd0a380` (serves `deepseek-v4-flash-vision-exp`), in `assets/deepseek-v4-vision-exp/`. This tokenizer is a distinct artifact, not an alias of the V4 Pro tokenizer.

The exact provenance and SHA-256 values are in each directory's `manifest.json`; the upstream license text ships beside the assets. The vision image-token arithmetic is a port of the repository's `inference/image_processor.py` at the same pinned revision.

The runtime depends on `@huggingface/tokenizers` 0.1.3 under Apache-2.0. Its NPM package carries the dependency license text.

This is an unofficial community package and is not endorsed by DeepSeek.
