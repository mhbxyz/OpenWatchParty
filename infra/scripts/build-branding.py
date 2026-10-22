#!/usr/bin/env python3
"""Rebuild the transparent branding assets from the master artwork.

Outputs:
    docs/public/readme-logo.png   README hero image (1360x800)
    docs/public/app-icon.png      application icon (350x350)

Sources:
    assets/branding/source-logo-monitor.png   master artwork used here
    assets/branding/source-logo-circular.png  alternative design, unused

Why this script exists
----------------------
The master artwork is drawn on an opaque white background.  Cutting the white
out with a threshold (or a "remove white background" tool) leaves the
anti-aliased blend pixels opaque: a light fringe along every edge, very
visible on dark themes, and stair-stepped outlines.  It also cannot tell
white design elements (bubble dots, monitor bezel, ring nodes) from the
background, so those have to be preserved deliberately.

Pipeline
--------
1. classify every pixel of a piece:
     - background: near-white pixels connected to the border (flood fill),
       removed;
     - design white: every other near-white pixel, kept fully opaque;
     - interior: everything further than the boundary band from the
       background, kept fully opaque with its original colour;
     - boundary: the remaining anti-aliasing band;
2. propagate the nearest interior colour into the boundary band (colour
   bleed) so blend pixels keep the colour of the shape they belong to;
3. alpha per boundary pixel is 1 - t with t = (w - w_fg) / (1 - w_fg), where
   w is the pixel whiteness and w_fg the whiteness of the bled colour; a
   near-white bled colour makes that unmix degenerate, so those pixels fall
   back to their own whiteness;
4. text pieces (the wordmark) use the same unmix with a stricter rule: near
   whites are background and the core is the dark pixels eroded by one
   pixel, which keeps glyph counters transparent;
5. recompose the README canvas and write both PNGs.

Compositing the result back onto white reproduces the master artwork while
the boundary pixels keep their real coverage, so the edges stay clean on any
background.

Usage:
    infra/scripts/build-branding.py            regenerate the assets
    infra/scripts/build-branding.py --check    verify the assets are up to date
"""

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - depends on the environment
    sys.exit(f"error: {exc.name} is required; install numpy and Pillow")

ROOT = Path(__file__).resolve().parents[2]

SOURCE = ROOT / "assets" / "branding" / "source-logo-monitor.png"
README_LOGO = ROOT / "docs" / "public" / "readme-logo.png"
APP_ICON = ROOT / "docs" / "public" / "app-icon.png"

# Geometry of the master artwork, in source pixels (left, top, right, bottom).
ILLUSTRATION_BOX = (95, 180, 1000, 685)
TEXT_BOX = (90, 718, 1362, 927)
ICON_BOX = (1038, 268, 1388, 618)

# README canvas and placement of the two pieces on it.
README_CANVAS = (1360, 800)
ILLUSTRATION_AT = (215, 30)
TEXT_AT = (45, 558)

