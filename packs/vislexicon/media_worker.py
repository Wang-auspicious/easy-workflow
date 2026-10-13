"""Deterministic local media worker. Inputs are data, never executable source.

Arbitrary project programs are handled by the explicitly configured sandbox
runner; these built-in renderers do not eval/exec remote scripts or expressions.
"""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys


def figure(config, folder):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import random
    seed = int(config.get("seed", 0))
    random.seed(seed)
    kind = config.get("kind", "line")
    if kind not in ("line", "bar", "scatter"):
        raise ValueError("figure.kind must be line, bar or scatter")
    series = config.get("series", [])
    if not 1 <= len(series) <= 30:
        raise ValueError("figure requires 1–30 supplied data series")
    fig, ax = plt.subplots(figsize=(8, 5), dpi=160)
    for item in series:
        x, y = item.get("x", []), item.get("y", [])
        if len(x) != len(y) or not 1 <= len(x) <= 100000:
            raise ValueError("x/y must have equal, nonzero bounded lengths")
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in x + y):
            raise ValueError("series values must be finite numbers")
        getattr(ax, "plot" if kind == "line" else kind)(x, y, label=str(item.get("label", "")))
    ax.set(xlabel=str(config.get("xLabel", "")), ylabel=str(config.get("yLabel", "")), title=str(config.get("title", "")))
    if any(s.get("label") for s in series):
        ax.legend()
    fig.tight_layout()
    fig.savefig(folder / "figure.png")
    fig.savefig(folder / "figure.pdf")
    plt.close(fig)
    return {"seed": seed, "python": sys.version.split()[0], "matplotlib": matplotlib.__version__, "series": len(series), "points": sum(len(s["x"]) for s in series), "files": ["figure.png", "figure.pdf"]}


def effect(config, folder):
    import PIL
    from PIL import Image, ImageFilter, ImageEnhance, ImageOps
    Image.MAX_IMAGE_PIXELS = 40_000_000
    with Image.open(config["input"]) as source:
        if source.width * source.height > 40_000_000:
            raise ValueError("Input exceeds 40 million pixels")
        before = ImageOps.exif_transpose(source).convert("RGB")
    kind = config.get("kind")
    if kind == "grayscale":
        after = ImageOps.grayscale(before).convert("RGB")
    elif kind == "blur":
        radius = float(config.get("radius", 2))
        if not 0 < radius <= 100:
            raise ValueError("blur radius must be in (0,100]")
        after = before.filter(ImageFilter.GaussianBlur(radius))
    elif kind == "contrast":
        factor = float(config.get("factor", 1.5))
        if not 0 <= factor <= 10:
            raise ValueError("contrast factor must be in [0,10]")
        after = ImageEnhance.Contrast(before).enhance(factor)
    elif kind == "edges":
        after = before.filter(ImageFilter.FIND_EDGES)
    elif kind == "resize":
        width = int(config.get("width", 720))
        if not 1 <= width <= 8192:
            raise ValueError("resize width must be in [1,8192]")
        after = before.resize((width, max(1, round(before.height * width / before.width))), Image.Resampling.LANCZOS)
    else:
        raise ValueError("Unsupported effect; supply grayscale/blur/contrast/edges/resize")
    before.save(folder / "before.png")
    after.save(folder / "after.png")
    return {"kind": kind, "inputSize": list(before.size), "outputSize": list(after.size), "python": sys.version.split()[0], "pillow": PIL.__version__, "files": ["before.png", "after.png"], "limitations": ["RGB raster output", "No PSD layer retention", "No animation frames", "40 million input pixels maximum"]}


def deck(config, folder):
    import fitz
    original = Path(config["input"]).resolve()
    font_warnings = []
    if original.suffix.lower() == ".pptx":
        import zipfile
        import xml.etree.ElementTree as ET
        with zipfile.ZipFile(original) as archive:
            declared = set()
            for name in archive.namelist():
                if name.startswith(("ppt/slides/", "ppt/theme/")) and name.endswith(".xml"):
                    for node in ET.fromstring(archive.read(name)).iter():
                        face = node.attrib.get("typeface", "")
                        if face and not face.startswith("+"):
                            declared.add(face.casefold())
        installed = set()
        if sys.platform == "win32":
            import winreg
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as key:
                        for index in range(winreg.QueryInfoKey(key)[1]):
                            family = winreg.EnumValue(key, index)[0].split(" (")[0]
                            installed.update(part.casefold() for part in family.split(" & "))
                except OSError:
                    pass
        elif shutil.which("fc-list"):
            installed = set(subprocess.check_output(["fc-list", ":", "family"], text=True, timeout=10).casefold().replace(",", "\n").splitlines())
        missing = sorted(font for font in declared if font not in installed)
        if missing:
            font_warnings.append({"kind": "font-substitution", "fonts": missing, "message": "Fonts unavailable on renderer; original file retained, inspect rendered substitutions"})
    if original.suffix.lower() == ".pdf":
        pdf = original
    else:
        pdf = folder / "deck.pdf"
        office = os.environ.get("FACTORY_SOFFICE") or shutil.which("soffice") or shutil.which("libreoffice")
        if office:
            profile = (folder / "office-profile").resolve().as_uri()
            subprocess.run([office, "-env:UserInstallation=" + profile, "--headless", "--convert-to", "pdf", "--outdir", str(folder), str(original)], check=True, timeout=120, capture_output=True)
            produced = folder / (original.stem + ".pdf")
            if produced != pdf:
                produced.replace(pdf)
        elif sys.platform == "win32":
            # Native COM is available without pywin32. Isolated Python (-I)
            # intentionally excludes user-installed modules from this worker.
            import base64
            def literal(value):
                return "'" + str(value).replace("'", "''") + "'"
            script = "$ErrorActionPreference='Stop'; $deckApp=New-Object -ComObject PowerPoint.Application; $deckCount=$deckApp.Presentations.Count; $deckSecurity=$deckApp.AutomationSecurity; $deckDoc=$null; try { $deckApp.AutomationSecurity=3; $deckDoc=$deckApp.Presentations.Open(" + literal(original) + ",$true,$false,$false); $deckDoc.SaveAs(" + literal(pdf) + ",32) } finally { if($null -ne $deckDoc){$deckDoc.Close()}; $deckApp.AutomationSecurity=$deckSecurity; if($deckCount -eq 0 -and $deckApp.Presentations.Count -eq 0){$deckApp.Quit()}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deckApp) }"
            encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
            subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], check=True, timeout=120, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            raise RuntimeError("Install LibreOffice (soffice), or use PowerPoint on Windows, to render original PPTX slides")
    previews = []
    with fitz.open(pdf) as document:
        if not 1 <= document.page_count <= 500:
            raise ValueError("Deck must contain 1–500 pages")
        for index, page in enumerate(document):
            name = f"slide-{index + 1:04}.png"
            page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3), alpha=False).save(folder / name)
            previews.append({"page": index + 1, "file": name, "text": page.get_text()[:5000]})
    return {"pageCount": len(previews), "pages": previews, "renderer": "PDF rasterization after native deck export", "fontWarnings": font_warnings}


if __name__ == "__main__":
    mode, config_path, output = sys.argv[1:4]
    folder = Path(output).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    result = {"figure": figure, "effect": effect, "deck": deck}[mode](config, folder)
    print(json.dumps(result, ensure_ascii=False))
