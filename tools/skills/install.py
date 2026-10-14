#!/usr/bin/env python3
"""Install vendored skills into the canonical plugin skills dir.

Copies every skill (a directory containing SKILL.md) from the vendored
repos under ../vendor/skills into ~/.pi/pi-contexture/skills/<vendor>/<skill>,
deduped by skill name (frontmatter `name`, else directory basename) — the
first occurrence wins. Repo priority follows skills.yaml order, then the
remaining repos alphabetically, so superpowers' test-driven-development
beats agent-skills' copy, and anthropics' document skills beat the
awesome-claude-skills mirror. Symlinked directories are not followed, and
fn-skills' deprecated skills/old/ copies are skipped.

The plugin's skills picker reads only this canonical dir (or
$CX_SKILLS_DIRS), so every session sees the same set regardless of cwd.
Re-running is idempotent: existing destinations are replaced.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
CTX = ROOT.parent.parent  # nursery/contexture
# Vendored clones are untracked, so jj workspaces don't have them; point
# CX_VENDOR_DIR at the default checkout's vendor/ when running elsewhere.
VENDOR = Path(
    os.environ.get("CX_VENDOR_DIR") or CTX / "vendor" / "skills"
)
DEST = Path.home() / ".pi" / "pi-contexture" / "skills"

# Skilled subtrees holding deprecated copies of live skill names.
SKIP_PARTS = {"old"}


def frontmatter_name(text: str) -> str | None:
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return None
    for line in match.group(1).splitlines():
        if line.startswith("name:"):
            value = line.split(":", 1)[1].strip().strip('"')
            if value:
                return value
    return None


def repo_order() -> list[str]:
    """Vendored repo names in skills.yaml order, then the rest alphabetically.

    skills.yaml's `dest: '.'` entry (anthropics/skills, whose clone IS the
    vendor root) is named 'skills' here, matching its directory.
    """
    schema = yaml.safe_load((ROOT / "skills.yaml").read_text())
    listed: list[str] = []
    for entry in schema.get("repos", []):
        name = entry.get("dest") or entry.get("pack") or entry["repo"].split("/")[-1]
        if name == ".":
            name = "skills"
        listed.append(name)
    found = sorted(
        d.name for d in VENDOR.iterdir() if d.is_dir() and not d.is_symlink()
    )
    return listed + [n for n in found if n not in listed]


def is_under_symlink(repo_dir: Path, skill_dir: Path) -> bool:
    probe = repo_dir
    for part in skill_dir.relative_to(repo_dir).parts:
        probe = probe / part
        if probe.is_symlink():
            return True
    return False


def install() -> int:
    if not VENDOR.is_dir():
        print(f"vendor dir missing: {VENDOR}", file=sys.stderr)
        return 1
    DEST.mkdir(parents=True, exist_ok=True)
    installed: set[str] = set()
    count = 0
    for repo in repo_order():
        repo_dir = VENDOR / repo
        if not repo_dir.is_dir():
            continue
        for skill_md in sorted(repo_dir.rglob("SKILL.md")):
            skill_dir = skill_md.parent
            rel = skill_dir.relative_to(repo_dir)
            if SKIP_PARTS & set(rel.parts) or is_under_symlink(repo_dir, skill_dir):
                continue
            name = frontmatter_name(skill_md.read_text()) or skill_dir.name
            if name in installed:
                print(f"  duplicate skipped: {name} ({repo}/{rel})")
                continue
            dest = DEST / repo / skill_dir.name
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(skill_dir, dest, symlinks=False)
            installed.add(name)
            count += 1
    print(f"installed {count} skills -> {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(install())
