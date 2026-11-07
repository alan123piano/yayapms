"""Place class (urban / suburban / rural) of every census tract, for the `place` cell dimension.

The survey (CES) asks people whether they live in a city, a suburb, or a town / rural area. Tracts
are classed by population density, with the two cutoffs chosen so that the national share of
citizens of voting age in each class matches the survey's weighted shares (averaged over the
elections in ces_model.CES). Density = ACS 2019-2023 total population / land area (2020 tracts).

Usage: python urbanicity.py [--force]
Output: data/work/urbanicity.csv  (GEOID, density per sq mi, place 0 Urban / 1 Suburban / 2 Rural)
"""
from __future__ import annotations

import sys

import geopandas as gpd
import numpy as np
import pandas as pd

import cells
import sources
from sources import WORK

OUT = WORK / "urbanicity.csv"
SQ_MI = 2_589_988.11


def survey_shares() -> np.ndarray:
    """Weighted [Urban, Suburban, Rural] shares among the CES's citizen respondents."""
    import ces_model
    out = []
    for cfg in ces_model.CES.values():
        f = sources.dataverse_file(cfg["dataset"], cfg["folder"], cfg["file"])
        d = pd.read_csv(f, usecols=["urbancity", "cit1", "commonpostweight"], low_memory=False)
        d = d[(d.cit1 == 1) & d.commonpostweight.notna()]
        place = np.select([d.urbancity == 1, d.urbancity == 2, d.urbancity.isin([3, 4])], [0, 1, 2], -1)
        w = np.bincount(place[place >= 0], weights=d.commonpostweight[place >= 0], minlength=3)
        out.append(w / w.sum())
    return np.mean(out, axis=0)


def tract_density() -> pd.DataFrame:
    """GEOID, land area, ACS population and CVAP for every 2020 tract in the 50 states."""
    import demographics
    t = gpd.read_file(sources.tracts(), ignore_geometry=True)[["GEOID", "ALAND"]]
    t = t[t.GEOID.str[:2].isin(sources.STATES)].reset_index(drop=True)
    pop = demographics.acs_table("b01001")["B01001_E001"]
    cvap = demographics.cvap_race().sum(axis=1)
    rows = []
    for fips, (usps, _) in sources.STATES.items():
        g = t[t.GEOID.str.startswith(fips)]
        ids = demographics.acs_ids(usps, g.GEOID.tolist())  # Connecticut's ACS uses 2022 county codes
        rows.append(pd.DataFrame({"GEOID": g.GEOID.values, "aland": g.ALAND.values,
                                  "pop": pop.reindex(ids).fillna(0).values,
                                  "cvap": cvap.reindex(ids).fillna(0).values}))
    d = pd.concat(rows, ignore_index=True)
    d["density"] = d["pop"] / np.maximum(d.aland / SQ_MI, 1e-3)
    return d


def run() -> None:
    target = survey_shares()
    d = tract_density().sort_values("density").reset_index(drop=True)
    cum = d.cvap.cumsum() / d.cvap.sum()
    rural_max = d.density[cum <= target[2]].max()
    urban_min = d.density[cum <= target[2] + target[1]].max()
    d["place"] = np.select([d.density > urban_min, d.density > rural_max], [0, 1], 2)
    got = np.bincount(d.place, weights=d.cvap, minlength=3) / d.cvap.sum()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    d[["GEOID", "density", "place"]].to_csv(OUT, index=False, float_format="%.1f")
    names = cells.PLACES
    print("place classes (share of CVAP, survey target): " + ", ".join(
        f"{names[i]} {got[i]:.1%} ({target[i]:.1%})" for i in range(3))
        + f"; cutoffs: rural < {rural_max:.0f}/sq mi < suburban < {urban_min:.0f}/sq mi < urban")


def load() -> pd.Series:
    """GEOID -> place class."""
    return pd.read_csv(OUT, dtype={"GEOID": str}).set_index("GEOID")["place"]


if __name__ == "__main__":
    if "--force" in sys.argv or not OUT.exists():
        run()
    else:
        print("urbanicity up to date")
