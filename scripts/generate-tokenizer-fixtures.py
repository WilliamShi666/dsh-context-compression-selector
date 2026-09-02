#!/usr/bin/env python3
"""Regenerate the tokenizer golden fixture for the Node loader equivalence tests.

Loads each pinned ``tokenizer.json`` shipped in ``packages/runtime/assets`` with
the official Hugging Face ``tokenizers`` Python library (the same Rust core the
``transformers`` tokenizer for these repositories uses) and records the token
counts the Node runtime must reproduce exactly.

Usage:
    python3 scripts/generate-tokenizer-fixtures.py

Requires: pip install tokenizers
Output:   packages/runtime/tests/fixtures/tokenizer-golden.json
"""

import json
import pathlib
import platform

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = {
    "deepseek-ai/DeepSeek-V4-Pro": REPO_ROOT / "packages/runtime/assets/deepseek-v4",
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": REPO_ROOT
    / "packages/runtime/assets/deepseek-v4-vision-exp",
}
OUTPUT = REPO_ROOT / "packages/runtime/tests/fixtures/tokenizer-golden.json"

CASES = [
    ("english prose", "The quick brown fox jumps over the lazy dog."),
    ("simplified chinese", "上下文压缩选择器在长任务中回收工具结果 token。"),
    ("mixed zh-en", "DeepSeek Harness 的 tool result 压缩,Fresh/Aggregate/History 三个阶段。"),
    ("json tool output", '{"status":"ok","items":[{"id":1,"path":"/tmp/a.txt"}],"count":1}'),
    ("python code", "def solve(width: int, height: int) -> int:\n    return width * height // 2\n"),
    ("shell transcript", "$ pnpm run test\n> vitest run\n\n Test Files  12 passed (12)\n"),
    ("unicode whitespace", "line1\nline2\r\nline3\tline4  double  spaces"),
    ("deepseek chat special tokens", "<｜begin▁of▁sentence｜><｜User｜>hello<｜Assistant｜><think>\n"),
    ("vision image placeholder", "before<｜deepseek_image｜>after"),
    ("empty string", ""),
    ("single ascii char", "a"),
    ("emoji", "compression 🧠✅ done"),
]

MANIFEST_REVISIONS = {}
for repository, asset_dir in ASSETS.items():
    manifest = json.loads((asset_dir / "manifest.json").read_text(encoding="utf-8"))
    MANIFEST_REVISIONS[repository] = manifest["revision"]


def main() -> None:
    from tokenizers import Tokenizer

    tokenizers = {}
    for repository, asset_dir in ASSETS.items():
        # Python `tokenizers` loads the fast-tokenizer definition directly from
        # tokenizer.json; tokenizer_config.json only governs transformers-level
        # special-token insertion, which these counts deliberately disable.
        tokenizers[repository] = Tokenizer.from_file(str(asset_dir / "tokenizer.json"))

    cases = []
    for label, text in CASES:
        counts = {}
        for repository, tokenizer in tokenizers.items():
            encoding = tokenizer.encode(text, add_special_tokens=False)
            counts[repository] = len(encoding.ids)
        cases.append({"label": label, "text": text, "counts": counts})

    import tokenizers

    fixture = {
        "generator": f"tokenizers {tokenizers.__version__} on {platform.system()}",
        "revision": "1",
        "tokenizers": {repository: MANIFEST_REVISIONS[repository] for repository in sorted(ASSETS)},
        "cases": cases,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT} with {len(cases)} cases")


if __name__ == "__main__":
    main()
