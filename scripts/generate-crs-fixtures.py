#!/usr/bin/env python3
"""Regenerate tests/crs-overrides.fixtures.json from pyproj.

For each CRS that has an override in build-crs-manifest.mjs, computes
WGS84 (lon, lat) for a handful of fixture projected coordinates using
pyproj's grid-based transformation (the ground truth). The Vitest test
in `tests/crs-overrides.test.ts` consumes this file and asserts that
proj4js with the override applied gives the same answer to within the
threshold.

Run: python3 scripts/generate-crs-fixtures.py [--crs 28992,31370,...]

Requires: pyproj 3.7+ with proj-data installed (so the Dutch / Belgian
NTv2 grids are available locally). On first run the cdn.proj.org grids
will be downloaded automatically if PROJ_NETWORK=ON (default in modern
PROJ installs).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

try:
    import pyproj
except ImportError:
    sys.stderr.write(
        "pyproj is required. Install with: python3 -m venv .venv && "
        ".venv/bin/pip install pyproj\n"
    )
    sys.exit(1)


# Fixture points per CRS — projected (E, N) in the CRS's native units.
# Picked to span the country/region so a regression localised to one
# corner gets caught.
FIXTURES_BY_CODE: dict[int, list[tuple[float, float]]] = {
    # Netherlands — RD New
    28992: [
        (90770, 435320),    # Schiehaven, Rotterdam (MiniBIM file)
        (155000, 463000),   # Amersfoort (RD origin)
        (121500, 487500),   # Amsterdam centre
        (177500, 318000),   # Maastricht
        (233500, 581500),   # Groningen
        (80700, 454500),    # Den Haag
    ],
    # NL compound (RD New + NAP) — same horizontal as 28992
    7415: [
        (90770, 435320),
        (155000, 463000),
    ],
    # Belgium — Lambert 72
    31370: [
        (150000, 170000),   # Brussels area
        (100000, 200000),   # Antwerp area
        (250000, 150000),   # Liège area
    ],
    # Luxembourg — Luxembourg 1930 / Gauss
    2169: [
        (75000, 75000),     # Luxembourg City area
        (80000, 100000),    # near LU origin
    ],
    # Caribbean Netherlands (BES islands) — MANUAL_ENTRIES in
    # build-crs-manifest.mjs. PROJ 9.5.1's EPSG database predates these
    # codes, so they are skipped (with a warning) until pyproj ships a
    # newer EPSG snapshot. Until then the reference check is the exact
    # EPSG position-vector formula, which proj4js was verified to
    # reproduce to <1 mm at these points.
    # Bonaire — Bonaire DPnet
    10759: [
        (21994.60, 19613.60),   # Kralendijk
        (23209.56, 21423.99),   # projection origin
    ],
    # Saba — Saba DPnet
    10641: [
        (3444.92, 2324.46),     # The Bottom
    ],
    # Sint Eustatius — Sint Eustatius DPnet long
    10745: [
        (501641.01, 1933344.06),  # Oranjestad
    ],
    # BES compounds — same horizontal as the projected entries above
    10764: [(21994.60, 19613.60)],
    10645: [(3444.92, 2324.46)],
    10747: [(501641.01, 1933344.06)],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--crs",
        help="Comma-separated EPSG codes to generate (default: all)",
    )
    parser.add_argument(
        "--threshold-m",
        type=float,
        default=0.5,
        help="Accuracy threshold in metres recorded in the fixture",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent
        / "tests"
        / "crs-overrides.fixtures.json",
        help="Output JSON path",
    )
    args = parser.parse_args()

    if args.crs:
        codes = sorted(int(c) for c in args.crs.split(","))
    else:
        codes = sorted(FIXTURES_BY_CODE.keys())

    fixtures: dict[str, list[dict[str, list[float]]]] = {}
    for code in codes:
        if code not in FIXTURES_BY_CODE:
            sys.stderr.write(
                f"warn: no fixture points defined for EPSG:{code}\n"
            )
            continue
        try:
            transformer = pyproj.Transformer.from_crs(
                f"EPSG:{code}", "EPSG:4326", always_xy=True
            )
        except pyproj.exceptions.CRSError:
            sys.stderr.write(
                f"warn: EPSG:{code} unknown to this PROJ version "
                f"({pyproj.__proj_version__}) — skipped\n"
            )
            continue
        entries = []
        for proj_x, proj_y in FIXTURES_BY_CODE[code]:
            lon, lat = transformer.transform(proj_x, proj_y)
            entries.append({
                "projected": [proj_x, proj_y],
                "wgs84": [round(lon, 7), round(lat, 7)],
            })
        fixtures[str(code)] = entries
        print(f"  EPSG:{code}: {len(entries)} fixture points")

    out = {
        "_generated": (
            f"pyproj {pyproj.__version__} / PROJ {pyproj.__proj_version__} "
            f"on {date.today().isoformat()}"
        ),
        "_threshold_m": args.threshold_m,
        "fixtures": fixtures,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
