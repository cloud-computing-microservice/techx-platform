"""Prepare a digest-pinned chart release; no Git/AWS/network side effects."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

ACCOUNT = "058114477594"
REGISTRY = f"{ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/techx"
COMPONENTS = {"frontend": "frontend", "catalog": "catalog-api", "order": "order-api"}


def validate_manifest(manifest: dict) -> dict[str, dict]:
    commit = manifest.get("commit", "")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Manifest must identify the full source commit")
    tag = f"staging-{commit[:12]}"
    if manifest.get("tag") != tag:
        raise ValueError("Tag does not match source commit")
    images = manifest.get("images", [])
    if len(images) != 3:
        raise ValueError("Exactly three image artifacts required")
    result = {}
    for entry in images:
        name = entry.get("component")
        if name not in COMPONENTS or name in result:
            raise ValueError("Unexpected or duplicate component")
        if entry.get("image") != f"{REGISTRY}/{name}:{tag}":
            raise ValueError("Unexpected image repository, account, region or tag")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", entry.get("digest", "")):
            raise ValueError("Invalid artifact digest")
        result[name] = entry
    return result


def render_values(original: str, manifest: dict) -> str:
    images = validate_manifest(manifest)
    updated = original
    for name, entry in images.items():
        repository = f"{REGISTRY}/{name}"
        pattern = (r"(?m)^(      repository: " + re.escape(repository)
                   + r"\r?\n)      tag: [^\r\n]+(?:\r?\n      digest: [^\r\n]*)?")
        replacement = (f"      repository: {repository}\n"
                       f"      tag: {manifest['tag']}\n      digest: {entry['digest']}")
        updated, count = re.subn(pattern, lambda _: replacement, updated)
        if count != 1:
            raise ValueError(f"Missing or ambiguous chart image block: {name}")
    return updated


def prepare(chart: Path, manifest: dict) -> None:
    values = chart / "values-staging.yaml"
    updated = render_values(values.read_text(encoding="utf-8-sig"), manifest)
    # Validate all artifacts and replacements before writing either file.
    values.write_text(updated, encoding="utf-8")
    output = chart / "releases/staging.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chart", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.chart, json.loads(args.manifest.read_text(encoding="utf-8-sig")))
