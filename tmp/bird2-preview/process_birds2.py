from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageSequence
import numpy as np

SRC = Path(r"C:\Users\jpurc\Downloads\birds2 (1).gif")
OUT_DIR = Path(r"C:\Users\jpurc\RogueZero\tmp\bird2-preview\frames")
PREVIEW_DIR = Path(r"C:\Users\jpurc\RogueZero\tmp\bird2-preview")
TARGET_SIZE = (900, 900)

OUT_DIR.mkdir(parents=True, exist_ok=True)

with Image.open(SRC) as im:
    durations = []
    for i, frame in enumerate(ImageSequence.Iterator(im)):
        rgba = frame.convert("RGBA")
        arr = np.asarray(rgba).astype(np.float32)

        rgb = arr[:, :, :3]
        alpha = arr[:, :, 3]

        minc = rgb.min(axis=2)
        maxc = rgb.max(axis=2)
        sat = maxc - minc

        # Background model: pixels that are very bright across all channels
        # and have low channel spread are treated as white backdrop.
        white_strength = np.clip((minc - 214.0) / 34.0, 0.0, 1.0)
        neutral_strength = np.clip((92.0 - sat) / 92.0, 0.0, 1.0)
        bg_strength = np.power(white_strength * neutral_strength, 0.9)

        new_alpha = alpha * (1.0 - bg_strength)

        out = np.dstack((rgb, new_alpha)).clip(0, 255).astype(np.uint8)
        out_image = Image.fromarray(out, mode="RGBA").resize(TARGET_SIZE, Image.Resampling.LANCZOS)

        out_image.save(OUT_DIR / f"frame-{i:04d}.png")
        durations.append(frame.info.get("duration", 50))

        if i == 40:
            dark = Image.new("RGBA", TARGET_SIZE, (17, 17, 17, 255))
            dark.alpha_composite(out_image)
            dark.save(PREVIEW_DIR / "birds2-processed-dark-preview.png")
            out_image.save(PREVIEW_DIR / "birds2-processed-preview.png")

(Path(PREVIEW_DIR) / "durations.txt").write_text("\n".join(str(x) for x in durations), encoding="utf-8")
print(f"processed {i + 1} frames to {OUT_DIR}")
