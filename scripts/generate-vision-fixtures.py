#!/usr/bin/env python3
"""Regenerate the DeepSeek V4 Flash Vision image-token golden fixture.

Downloads the official ``inference/image_processor.py`` and ``config.json`` from
the pinned immutable revision of ``deepseek-ai/DeepSeek-V4-Flash-Vision-Exp``,
runs the official pipeline over synthetic images of many sizes and aspect
ratios, and records the token counts the Node runtime must reproduce exactly.

Every number in the fixture is produced by the official implementation; this
script never re-implements the arithmetic.

Usage:
    python3 scripts/generate-vision-fixtures.py [--workdir DIR]

Requires: pip install torch pillow
Output:   packages/runtime/tests/fixtures/vision-golden.json
"""

import argparse
import io
import json
import math
import pathlib
import sys
import types
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "packages/runtime/tests/fixtures/vision-golden.json"
REVISION = "6821d6ad3681a4b137b066b76094fa82ebd0a380"
BASE = f"https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp/resolve/{REVISION}"

# (width, height) cases: squares, portrait/landscape, min-pixel upscale,
# the 8:1 aspect clamp in both orientations, the 384-token cap, and sizes
# around the patch grid boundaries.
SINGLE_SIZES = [
    (14, 14),
    (28, 14),
    (56, 56),
    (100, 100),
    (224, 224),
    (240, 180),
    (180, 240),
    (384, 384),
    (512, 384),
    (640, 480),
    (800, 600),
    (1024, 768),
    (768, 1024),
    (1280, 960),
    (1600, 1200),
    (2048, 1536),
    (2000, 2000),
    (4096, 4096),
    (8, 8),
    (4, 400),
    (400, 4),
    (64, 512),
    (1152, 128),
    (1024, 119),
    (4200, 100),
    (100, 4200),
    (147, 147),
    (1414, 1414),
]

# start positions exercising every compress-pad alignment and several
# multi-image accumulated offsets.
START_POSITIONS = [0, 1, 2, 3, 4, 5, 7, 8, 17, 64, 101, 383, 384, 766, 767]


def png_bytes(width: int, height: int) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (width, height), (127, 127, 127))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def official_module(workdir: pathlib.Path) -> types.ModuleType:
    source_path = workdir / "image_processor.py"
    urllib.request.urlretrieve(f"{BASE}/inference/image_processor.py", source_path)
    config_path = workdir / "config.json"
    urllib.request.urlretrieve(f"{BASE}/config.json", config_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))

    sys.path.insert(0, str(workdir))
    import image_processor  # noqa: PLC0415  (official module, downloaded on demand)

    args = types.SimpleNamespace(
        vision_patch_size=config["vision_patch_size"],
        vision_downsample_ratio=config["vision_downsample_ratio"],
        vision_max_n_token=config["vision_max_n_token"],
        vision_min_pixels=config["vision_min_pixels"],
        vision_max_wh_ratio=config["vision_max_wh_ratio"],
        vocab_size=0,
    )
    return image_processor, args


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", default="/tmp/dsvision-fixture-work")
    options = parser.parse_args()
    workdir = pathlib.Path(options.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    official, args = official_module(workdir)

    single = []
    for width, height in SINGLE_SIZES:
        patches, n_vit_h, n_vit_w, n_llm_h, n_llm_w = official.load_image(
            {"data": png_bytes(width, height)}, args
        )
        assert tuple(patches.shape) == (n_vit_h * n_vit_w, 3, args.vision_patch_size, args.vision_patch_size)
        single.append(
            {
                "width": width,
                "height": height,
                "startTokenPos": 0,
                "nLlmH": n_llm_h,
                "nLlmW": n_llm_w,
                "tokensAtStart0": 0,
            }
        )

    # Official token totals depend on the running position; use one canonical
    # size and sweep start positions through build_image_block directly.
    canonical_width, canonical_height = 640, 480
    _, _, _, n_llm_h, n_llm_w = official.load_image(
        {"data": png_bytes(canonical_width, canonical_height)}, args
    )
    positions = []
    for start in START_POSITIONS:
        types_tensor, _perm = official.build_image_block(n_llm_h, n_llm_w, start)
        positions.append(
            {
                "width": canonical_width,
                "height": canonical_height,
                "startTokenPos": start,
                "nLlmH": n_llm_h,
                "nLlmW": n_llm_w,
                "tokens": int(types_tensor.numel()),
            }
        )

    # Multi-image sequences mirror prepare_vl_inputs: each image starts at the
    # running position accumulated from every earlier image's expanded block.
    sequences = []
    for sizes in [
        [(640, 480), (800, 600), (1024, 768)],
        [(2048, 1536), (147, 147), (4096, 4096)],
        [(64, 512), (1152, 128), (4200, 100), (100, 4200)],
    ]:
        position = 3  # a small text prefix keeps this off the trivial 0 case
        entries = []
        for width, height in sizes:
            _, _, _, grid_h, grid_w = official.load_image({"data": png_bytes(width, height)}, args)
            types_tensor, _perm = official.build_image_block(grid_h, grid_w, position)
            tokens = int(types_tensor.numel())
            entries.append(
                {
                    "width": width,
                    "height": height,
                    "startTokenPos": position,
                    "nLlmH": grid_h,
                    "nLlmW": grid_w,
                    "tokens": tokens,
                }
            )
            position += tokens
        sequences.append({"entries": entries})

    # Token totals for every single size, each measured at its own start
    # position sweep? Keep single sizes at a representative position instead:
    # recompute each at a fixed non-zero start for a second data point.
    for entry, (width, height) in zip(single, SINGLE_SIZES):
        types_tensor, _perm = official.build_image_block(entry["nLlmH"], entry["nLlmW"], 0)
        entry["tokensAtStart0"] = int(types_tensor.numel())

    fixture = {
        "source": {
            "repository": "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
            "revision": REVISION,
            "files": ["inference/image_processor.py", "config.json"],
        },
        "parameters": {
            "visionPatchSize": args.vision_patch_size,
            "visionDownsampleRatio": args.vision_downsample_ratio,
            "visionMaxNTokens": args.vision_max_n_token,
            "visionMinPixels": args.vision_min_pixels,
            "visionMaxWhRatio": args.vision_max_wh_ratio,
        },
        "singleImages": single,
        "startPositions": positions,
        "sequences": sequences,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUTPUT}: {len(single)} sizes, {len(positions)} start positions, "
        f"{len(sequences)} multi-image sequences"
    )


if __name__ == "__main__":
    main()
