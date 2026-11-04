"""P17i: sinh + do TUAN TU (tranh crash CSPRNG khi qua nhieu node cung luc)."""

from __future__ import annotations

import os
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
    for scenario in ids:
        target = OUT / f"{round_name}_{scenario.split('_')[0]}"
        target.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                sys.executable, "-X", "utf8", str(TOOLS / "gen_load_suites.py"),
                "--only", scenario, "--out", str(target),
                "--scale", f"{scenario}={factor}",
            ],
            cwd=str(REPO), capture_output=True, text=True,
        )
        env = dict(os.environ)
        env["LOAD_DIR"] = str(target)
        with (target / "log.txt").open("w", encoding="utf-8") as log:
            proc = subprocess.run(
                ["npx.cmd", "vitest", "run", "src/sim/loadMeasure.test.ts"],
                cwd=str(WEB), stdout=log, stderr=subprocess.STDOUT, env=env,
            )
        print(f"{scenario}: rc={proc.returncode}")
        measure = target / "measure.json"
        if measure.is_file():
            print(f"  {measure.read_text(encoding='utf-8').strip()[:400]}")


if __name__ == "__main__":
    main()
