"""P17i: sinh kich ban gian tai + chay do song song (PowerShell-friendly, khong can bash)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(r"D:\TechGar2")
TOOLS = REPO / "sim3d" / "tools"
WEB = REPO / "sim3d" / "web"
OUT = TOOLS / "out" / "p17i"


def main() -> None:
    round_name = sys.argv[1]
    factor = sys.argv[2]
    ids = sys.argv[3:]

    groups: dict[int, list[str]] = {}
    for index, scenario in enumerate(ids):
        groups.setdefault(index % 4, []).append(scenario)

    for group, members in groups.items():
        target = OUT / f"{round_name}_g{group}"
        target.mkdir(parents=True, exist_ok=True)
        for scenario in members:
            subprocess.run(
                [
                    sys.executable, "-X", "utf8", str(TOOLS / "gen_load_suites.py"),
                    "--only", scenario,
                    "--out", str(target),
                    "--scale", f"{scenario}={factor}",
                ],
                cwd=str(REPO), capture_output=True, text=True,
            )
            print(f"sinh {scenario} -> {target.name}")

    procs = []
    for group in groups:
        target = OUT / f"{round_name}_g{group}"
        log = (target / "log.txt").open("w", encoding="utf-8")
        env = {"LOAD_DIR": str(target), "PATH": r"C:\Program Files\nodejs;" + __import__("os").environ.get("PATH", "")}
        proc = subprocess.Popen(
            ["npx.cmd", "vitest", "run", "src/sim/loadMeasure.test.ts"],
            cwd=str(WEB), stdout=log, stderr=subprocess.STDOUT, env=env,
            shell=False,
        )
        procs.append((group, proc, log))
        print(f"chay nhom {group} (pid {proc.pid})")

    for group, proc, log in procs:
        proc.wait()
        log.close()
        print(f"nhom {group} xong rc={proc.returncode}")


if __name__ == "__main__":
    main()
