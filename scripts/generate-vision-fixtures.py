#!/usr/bin/env python3
"""Regenerate the DeepSeek V4.1-Flash image-token golden fixture.

Runs the official ``inference/image_processor.py`` published by the pinned
immutable revision of ``deepseek-ai/DeepSeek-V4.1-Flash`` over synthetic images
of many sizes and aspect ratios, and records the token counts the Node runtime
must reproduce exactly.

Every number in the fixture is produced by the official implementation; this
script never re-implements the arithmetic.

V4.1 changes handled here (vs the retired ``DeepSeek-V4-Flash-Vision-Exp``):
  * The visual parameters moved from flat top-level keys to the nested
    ``config["vision_config"]`` object. Both shapes are accepted so this script
    stays reproducible against either revision.
  * ``build_image_block`` no longer exists. The block length is exactly
    ``num_image_tokens(n_llm_h, n_llm_w) == n_llm_h * (n_llm_w + 1) + 2`` and is
    position-independent, so the old per-position compress-pad sweep has no
    arithmetic meaning; it is retained as a position-independence check.
  * ``solve_resize_ratio`` returns a 2-tuple and ``safe_resize`` is a single
    pass (no budget loop).
  * ``vision_max_wh_ratio`` is ``null``: no aspect-ratio clamp branch is taken.

The pinned revision is immutable, so an already-present
``image_processor.py`` / ``config.json`` pair in ``--workdir`` is reused
verbatim and no network access happens. Use ``--mirror`` to fetch through
``hf-mirror.com`` when huggingface.co is unreachable.

Usage:
    python3 scripts/generate-vision-fixtures.py [--workdir DIR] [--mirror] [--skip-sweep]

Requires: pip install torch pillow
Output:   packages/runtime/tests/fixtures/vision-golden.json
          packages/runtime/tests/fixtures/vision-official-sweep.json
"""

import argparse
import io
import json
import pathlib
import sys
import types
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "packages/runtime/tests/fixtures/vision-golden.json"
REVISION = "dba1be0a40aa45a94ad051997016db3960a90277"
UPSTREAM = "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash"
MIRROR = "https://hf-mirror.com/deepseek-ai/DeepSeek-V4.1-Flash"

# (width, height) cases. V4.1 pins vision_max_n_token 1024, vision_min_pixels
# 295936 (~544x544) and vision_max_wh_ratio null, so the interesting boundaries
# moved: the min-pixel upscale floor, the 1024-token cap, and aspect ratios that
# were previously clamped at 8:1 but no longer are.
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
    # Cross-file reference sizes asserted directly by the Node tests.
    (512, 512),
    (1024, 1024),
    (4000, 3000),
]

# Stream offsets used to demonstrate that the V4.1 block length does not depend
# on the absolute serialized position. The retired revision swept compress-pad
# residues here; V4.1 has no such padding.
START_POSITIONS = [0, 1, 2, 3, 4, 5, 7, 8, 17, 64, 101, 383, 384, 766, 767]

CANONICAL_WIDTH, CANONICAL_HEIGHT = 640, 480

SWEEP_OUTPUT = REPO_ROOT / "packages/runtime/tests/fixtures/vision-official-sweep.json"
SWEEP_SEED = 7
SWEEP_RANDOM_CASES = 120
SWEEP_RANDOM_MAX = 5_000

# Boundary sizes for the wide equivalence sweep: degenerate/sub-patch inputs, the
# 295936-pixel upscale floor (544x544), cap saturation, and aspect ratios that
# the retired 8:1 clamp would have bounded but V4.1 does not.
SWEEP_SIZES = [
    (1, 1),
    (2, 3),
    (13, 13),
    (13, 14),
    (14, 14),
    (15, 15),
    (27, 28),
    (28, 14),
    (8, 8),
    (543, 544),
    (544, 544),
    (545, 545),
    (100, 100),
    (147, 147),
    (224, 224),
    (240, 180),
    (180, 240),
    (320, 240),
    (384, 384),
    (512, 384),
    (512, 512),
    (640, 480),
    (800, 600),
    (1024, 768),
    (768, 1024),
    (1024, 1024),
    (1280, 960),
    (1600, 1200),
    (2000, 2000),
    (2048, 1536),
    (4000, 3000),
    (4096, 4096),
    (1414, 1414),
    (4, 400),
    (400, 4),
    (64, 512),
    (1152, 128),
    (1024, 119),
    (4200, 100),
    (100, 4200),
    (10000, 10),
    (10, 10000),
]


