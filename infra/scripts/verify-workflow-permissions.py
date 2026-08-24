#!/usr/bin/env python3
"""Enforce the exact GitHub Actions permission policy without YAML dependencies."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"

EXPECTED = {
    "ci.yml": {
        "rust-tests": {"contents": "read"},
        "dotnet-tests": {"contents": "read"},
        "js-lint": {"contents": "read"},
        "release-script-tests": {"contents": "read"},
        "build-server": {"contents": "read"},
    },
    "publish.yml": {
        "verify-versions": {"contents": "read"},
        "release-security-gate": {"contents": "read"},
        "build-and-push": {"contents": "read", "packages": "write"},
        "secure-image": {
            "attestations": "write",
            "contents": "read",
            "id-token": "write",
            "packages": "write",
        },
        "build-plugin": {"contents": "read"},
        "secure-plugin": {
            "attestations": "write",
            "contents": "read",
            "id-token": "write",
        },
        "create-release-assets": {"contents": "write"},
        "update-plugin-manifest": {"contents": "write"},
    },
    "docs.yml": {
        "build": {"contents": "read"},
        "deploy": {"pages": "write", "id-token": "write"},
    },
    "security.yml": {
        "cargo-audit": {"contents": "read"},
        "nuget-audit": {"contents": "read"},
        "bundler-audit": {"contents": "read"},
        "npm-audit": {"contents": "read"},
        "trivy-scan": {"contents": "read", "security-events": "write"},
        "codeql": {
            "actions": "read",
            "contents": "read",
            "security-events": "write",
        },
    },
}


def parse_jobs(lines: list[str]) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    jobs: dict[str, dict[str, str]] = {}
    bodies: dict[str, list[str]] = {}
    current_job = None
    in_permissions = False
    in_jobs = False
    permission_blocks: set[str] = set()

    for line in lines:
        if line == "jobs:":
            in_jobs = True
            continue
        if not in_jobs:
            continue
        job_match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if job_match:
            current_job = job_match.group(1)
            jobs[current_job] = {}
            bodies[current_job] = []
            in_permissions = False
            continue
        if current_job is None:
            continue
        if line and not line.startswith("  "):
            current_job = None
            in_permissions = False
            continue

        bodies[current_job].append(line)
        if re.match(r"^    permissions:", line):
            if line != "    permissions:":
                raise ValueError(f"{current_job}: permissions must be a mapping")
            if current_job in permission_blocks:
                raise ValueError(f"{current_job}: duplicate permissions block")
            permission_blocks.add(current_job)
            in_permissions = True
            continue
        if in_permissions:
            permission = re.match(r"^      ([a-z-]+): (read|write|none)\s*$", line)
            if permission:
                jobs[current_job][permission.group(1)] = permission.group(2)
            elif line.strip() and not line.startswith("      "):
                in_permissions = False

    return jobs, {job: "\n".join(body) for job, body in bodies.items()}


def main() -> int:
    failures: list[str] = []
    workflow_files = sorted(path.name for path in WORKFLOWS.glob("*.y*ml"))
    if workflow_files != sorted(EXPECTED):
        failures.append(
            f"workflow inventory differs: expected {sorted(EXPECTED)}, got {workflow_files}"
        )

    for filename, expected_jobs in EXPECTED.items():
        path = WORKFLOWS / filename
        if not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        global_permissions = [
            line for line in lines if not line.startswith(" ") and line.startswith("permissions:")
        ]
        if global_permissions != ["permissions: {}"]:
            failures.append(f"{filename}: global permissions must be exactly {{}}")

        try:
            actual_jobs, bodies = parse_jobs(lines)
        except ValueError as error:
            failures.append(f"{filename}: {error}")
            continue
        if actual_jobs != expected_jobs:
            failures.append(
                f"{filename}: expected job permissions {expected_jobs}, got {actual_jobs}"
            )

        for job, body in bodies.items():
            if "uses: actions/checkout@" in body and actual_jobs.get(job, {}).get("contents") not in {
                "read",
                "write",
            }:
                failures.append(f"{filename}:{job}: checkout requires contents permission")

    if failures:
        for failure in failures:
            print(f"Workflow permission verification failed: {failure}", file=sys.stderr)
        return 1

    print("GitHub Actions workflows use the expected least-privilege permissions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
