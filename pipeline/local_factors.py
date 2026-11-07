"""Local factors per census tract: traits of a place that the demographic cells don't carry, used
by the app to explain the district residual (how much more D or R a district votes than its
demographics and state predict).

Each factor is a share: numerator / denominator, both stored per tract so they add up to any
district plan. Sources:
  ACS 2019-2023 tract tables (columns checked against the Census table shells by label)
    Hispanic origin (B03001), Asian origin (B02015), household income (B19001), industry
    (C24030), marriage (B12001), veterans (B21001), home ownership (B25003), foreign-born (B05002)
  2020 U.S. Religion Census, county level (tracts take their county's shares): adherents of
    Evangelical, Mainline and historically Black Protestant churches, Catholic, Latter-day Saints,
    and all adherents, as shares of the population. Denominations are classed by their ASARB
    group code (the largest ~70 groups, ~99% of adherents).
  Density: people per square mile (urbanicity.py), as log10.

Usage: python local_factors.py [--force]
Output: data/work/local_factors.csv.gz  (GEOID, <factor>_num, <factor>_den per factor)
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import sources
from sources import RAW, WORK

OUT = WORK / "local_factors.csv.gz"
SHELLS_URL = "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/ACS20235YR_Table_Shells.txt"

# factor id: (label, numerator columns, denominator column). Columns are "<table>_<line>" and are
# verified against the table shells' labels below (EXPECT), so a changed layout fails loudly.
ACS_FACTORS = {
    "mexican": ("Mexican origin", ["B03001_004"], "B03001_001"),
    "caribbean_hisp": ("Puerto Rican or Dominican origin", ["B03001_005", "B03001_007"], "B03001_001"),
    "cuban_venezuelan": ("Cuban or Venezuelan origin", ["B03001_006", "B03001_025"], "B03001_001"),
    "south_asian": ("South Asian origin", [f"B02015_{i:03d}" for i in range(21, 29)], "B03001_001"),
    "vietnamese": ("Vietnamese origin", ["B02015_019"], "B03001_001"),
    "east_asian": ("Chinese, Taiwanese, Korean or Japanese origin", ["B02015_002", "B02015_004", "B02015_005", "B02015_008"], "B03001_001"),
    "income_high": ("Households earning $150k+", ["B19001_016", "B19001_017"], "B19001_001"),
    "income_low": ("Households earning under $35k", [f"B19001_{i:03d}" for i in range(2, 8)], "B19001_001"),
    "extractive": ("Workers in farming, forestry, fishing or mining", ["C24030_003", "C24030_030"], "C24030_001"),
    "manufacturing": ("Workers in manufacturing", ["C24030_007", "C24030_034"], "C24030_001"),
    "married": ("Married (15+)", ["B12001_005", "B12001_008", "B12001_014", "B12001_017"], "B12001_001"),
    "veterans": ("Veterans (18+)", ["B21001_002"], "B21001_001"),
    "owners": ("Homeowner households", ["B25003_002"], "B25003_001"),
    "foreign_born": ("Foreign-born", ["B05002_013"], "B05002_001"),
}
EXPECT = {  # column -> label in the shells (the start of it)
    "B03001_001": "Total", "B03001_004": "Mexican", "B03001_005": "Puerto Rican", "B03001_006": "Cuban",
    "B03001_007": "Dominican", "B03001_025": "Venezuelan", "B02015_019": "Vietnamese", "B02015_021": "Asian Indian",
    "B02015_028": "Other South Asian", "B02015_002": "Chinese, except Taiwanese", "B02015_004": "Japanese",
    "B02015_005": "Korean", "B02015_008": "Taiwanese", "B19001_001": "Total", "B19001_002": "Less than $10,000",
    "B19001_007": "$30,000 to $34,999", "B19001_016": "$150,000 to $199,999", "B19001_017": "$200,000 or more",
    "C24030_001": "Total", "C24030_003": "Agriculture, forestry, fishing and hunting, and mining",
    "C24030_030": "Agriculture, forestry, fishing and hunting, and mining", "C24030_007": "Manufacturing",
    "C24030_034": "Manufacturing", "B12001_001": "Total", "B12001_005": "Married, spouse present",
    "B12001_008": "Other", "B12001_014": "Married, spouse present", "B12001_017": "Other",
    "B21001_001": "Total", "B21001_002": "Veteran", "B25003_001": "Total", "B25003_002": "Owner occupied",
    "B05002_001": "Total", "B05002_013": "Foreign-born",
}

# 2020 U.S. Religion Census group codes by tradition (Pew / ARDA classification)
TRADITIONS = {
    "evangelical": ("Evangelical Protestant adherents", {
        "500", "419", "053", "283", "167", "097", "413", "165", "127", "123", "089", "469", "356", "263",
        "467", "FFR", "223", "463", "201", "105", "017", "291", "221"}),
    "mainline": ("Mainline Protestant adherents", {
        "449", "207", "193", "355", "019", "443", "093", "371", "157", "288", "185"}),
    "black_protestant": ("Historically Black Protestant adherents", {
        "302", "300", "003", "141", "005", "101", "364", "301", "232", "155", "D71"}),
    "catholic": ("Catholic adherents", {"081"}),
    "lds": ("Latter-day Saint adherents", {"151"}),
}


def shells() -> dict[str, str]:
    f = sources.download(SHELLS_URL, RAW / "acs2023" / "ACS20235YR_Table_Shells.txt")
    d = pd.read_csv(f, sep="|", dtype=str, encoding="utf-8-sig")
    return dict(zip(d["Unique ID"], d["Label"].str.strip()))


def acs_factors(geoids: pd.Index) -> pd.DataFrame:
    import demographics
    labels = shells()
    for col, want in EXPECT.items():
        got = labels.get(col, "")
        assert got.startswith(want), f"ACS layout changed: {col} is {got!r}, expected {want!r}"
    out = pd.DataFrame(index=geoids)
    tables = {c.split("_")[0].lower() for _, nums, den in ACS_FACTORS.values() for c in [*nums, den]}
    tabs = {t: demographics.acs_table(t) for t in sorted(tables)}
    col = lambda c: tabs[c.split("_")[0].lower()][c.replace("_", "_E")].reindex(geoids).fillna(0).to_numpy(float)
    for fid, (_, nums, den) in ACS_FACTORS.items():
        out[f"{fid}_num"] = sum(col(c) for c in nums)
        out[f"{fid}_den"] = col(den)
    return out


def religion_by_county() -> pd.DataFrame:
    """County FIPS -> adherents per tradition and all adherents, and the 2020 population."""
    f = sources.religion()
    acc: dict[str, dict[str, float]] = {}
    pop: dict[str, float] = {}
    for row in sources.xlsx_rows(f, "2020 Group by County"):
        fips, code, adh, share = row.get("A"), row.get("D"), row.get("G"), row.get("I")
        if not fips or not fips.isdigit() or not adh:
            continue
        a = float(adh)
        c = acc.setdefault(fips, {t: 0.0 for t in [*TRADITIONS, "adherents"]})
        c["adherents"] += a
        for t, (_, codes) in TRADITIONS.items():
            if code in codes:
                c[t] += a
        if share and float(share) > 0 and fips not in pop:
            pop[fips] = a / float(share)  # adherents / (adherents as share of population)
    d = pd.DataFrame.from_dict(acc, orient="index")
    d["pop"] = pd.Series(pop)
    return d


def run() -> None:
    import urbanicity
    u = pd.read_csv(urbanicity.OUT, dtype={"GEOID": str}).set_index("GEOID")
    tracts = pd.Index(u.index)
    # ACS rows: Connecticut's tables use 2022 county codes (same tract numbers)
    import demographics
    ids = pd.Index(np.concatenate([np.asarray(demographics.acs_ids(usps, [g for g in tracts if g.startswith(fips)]))
                                   for fips, (usps, _) in sources.STATES.items()]))
    order = pd.Index(np.concatenate([[g for g in tracts if g.startswith(fips)] for fips in sources.STATES]))
    acs = acs_factors(ids)
    acs.index = order
    pop = demographics.acs_table("b01001")["B01001_E001"].reindex(ids).fillna(0).to_numpy(float)
    out = acs.copy()
    rel = religion_by_county()
    county = rel.reindex(order.str[:5])
    for t in [*TRADITIONS, "adherents"]:
        share = (county[t] / county["pop"]).fillna(0).clip(0, 1).to_numpy()
        out[f"{t}_num"] = share * pop
        out[f"{t}_den"] = pop
    out["log_density_num"] = np.log10(np.maximum(u.density.reindex(order).fillna(1).to_numpy(), 1)) * pop
    out["log_density_den"] = pop
    out.index.name = "GEOID"
    out.to_csv(OUT, float_format="%.2f")
    miss = county["pop"].isna().mean()
    print(f"local factors: {len(out)} tracts, {len(factor_labels())} factors; "
          f"{miss:.1%} of tracts without religion data")


def factor_labels() -> dict[str, str]:
    return {**{k: v[0] for k, v in ACS_FACTORS.items()},
            **{k: v[0] for k, v in TRADITIONS.items()},
            "adherents": "Religious adherents (any)", "log_density": "Population density (log10 per sq mi)"}


def load() -> pd.DataFrame:
    return pd.read_csv(OUT, dtype={"GEOID": str}).set_index("GEOID")


if __name__ == "__main__":
    if "--force" in sys.argv or not OUT.exists():
        run()
    else:
        print("local factors up to date")
