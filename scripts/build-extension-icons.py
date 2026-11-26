from __future__ import annotations

import argparse
from pathlib import Path
from PIL import Image

SHEETS = {
    "developer": [
        "code", "terminal", "command", "bug", "tests", "package", "git", "branch",
        "merge", "commit", "repository", "cloud", "server", "database", "table", "api",
        "braces", "function", "variable", "binary", "cpu", "memory", "monitor", "mobile",
        "keyboard", "mouse", "printer", "microchip", "link", "webhook", "workflow", "deploy",
    ],
    "productivity": [
        "folder", "folder-open", "file", "document", "note", "edit", "copy", "paste",
        "save", "archive", "trash", "download", "upload", "attachment", "image", "video",
        "audio", "pdf", "spreadsheet", "presentation", "calendar", "clock", "alarm", "timer",
        "checklist", "task", "bookmark", "tag", "search", "filter", "sort", "dashboard",
    ],
    "communication": [
        "mail", "message", "chat", "comment", "send", "inbox", "phone", "contacts",
        "user", "users", "team", "notification", "bell", "megaphone", "globe", "map",
        "location", "compass", "home", "lock", "key", "shield", "eye", "hidden-eye",
        "settings", "sliders", "help", "info", "warning", "error", "check", "close",
    ],
    "creative": [
        "spark", "magic", "robot", "brain", "rocket", "airplane", "car", "train",
        "bicycle", "gamepad", "puzzle", "dice", "music", "microphone", "camera", "palette",
        "brush", "pen", "book", "graduation", "flask", "atom", "leaf", "fire",
        "sun", "moon", "star", "heart", "trophy", "bar-chart", "pie-chart", "bolt",
    ],
}
NEUTRAL = (169, 175, 184)


def connected_components(mask: Image.Image, minimum: int = 18) -> Image.Image:
    pixels = mask.load()
    width, height = mask.size
    seen: set[tuple[int, int]] = set()
    keep: set[tuple[int, int]] = set()
    for y in range(height):
        for x in range(width):
            if pixels[x, y] == 0 or (x, y) in seen:
                continue
            stack = [(x, y)]
            seen.add((x, y))
            component: list[tuple[int, int]] = []
            while stack:
                cx, cy = stack.pop()
                component.append((cx, cy))
                for nx in range(max(0, cx - 1), min(width, cx + 2)):
                    for ny in range(max(0, cy - 1), min(height, cy + 2)):
                        if pixels[nx, ny] and (nx, ny) not in seen:
                            seen.add((nx, ny))
                            stack.append((nx, ny))
            if len(component) >= minimum:
                keep.update(component)
    result = Image.new("L", (width, height), 0)
    result_pixels = result.load()
    for x, y in keep:
        result_pixels[x, y] = pixels[x, y]
    return result


def save_icon(image: Image.Image, target: Path) -> None:
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y][3] > 0:
                pixels[x, y] = (*NEUTRAL, pixels[x, y][3])
    image.save(target, "PNG", optimize=True)


def crop_sheet(source: Path, names: list[str], out_dir: Path, size: int) -> None:
    image = Image.open(source).convert("RGBA")
    columns, rows = 8, 4
    for index, icon_id in enumerate(names):
        column, row = index % columns, index // columns
        x0, x1 = round(column * image.width / columns), round((column + 1) * image.width / columns)
        y0, y1 = round(row * image.height / rows), round((row + 1) * image.height / rows)
        cell = image.crop((x0, y0, x1, y1))
        alpha = cell.getchannel("A").point(lambda value: 255 if value >= 60 else 0)
        alpha = connected_components(alpha)
        if alpha.getbbox() is None:
            if icon_id == "deploy":
                continue
            raise SystemExit(f"no visible glyph found for {icon_id} in {source}")
        bbox = alpha.getbbox()
        assert bbox is not None
        cell = cell.crop(bbox)
        monochrome = Image.new("RGBA", cell.size, (*NEUTRAL, 0))
        monochrome.putalpha(alpha.crop(bbox))
        pad = max(2, round(size * 0.16))
        scale = min((size - pad * 2) / max(1, monochrome.width), (size - pad * 2) / max(1, monochrome.height))
        fitted = monochrome.resize((max(1, round(monochrome.width * scale)), max(1, round(monochrome.height * scale))), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
        save_icon(canvas, out_dir / f"{icon_id}.png")


def crop_single(source: Path, icon_id: str, out_dir: Path, size: int) -> None:
    cell = Image.open(source).convert("RGBA")
    alpha = connected_components(cell.getchannel("A").point(lambda value: 255 if value >= 60 else 0))
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit(f"no visible glyph found for {icon_id} in {source}")
    cell = cell.crop(bbox)
    monochrome = Image.new("RGBA", cell.size, (*NEUTRAL, 0))
    monochrome.putalpha(alpha.crop(bbox))
    pad = max(2, round(size * 0.16))
    scale = min((size - pad * 2) / max(1, monochrome.width), (size - pad * 2) / max(1, monochrome.height))
    fitted = monochrome.resize((max(1, round(monochrome.width * scale)), max(1, round(monochrome.height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    save_icon(canvas, out_dir / f"{icon_id}.png")


def build(sources: Path, out_dir: Path, size: int = 64) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in [*out_dir.glob("*.webp"), *out_dir.glob("*.png")]:
        old.unlink()
    for sheet, names in SHEETS.items():
        crop_sheet(sources / f"extension-icons-{sheet}.png", names, out_dir, size)
    crop_single(sources / "extension-icons-deploy.png", "deploy", out_dir, size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", type=Path, default=Path("docs/prototypes/extension-icons"))
    parser.add_argument("--out", type=Path, default=Path("src/renderer/src/assets/extensions"))
    parser.add_argument("--size", type=int, default=64)
    args = parser.parse_args()
    build(args.sources, args.out, args.size)
