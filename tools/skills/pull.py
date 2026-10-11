#!/usr/bin/env python3
"""Pull agent skills from vendored repos into the context bag.

Reads skills.yaml. For each repo: shallow-clone to ../vendor/<name> if
missing, locate listed skills, distill each SKILL.md into terse atoms
(summary + section highlights), write a markdown pack, and import it via
`cx add` (per-source sync: idempotent, and posts hub events if
configured). The bag stays in SQLite via the normal path.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
CTX = ROOT.parent.parent  # nursery/contextual
VENDOR = CTX / "vendor"
PACKS = CTX / "packs"

SUMMARY_CAP = 160
SECTION_CAP = 140
MAX_SECTIONS = 6


def ensure_repo(repo: str) -> Path:
    """Vendored clone or shallow clone; returns the local path."""
    name = repo.split("/")[-1]
    dest = VENDOR / name
    if not (dest / ".git").exists():
        VENDOR.mkdir(parents=True, exist_ok=True)
        print(f"cloning {repo} -> {dest}")
        subprocess.run(
            ["git", "clone", "-q", "--depth", "1",
             f"https://github.com/{repo}", str(dest)],
            check=True,
        )
    return dest


def find_skill_dir(repo_dir: Path, path: str) -> Path | None:
    direct = repo_dir / path
    if (direct / "SKILL.md").exists():
        return direct
    hits = [d for d in repo_dir.rglob(path) if (d / "SKILL.md").exists()]
    return hits[0] if hits else None


def frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    fields: dict[str, str] = {}
    if not match:
        return fields
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip().strip('"')
    return fields


def first_sentence(text: str, cap: int) -> str:
    """First sentence, condensed to at most `cap` chars.

    Cutting happens at a clause or word boundary — never mid-word, and
    never with a dangling ellipsis (truncation artifacts used to end up
    as atoms ending in '…'). List separators (' - ') become '; ' so
    bullet-list sections read as compact enumerations instead of one
    chopped sentence.
    """
    text = text.replace("**", "").replace("```", " ").replace("`", "")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^[\-\* ]+", "", text)
    text = text.replace(" - ", "; ")
    sentence = re.split(r"(?<=\.)\s", text)[0]
    if len(sentence) <= cap:
        return sentence
    cut = sentence[:cap]
    for sep in ("; ", ". ", ", "):
        idx = cut.rfind(sep)
        if idx > cap // 2:
            return cut[:idx].rstrip(" ,;.")
    return cut.rsplit(" ", 1)[0].rstrip(" ,;.")


def usable(text: str, min_len: int = 15) -> bool:
    """Reject heading fragments and other content-free atoms.

    Kills the artifacts the old extractor produced: bare sub-headings
    ('changes: ### Step 5: Push the Change'), list markers ('1.'), YAML
    fragments ('|-'), and anything that is a label with no content.
    """
    stripped = text.strip()
    if len(stripped) < min_len:
        return False
    if stripped.endswith(":"):
        return False
    if not any(c.isalpha() for c in stripped):
        return False
    return True


def slugify(heading: str) -> str:
    """'Critical: Avoid interactive mode' -> 'critical-avoid-interactive-mode'.

    The old version kept the colon ('critical:-avoid-...'), which leaked
    into atom labels.
    """
    return (
        heading.strip().lower().replace(": ", " ").replace(":", "").replace(" ", "-")
    )


def distill(skill_dir: Path, extra_tags: list[str]) -> tuple[str, list[str]]:
    """Terse atom lines for one skill. Tags ride on every atom so any
    single hit pulls the whole node."""
    source = (skill_dir / "SKILL.md").read_text()
    fields = frontmatter(source)
    name = fields.get("name") or skill_dir.name
    description = fields.get("description", "")
    tags = list(dict.fromkeys(extra_tags))  # dedupe, keep order
    tag_suffix = " " + " ".join(f"#{t}" for t in tags) if tags else ""

    body = source[match.end():] if (match := re.match(r"^---\n(.*?)\n---", source, re.DOTALL)) else source
    lines = []
    summary = first_sentence(description, SUMMARY_CAP)
    if usable(summary):
        lines.append(f"{summary}{tag_suffix}")

    # Section highlights: "## heading" -> first sentence under it.
    sections = re.findall(r"^## (.+)$", body, re.MULTILINE)
    sections = [s.split("#")[0].strip() for s in sections]  # strip trailing hashtags
    sections = [s for s in sections if s and s.lower() not in ("overview",)]
    noisy = ("|", "dot ", "graph ", "label=", "```", "#")
    seen: set[str] = set()
    for heading in sections[:MAX_SECTIONS]:
        # first sentence after the heading
        pattern = re.compile(rf"^## {re.escape(heading)}.*?\n\n(.+?)(?:\n\n|\n#)", re.DOTALL | re.MULTILINE)
        if m := pattern.search(body):
            if any(m.group(1).lstrip().startswith(n) for n in noisy):
                continue
            highlight = first_sentence(m.group(1), SECTION_CAP)
            line = f"{slugify(heading)}: {highlight}{tag_suffix}"
            if not usable(highlight) or line in seen:
                continue
            seen.add(line)
            lines.append(line)
    return name, lines


def main() -> int:
    schema = yaml.safe_load((ROOT / "skills.yaml").read_text())
    prefix = schema.get("scope_prefix", "skills")
    PACKS.mkdir(parents=True, exist_ok=True)
    failures = 0

    for entry in schema.get("repos", []):
        repo = entry["repo"]
        vendor = ensure_repo(repo)
        skills = entry.get("skills")
        if not skills:
            skills = [
                {"path": d.parent.name}
                for d in vendor.rglob("SKILL.md")
            ]
        sections: list[str] = []
        for skill in skills:
            skill_dir = find_skill_dir(vendor, skill["path"])
            if skill_dir is None:
                print(f"!! {repo}: skill {skill['path']!r} not found", file=sys.stderr)
                failures += 1
                continue
            name, lines = distill(skill_dir, skill.get("tags", []))
            body = "\n".join(f"- {line}" for line in lines)
            sections.append(f"\n## {name}\n\n{body}")

        vendor_name = repo.split("/")[-1]
        pack = PACKS / f"skills-{vendor_name}.md"
        pack.write_text(f"# {prefix}/{vendor_name}\n" + "\n".join(sections) + "\n")
        result = subprocess.run(["cx", "add", str(pack)])
        if result.returncode != 0:
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