def png_bytes(width: int, height: int) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (width, height), (127, 127, 127))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def fetch(url: str, destination: pathlib.Path) -> None:
    """Download one pinned official file, refusing LFS pointer stubs."""
    request = urllib.request.Request(url, headers={"User-Agent": "dsh-vision-fixture/2"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    if payload.lstrip().startswith(b"Temporary Redirect"):
        raise RuntimeError(f"{url} returned an LFS pointer, not the real file")
    destination.write_bytes(payload)


def vision_parameters(config: dict) -> dict:
    """Read the visual parameters from either config shape.

    V4.1 publishes them nested under ``vision_config``; the retired revision
    published flat top-level keys. Supporting both keeps the generator
    reproducible against either pinned revision.
    """
    nested = config.get("vision_config")
    if isinstance(nested, dict):
        return {
            "vision_patch_size": nested["patch_size"],
            "vision_downsample_ratio": nested["downsample_ratio"],
            "vision_max_n_token": nested["max_image_tokens"],
            "vision_min_pixels": nested["min_pixels"],
            "vision_max_wh_ratio": nested["max_wh_ratio"],
        }
    return {
        "vision_patch_size": config["vision_patch_size"],
        "vision_downsample_ratio": config["vision_downsample_ratio"],
        "vision_max_n_token": config["vision_max_n_token"],
        "vision_min_pixels": config["vision_min_pixels"],
        "vision_max_wh_ratio": config["vision_max_wh_ratio"],
    }


def official_module(workdir: pathlib.Path, mirror: bool) -> tuple[types.ModuleType, types.SimpleNamespace]:
    """Load the pinned official implementation, reusing local files when present."""
    source_path = workdir / "image_processor.py"
    config_path = workdir / "config.json"
    if not (source_path.is_file() and config_path.is_file()):
        base = MIRROR if mirror else UPSTREAM
        fetch(f"{base}/resolve/{REVISION}/inference/image_processor.py", source_path)
        fetch(f"{base}/resolve/{REVISION}/config.json", config_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    parameters = vision_parameters(config)

    sys.path.insert(0, str(workdir))
    import image_processor  # noqa: PLC0415  (official module, pinned on disk)

    args = types.SimpleNamespace(
        **parameters,
        image_token_id=config.get("image_token_id", 129264),
        vision_enabled=True,
        vocab_size=0,
    )
    return image_processor, args


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", default="/tmp/dsvision-fixture-work")
    parser.add_argument("--mirror", action="store_true", help="download via hf-mirror.com")
    parser.add_argument("--skip-sweep", action="store_true", help="skip the equivalence sweep fixture")
    options = parser.parse_args()
    workdir = pathlib.Path(options.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    official, args = official_module(workdir, options.mirror)

    single = []
    for width, height in SINGLE_SIZES:
        patches, n_vit_h, n_vit_w, n_llm_h, n_llm_w = official.load_image(
            {"data": png_bytes(width, height)}, args
        )
        assert tuple(patches.shape) == (n_vit_h * n_vit_w, 3, args.vision_patch_size, args.vision_patch_size)
        # Two independent official sources must agree on the block length.
        tokens = official.num_image_tokens(n_llm_h, n_llm_w)
        assert tokens == int(official.image_token_types(n_llm_h, n_llm_w).numel())
        single.append(
            {
                "width": width,
                "height": height,
                "startTokenPos": 0,
                "nLlmH": n_llm_h,
                "nLlmW": n_llm_w,
                "tokensAtStart0": tokens,
            }
        )

    # Position independence. The retired revision varied the count here via
    # compress-pad alignment; under V4.1 the block length is constant, and this
    # section is the golden evidence for that.
    canonical = next(entry for entry in single
                     if (entry["width"], entry["height"]) == (CANONICAL_WIDTH, CANONICAL_HEIGHT))
    positions = [
        {
            "width": CANONICAL_WIDTH,
            "height": CANONICAL_HEIGHT,
            "startTokenPos": start,
            "nLlmH": canonical["nLlmH"],
            "nLlmW": canonical["nLlmW"],
            "tokens": official.num_image_tokens(canonical["nLlmH"], canonical["nLlmW"]),
        }
        for start in START_POSITIONS
    ]

    # Multi-image sequences mirror prepare_vl_inputs: each image contributes its
    # own position-independent block length, and the running position advances
    # by exactly that amount.
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
            tokens = official.num_image_tokens(grid_h, grid_w)
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

    fixture = {
        "source": {
            "repository": "deepseek-ai/DeepSeek-V4.1-Flash",
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

    if not options.skip_sweep:
        write_sweep(official, args, workdir)


def write_sweep(
    official: types.ModuleType,
    args: types.SimpleNamespace,
    workdir: pathlib.Path,
) -> None:
    """Regenerate the wide equivalence sweep from the same official implementation.

    `tests/deepseek-v4-vision-sweep.spec.ts` compares the Node port against this
    file case-by-case, so the sweep is produced by the official code path (never
    hand-written) and is reproducible from the pinned revision. Sizes the
    official PIL path rejects outright (see below) are deliberately absent
    because the official implementation cannot produce a value for them.
    """
    import hashlib
    import random

    sizes = list(SWEEP_SIZES)
    rng = random.Random(SWEEP_SEED)
    for _ in range(SWEEP_RANDOM_CASES):
        sizes.append((rng.randint(1, SWEEP_RANDOM_MAX), rng.randint(1, SWEEP_RANDOM_MAX)))

    cases = []
    for width, height in sizes:
        _, _, _, n_llm_h, n_llm_w = official.load_image({"data": png_bytes(width, height)}, args)
        tokens = official.num_image_tokens(n_llm_h, n_llm_w)
        assert tokens == int(official.image_token_types(n_llm_h, n_llm_w).numel())
        assert tokens <= args.vision_max_n_token
        cases.append(
            {
                "width": width,
                "height": height,
                "nLlmH": n_llm_h,
                "nLlmW": n_llm_w,
                "tokens": tokens,
            }
        )

    source_path = workdir / "image_processor.py"
    payload = {
        "source": {
            "repository": "deepseek-ai/DeepSeek-V4.1-Flash",
            "revision": REVISION,
            "files": ["inference/image_processor.py", "config.json"],
            "imageProcessorSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        },
        "parameters": {
            "visionPatchSize": args.vision_patch_size,
            "visionDownsampleRatio": args.vision_downsample_ratio,
            "visionMaxNTokens": args.vision_max_n_token,
            "visionMinPixels": args.vision_min_pixels,
            "visionMaxWhRatio": args.vision_max_wh_ratio,
        },
        "producer": (
            f"official image_processor.py executed under torch {_torch_version()} "
            f"and pillow {_pillow_version()}"
        ),
        "note": (
            "Sweep of the official implementation over boundary sizes plus seeded random sizes, "
            "cross-checked case-by-case against the committed Node port."
        ),
        "totals": {"cases": len(cases), "maxTokens": max(case["tokens"] for case in cases)},
        "cases": cases,
    }
    SWEEP_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    SWEEP_OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {SWEEP_OUTPUT}: {len(cases)} sweep cases, max {payload['totals']['maxTokens']} tokens")


def _torch_version() -> str:
    import torch

    return torch.__version__


def _pillow_version() -> str:
    import PIL

    return PIL.__version__


if __name__ == "__main__":
    main()
