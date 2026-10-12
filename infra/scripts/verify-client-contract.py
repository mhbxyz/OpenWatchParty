#!/usr/bin/env python3
"""Check static client module declarations and the three protocol versions.

This reads the repository's literal declarations; it does not execute code or
generate a new manifest. Every client_js_files list declared in the root justfile
or under infra/ must match the loader. New declaration syntax must update this
check too.
Package resource/archive validation remains in package-plugin.sh.
"""

import argparse
from collections import Counter
from pathlib import Path, PurePosixPath
import re
import sys


CLIENT = Path("src/clients/jellyfin-web")
CONTROLLER = Path("src/plugins/jellyfin/OpenWatchParty/Controllers/OpenWatchPartyController.cs")
RUST = Path("src/server/src/ws/constants.rs")
JUST = Path("infra/just/common.just")
# Every other just file is scanned too, so a stale copy cannot pass silently.
JUST_FILES = ("justfile", "Justfile", ".justfile")
JUST_DIR = Path("infra")
JUST_DECLARATION = r"^(?:export\s+)?client_js_files\s*:="
JUST_LIST = JUST_DECLARATION + r'\s*"([^"\n]+)"\s*$'


def without_comments(text):
    # Preserve quoted literals so paths such as utils/url.js are not altered.
    tokens = r"'(?:(?:\\.)|[^'\\])*'|\"(?:(?:\\.)|[^\"\\])*\"|//[^\n]*|/\*[\s\S]*?\*/"
    return re.sub(tokens, lambda match: "\n" * match[0].count("\n")
                  if match[0].startswith(("//", "/*")) else match[0], text)


def one(pattern, text, label):
    matches = re.findall(pattern, text, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"{label}: expected one literal declaration, found {len(matches)}")
    return matches[0]


def module_set(modules, label):
    if not modules:
        raise ValueError(f"{label}: empty module list")
    duplicates = sorted(name for name, count in Counter(modules).items() if count > 1)
    if duplicates:
        raise ValueError(f"{label}: duplicate modules: {', '.join(duplicates)}")
    for name in modules:
        path = PurePosixPath(name)
        if (path.is_absolute() or ".." in path.parts or str(path) != name
                or not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.js", name)):
            raise ValueError(f"{label}: invalid module path: {name}")
    return set(modules)


def just_lists(root):
    """Return each just file's client_js_files list, requiring common.just's."""
    paths = [Path(name) for name in JUST_FILES if (root / name).is_file()]
    paths += sorted(path.relative_to(root) for path in (root / JUST_DIR).rglob("*.just"))
    lists = []
    for path in paths:
        text = (root / path).read_text(encoding="utf-8")
        declared = len(re.findall(JUST_DECLARATION, text, re.MULTILINE))
        if path != JUST and declared == 0:
            continue
        literal = one(JUST_LIST, text, path.as_posix())
        if declared != 1:
            raise ValueError(f"{path.as_posix()}: expected one literal declaration, found {declared}")
        lists.append((path.as_posix(), literal.split()))
    if JUST.as_posix() not in (label for label, _ in lists):
        raise ValueError(f"{JUST.as_posix()}: expected one literal declaration, found 0")
    return lists


def verify(root):
    loader = without_comments((root / CLIENT / "plugin.js").read_text(encoding="utf-8"))
    controller = without_comments((root / CONTROLLER).read_text(encoding="utf-8"))
    state = without_comments((root / CLIENT / "state.js").read_text(encoding="utf-8"))
    rust = without_comments((root / RUST).read_text(encoding="utf-8"))

    calls = re.findall(r"\bload\s*\(([^)]*)\)", loader)
    modules = []
    for call in calls:
        literal = re.fullmatch(r"\s*(['\"])([^'\"]+)\1\s*", call)
        if not literal:
            raise ValueError("plugin.js: load() requires a literal module path")
        modules.append(literal[2])
    expected = module_set(modules, "plugin.js")
    allowed_block = one(r"AllowedClientModules\s*=\s*new HashSet<string>\([^)]*\)\s*\{([^}]+)\}\s*;",
                        controller, "AllowedClientModules")
    allowed = re.findall(r'"([^"\n]+)"', allowed_block)
    # Reject expressions instead of silently extracting only the quoted paths.
    if re.sub(r'"[^"\n]+"|[\s,]', "", allowed_block):
        raise ValueError("AllowedClientModules: expected literal module paths")
    for label, entries in just_lists(root) + [("AllowedClientModules", allowed)]:
        actual = module_set(entries, label)
        missing, extra = sorted(expected - actual), sorted(actual - expected)
        if missing or extra:
            raise ValueError(f"{label}: module mismatch; missing={missing}, extra={extra}")
    for module in sorted(expected):
        source = root / CLIENT / module
        if not source.is_file() or source.stat().st_size == 0:
            raise ValueError(f"missing or empty client module: {CLIENT / module}")

    versions = {
        "JavaScript": int(one(r"\bPROTOCOL_VERSION\s*:\s*([0-9]+)\s*,", state, "JS protocol")),
        "Rust": int(one(r"\bconst PROTOCOL_VERSION\s*:\s*u64\s*=\s*([0-9]+)\s*;", rust, "Rust protocol")),
        "C#": int(one(r"\bconst int ProtocolVersion\s*=\s*([0-9]+)\s*;", controller, "C# protocol")),
    }
    if len(set(versions.values())) != 1:
        raise ValueError(f"protocol version mismatch: {versions}")
    return len(expected), versions["Rust"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        count, version = verify(args.root)
    except (OSError, ValueError) as error:
        print(f"Client contract verification failed: {error}", file=sys.stderr)
        return 1
    print(f"Client contract verified: {count} modules; protocol version {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