# Near-white threshold, boundary band width and bleed reach, in pixels.
WHITE = 0.90
BAND = 2
BLEED_RADIUS = 6


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Grow a boolean mask by ``radius`` pixels (4-connectivity)."""
    if radius <= 0:
        return mask.copy()
    padded = np.pad(mask, radius, mode="constant", constant_values=False)
    current = padded
    for _ in range(radius):
        grown = current.copy()
        grown[1:, :] |= current[:-1, :]
        grown[:-1, :] |= current[1:, :]
        grown[:, 1:] |= current[:, :-1]
        grown[:, :-1] |= current[:, 1:]
        current = grown
    return current[radius:-radius, radius:-radius]


def erode(mask: np.ndarray, radius: int) -> np.ndarray:
    """Shrink a boolean mask by ``radius`` pixels (4-connectivity)."""
    return ~dilate(~mask, radius)


def flood_background(whiteness: np.ndarray, threshold: float = WHITE) -> np.ndarray:
    """Near-white pixels connected to the border, i.e. the actual background."""
    binary = np.where(whiteness >= threshold, 255, 0).astype(np.uint8)
    # Images created by fromarray() can be read-only, which makes floodfill a no-op.
    image = Image.fromarray(binary, "L").copy()
    ImageDraw.floodfill(image, (0, 0), 128, thresh=1)
    return np.asarray(image) == 128


def bleed_colors(colors: np.ndarray, core: np.ndarray, radius: int):
    """Propagate the nearest core colour into the surrounding pixels."""
    known = core.copy()
    bleed = colors * known[..., None]
    for _ in range(radius):
        if known.all():
            break
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            shifted_known = np.roll(known, (dy, dx), (0, 1))
            shifted_bleed = np.roll(bleed, (dy, dx), (0, 1))
            take = shifted_known & ~known
            known |= take
            bleed[take] = shifted_bleed[take]
    return np.where(known[..., None], bleed, colors), known


def process(piece: Image.Image, mode: str) -> tuple[np.ndarray, np.ndarray]:
    """Turn a white-background piece into (colours, alpha) at native scale."""
    pixels = np.asarray(piece).astype(np.float32)
    whiteness = pixels.min(axis=2) / 255.0

    if mode == "artwork":
        background = flood_background(whiteness)
        # Every other near-white pixel is a design element (dots, bezel, bar,
        # nodes, thin outlines): keep it opaque.
        design_white = (whiteness >= WHITE) & ~background
        near_background = dilate(background, BAND)
        interior = ~background & ~near_background
        core = interior | design_white
    elif mode == "text":
        # Glyphs are everything that is not (nearly) white; eroding the mask
        # by a pixel keeps the colour of solid glyph pixels only.
        background = whiteness >= 0.97
        core_seed = whiteness <= 0.75
        core = erode(core_seed, 1)
        if not core.any():
            core = core_seed
    else:
        raise ValueError(f"unknown mode: {mode}")

    colors, known = bleed_colors(pixels, core, BLEED_RADIUS)
    colors = np.where(core[..., None], pixels, colors)

    # Unmix the white background with the bled foreground colour.
    foreground = colors.min(axis=2) / 255.0
    denominator = np.maximum(1.0 - foreground, 1e-6)
    t = np.clip((whiteness - foreground) / denominator, 0.0, 1.0)
    alpha = 1.0 - t
    if mode == "artwork":
        # A near-white bled colour makes the unmix degenerate; fall back to
        # the pixel's own whiteness (a white element fading out).
        alpha = np.where(foreground > 0.90, whiteness, alpha)
    alpha = np.where(core, 1.0, alpha)
    alpha = np.where(background, 0.0, alpha)
    alpha = np.where(~core & ~known, 0.0, alpha)
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha[alpha < 4.0 / 255.0] = 0.0
    colors = np.where(alpha[..., None] > 0, colors, 0.0)
    return colors, alpha


def to_image(colors: np.ndarray, alpha: np.ndarray) -> Image.Image:
    rgba = np.dstack(
        [np.round(colors).astype(np.uint8), np.round(alpha * 255).astype(np.uint8)]
    )
    return Image.fromarray(rgba, "RGBA")


def render_piece(source: Image.Image, box: tuple[int, int, int, int], mode: str) -> Image.Image:
    return to_image(*process(source.crop(box), mode))


def compose(
    size: tuple[int, int], layers: list[tuple[Image.Image, tuple[int, int]]]
) -> Image.Image:
    canvas = np.zeros((size[1], size[0], 4), dtype=np.float32)
    for image, (left, top) in layers:
        layer = np.asarray(image).astype(np.float32)
        opacity = layer[..., 3:4] / 255.0
        height, width = layer.shape[:2]
        region = canvas[top : top + height, left : left + width]
        region[..., :3] = layer[..., :3] * opacity + region[..., :3] * (1.0 - opacity)
        region[..., 3:4] = layer[..., 3:4] + region[..., 3:4] * (1.0 - opacity)
    colors = canvas[..., :3]
    alpha = canvas[..., 3:4] / 255.0
    colors = np.where(alpha > 1e-6, colors / np.maximum(alpha, 1e-6), 0.0)
    return to_image(np.clip(colors, 0, 255), alpha[..., 0])


def build() -> dict[Path, Image.Image]:
    """Render every branding asset in memory."""
    source = Image.open(SOURCE).convert("RGB")
    illustration = render_piece(source, ILLUSTRATION_BOX, "artwork")
    text = render_piece(source, TEXT_BOX, "text")
    readme = compose(
        README_CANVAS, [(illustration, ILLUSTRATION_AT), (text, TEXT_AT)]
    )
    icon = render_piece(source, ICON_BOX, "artwork")
    return {README_LOGO: readme, APP_ICON: icon}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify that the assets on disk are up to date instead of writing them",
    )
    args = parser.parse_args()

    if not SOURCE.exists():
        print(f"error: missing source artwork: {SOURCE.relative_to(ROOT)}", file=sys.stderr)
        return 1

    assets = build()

    if args.check:
        stale = []
        for path, image in assets.items():
            relative = path.relative_to(ROOT)
            if not path.exists():
                stale.append(f"{relative} is missing")
                continue
            current = np.asarray(Image.open(path).convert("RGBA"))
            if np.array_equal(current, np.asarray(image)):
                print(f"ok: {relative}")
            else:
                stale.append(f"{relative} is not up to date")
        for message in stale:
            print(f"error: {message}", file=sys.stderr)
        return 1 if stale else 0

    for path, image in assets.items():
        image.save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({image.width}x{image.height})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
