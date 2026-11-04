"""Per-tract voter cells (age x race x edu x sex) calibrated to real results.

1. Composition: citizen voting-age population (CVAP) per tract in 80 cells, by iterative
   proportional fitting (IPF). Seed = joint distribution of citizens 18+ in the tract's PUMA
   (ACS PUMS). Targets per tract (ACS 2019-2023):
     race            CVAP special tabulation (counts)
     age x sex       B01001 (shares of 18+, scaled to CVAP)
     college | age x sex    B15001 (18+)
     college | race x sex   C15002B/D/H/I + B15002 (25+; "Other" = remainder)
   Race and age x sex are applied last, so those totals are exact; education is approximate.
2. Behavior: CES turnout / Dem share per state x cell (ces_model.py).
3. Calibration per tract and election: one logit offset for turnout and one for Dem share,
   shared by all cells, so the cells reproduce the tract's real two-party votes exactly.

Usage: python demographics.py [--force] WI [NC ...]
Output: data/work/<USPS>/demo/<election>.npz  (geoid, cvap[T,80], voters[T,80], dem[T,80])
        data/work/<USPS>/tract_cd.csv          (tract population split across current districts)
"""
from __future__ import annotations

import argparse
import io
import zipfile

import numpy as np
import pandas as pd
from scipy.special import expit, logit

import cells
import sources
from sources import ELECTIONS, RAW, WORK

ACS_URL = "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/data/5YRData/acsdt5y2023-{t}.dat"
CVAP_URL = "https://www2.census.gov/programs-surveys/decennial/rdo/datasets/2023/2023-cvap/CVAP_2019-2023_ACS_csv_files.zip"
PUMS_URL = "https://www2.census.gov/programs-surveys/acs/data/pums/2023/5-Year/csv_p{usps}.zip"
TRACT_PUMA_URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/2020_Census_Tract_to_2020_PUMA.txt"
ACS_TABLES = ["b01001", "b15001", "b15002", "c15002b", "c15002d", "c15002h", "c15002i"]
CACHE = WORK / "acs"


# ---------- national tract extracts (parsed once, cached) ----------
def acs_table(t: str) -> pd.DataFrame:
    out = CACHE / f"{t}.csv.gz"
    if not out.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        f = sources.download(ACS_URL.format(t=t), RAW / "acs2023" / f"acsdt5y2023-{t}.dat")
        chunks = []
        for c in pd.read_csv(f, sep="|", dtype={"GEO_ID": str}, chunksize=200_000):
            c = c[c.GEO_ID.str.startswith("1400000US")]
            c = c[["GEO_ID"] + [k for k in c.columns if "_E" in k]]
            chunks.append(c)
        d = pd.concat(chunks)
        d["GEOID"] = d.pop("GEO_ID").str[9:]
        d.to_csv(out, index=False)
    return pd.read_csv(out, dtype={"GEOID": str}).set_index("GEOID")


def cvap_race() -> pd.DataFrame:
    """Tract CVAP by our 5 race groups (CVAP race lines are non-Hispanic; line 13 = Hispanic)."""
    out = CACHE / "cvap.csv.gz"
    if not out.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        z = sources.download(CVAP_URL, RAW / "acs2023" / "CVAP_2019-2023_ACS_csv_files.zip")
        with zipfile.ZipFile(z) as zf:
            d = pd.read_csv(io.BytesIO(zf.read("Tract.csv")), encoding="latin-1",
                            usecols=["geoid", "lnnumber", "cvap_est"], dtype={"geoid": str})
        d["GEOID"] = d.geoid.str[9:]
        group = {7: 0, 5: 1, 13: 2, 4: 3, 3: 4, 6: 4, 8: 4, 9: 4, 10: 4, 11: 4, 12: 4}
        d = d[d.lnnumber.isin(group)]
        d["race"] = d.lnnumber.map(group)
        d.pivot_table(index="GEOID", columns="race", values="cvap_est", aggfunc="sum", fill_value=0) \
            .reindex(columns=range(5), fill_value=0).to_csv(out)
    d = pd.read_csv(out, dtype={"GEOID": str}).set_index("GEOID")
    d.columns = d.columns.astype(int)
    return d


def tract_puma() -> pd.Series:
    f = sources.download(TRACT_PUMA_URL, RAW / "acs2023" / "2020_Census_Tract_to_2020_PUMA.txt")
    d = pd.read_csv(f, dtype=str, encoding="utf-8-sig")
    return pd.Series((d.STATEFP + d.PUMA5CE).values, index=(d.STATEFP + d.COUNTYFP + d.TRACTCE).values)


def pums_seed(usps: str) -> dict[str, np.ndarray]:
    """Weighted citizen-18+ counts per cell for each PUMA (key: state fips + PUMA)."""
    fips = sources.USPS_TO_FIPS[usps]
    z = sources.download(PUMS_URL.format(usps=usps.lower()), RAW / "acs2023" / "pums" / f"csv_p{usps.lower()}.zip")
    with zipfile.ZipFile(z) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".csv"))
        d = pd.read_csv(zf.open(name), usecols=["PUMA", "AGEP", "SEX", "RAC1P", "HISP", "SCHL", "CIT", "PWGTP"])
    d["SCHL"] = d.SCHL.fillna(0)
    d["cell"] = cells.pums_cells(d)
    d = d[d.cell >= 0]
    out = {}
    for puma, g in d.groupby("PUMA"):
        out[f"{fips}{int(puma):05d}"] = np.bincount(g.cell, weights=g.PWGTP, minlength=cells.N_CELLS)
    return out


# ---------- ACS targets ----------
def check_layouts(tabs: dict[str, pd.DataFrame]) -> None:
    """Fail loudly if a table's columns aren't laid out the way the parsers below assume:
    every total must equal the sum of its parts."""
    def eq(t, total, parts, name):
        T = t.upper()
        d = tabs[t]
        ok = (d[f"{T}_E{total:03d}"] == sum(d[f"{T}_E{i:03d}"] for i in parts)).all()
        assert ok, f"ACS layout mismatch: {name}"
    for off, sex in [(0, "male"), (41, "female")]:
        eq("b15001", 2 + off, [3 + off, 11 + off, 19 + off, 27 + off, 35 + off], f"B15001 {sex} age blocks")
        for b in [3, 11, 19, 27, 35]:
            eq("b15001", b + off, range(b + off + 1, b + off + 8), f"B15001 {sex} block {b}")
    eq("b01001", 2, range(3, 26), "B01001 male")
    eq("b01001", 26, range(27, 50), "B01001 female")
    eq("b15002", 2, range(3, 19), "B15002 male")
    eq("b15002", 19, range(20, 36), "B15002 female")
    for t in ["c15002b", "c15002d", "c15002h", "c15002i"]:
        eq(t, 2, range(3, 7), f"{t} male")
        eq(t, 7, range(8, 12), f"{t} female")


def b01001_age_sex(t: pd.DataFrame) -> np.ndarray:
    """[T, 4 ages, 2 sexes] population 18+ from B01001 (age by sex)."""
    bands = [range(7, 12), range(12, 15), range(15, 20), range(20, 26)]  # male columns; female = +24
    out = np.zeros((len(t), 4, 2))
    for a, cols in enumerate(bands):
        for s, off in enumerate([0, 24]):
            out[:, a, s] = t[[f"B01001_E{c + off:03d}" for c in cols]].sum(axis=1)
    return out


def b15001_college(t: pd.DataFrame) -> np.ndarray:
    """[T, 4 ages, 2 sexes, 2 edu] 18+ by college from B15001. Its age bands are 18-24/25-34/35-44/
    45-64/65+, so 25-34 is split evenly between our 18-29 and 30-44 bands."""
    starts = {"18-24": 3, "25-34": 11, "35-44": 19, "45-64": 27, "65+": 35}  # male; female = +41
    def block(k, s):
        b = starts[k] + 41 * s
        tot = t[f"B15001_E{b:03d}"].to_numpy(float)
        col = (t[f"B15001_E{b + 6:03d}"] + t[f"B15001_E{b + 7:03d}"]).to_numpy(float)
        return np.stack([tot - col, col], axis=-1)
    out = np.zeros((len(t), 4, 2, 2))
    for s in range(2):
        out[:, 0, s] = block("18-24", s) + 0.5 * block("25-34", s)
        out[:, 1, s] = 0.5 * block("25-34", s) + block("35-44", s)
        out[:, 2, s] = block("45-64", s)
        out[:, 3, s] = block("65+", s)
    return out


def race_college(tabs: dict[str, pd.DataFrame], idx) -> np.ndarray:
    """[T, 5 races, 2 sexes, 2 edu] 25+ by college. C15002: E002 male (E006 BA+), E007 female (E011)."""
    out = np.zeros((len(idx), 5, 2, 2))
    for race, t in [(0, "c15002h"), (1, "c15002b"), (2, "c15002i"), (3, "c15002d")]:
        d = tabs[t].reindex(idx).fillna(0)
        T = t.upper()
        for s, (tot, ba) in enumerate([(2, 6), (7, 11)]):
            col = d[f"{T}_E{ba:03d}"].to_numpy(float)
            out[:, race, s] = np.stack([d[f"{T}_E{tot:03d}"].to_numpy(float) - col, col], axis=-1)
    d = tabs["b15002"].reindex(idx).fillna(0)
    for s, (tot, ba) in enumerate([(2, range(15, 19)), (19, range(32, 36))]):
        col = d[[f"B15002_E{c:03d}" for c in ba]].sum(axis=1).to_numpy(float)
        all_ = np.stack([d[f"B15002_E{tot:03d}"].to_numpy(float) - col, col], axis=-1)
        out[:, 4, s] = np.clip(all_ - out[:, :4, s].sum(axis=1), 0, None)
    return out


# ---------- IPF ----------
def ipf(seed, race, age_sex, edu_age_sex, edu_race_sex, iters=40):
    """seed [T,4,5,2,2]; race [T,5] counts; age_sex [T,4,2] counts; edu_* = college shares."""
    x = seed.copy()
    for _ in range(iters):
        # college share within age x sex
        cur = x.sum(axis=2)  # [T,4,2(edu),2(sex)]
        tot = cur.sum(axis=2, keepdims=True)
        tgt = np.stack([1 - edu_age_sex, edu_age_sex], axis=2) * tot
        x *= np.where(cur > 0, tgt / np.where(cur > 0, cur, 1), 1)[:, :, None]
        # college share within race x sex
        cur = x.sum(axis=1)  # [T,5,2,2]
        tot = cur.sum(axis=2, keepdims=True)
        tgt = np.stack([1 - edu_race_sex, edu_race_sex], axis=2) * tot
        x *= np.where(cur > 0, tgt / np.where(cur > 0, cur, 1), 1)[:, None]
        # age x sex counts
        cur = x.sum(axis=(2, 3))  # [T,4,2]
        x *= np.where(cur > 0, age_sex / np.where(cur > 0, cur, 1), 1)[:, :, None, None, :]
        # race counts (last, so exact)
        cur = x.sum(axis=(1, 3, 4))  # [T,5]
        x *= np.where(cur > 0, race / np.where(cur > 0, cur, 1), 1)[:, None, :, None, None]
    return x


def acs_ids(usps: str, geoids: list[str]) -> pd.Index:
    """ACS row IDs for our (2020 Census) tracts. Connecticut's ACS 2019-2023 tables use 2022
    planning-region county codes; tract numbers are unchanged and unique statewide."""
    if usps != "CT":
        return pd.Index(geoids)
    acs = cvap_race().index
    by_tract = {g[5:]: g for g in acs[acs.str.startswith("09")] if not g[5:].startswith("99")}
    return pd.Index([by_tract.get(g[5:], g) for g in geoids])


def composition(usps: str, geoids: list[str]) -> np.ndarray:
    """[T, 80] estimated citizen voting-age population per cell."""
    idx = acs_ids(usps, geoids)
    tabs = {t: acs_table(t) for t in ACS_TABLES}
    check_layouts({t: d[d.index.str.startswith(sources.USPS_TO_FIPS[usps])] for t, d in tabs.items()})
    race = cvap_race().reindex(idx).fillna(0).to_numpy(float)
    cv = race.sum(axis=1)
    age_sex = b01001_age_sex(tabs["b01001"].reindex(idx).fillna(0))
    age_sex = age_sex / np.maximum(age_sex.sum(axis=(1, 2), keepdims=True), 1) * cv[:, None, None]
    e1 = b15001_college(tabs["b15001"].reindex(idx).fillna(0))
    edu_age_sex = e1[..., 1] / np.maximum(e1.sum(axis=-1), 1)
    e2 = race_college(tabs, idx)
    edu_race_sex = e2[..., 1] / np.maximum(e2.sum(axis=-1), 1)
    # fall back to the tract's overall college share where a race x sex group is absent
    overall = e1[..., 1].sum(axis=(1, 2)) / np.maximum(e1.sum(axis=(1, 2, 3)), 1)
    edu_race_sex = np.clip(np.where(e2.sum(axis=-1) > 0, edu_race_sex, overall[:, None, None]), 0, 1)
    edu_age_sex = np.clip(np.where(e1.sum(axis=-1) > 0, edu_age_sex, overall[:, None, None]), 0, 1)

    seeds = pums_seed(usps)
    state_seed = np.sum(list(seeds.values()), axis=0)
    puma = tract_puma()
    keys = [puma.get(g, "") for g in geoids]
    missing = sum(k not in seeds for k in keys)
    if missing:
        print(f"[{usps}] {missing}/{len(geoids)} tracts use the statewide PUMS mix (PUMA not in PUMS)")
    seed = np.stack([seeds.get(k, state_seed) for k in keys]).astype(float)
    seed = seed / np.maximum(seed.sum(axis=1, keepdims=True), 1) + 1e-4  # small floor: no cell is impossible
    x = ipf(seed.reshape(-1, *cells.SHAPE), race, age_sex, edu_age_sex, edu_race_sex)
    return x.reshape(len(geoids), cells.N_CELLS)


# ---------- calibration ----------
def solve_offset(base_logit, weights, target, lo=-12.0, hi=12.0, iters=60):
    """Per row, find k with sum(weights * sigmoid(base_logit + k)) = target (vectorized bisection)."""
    lo = np.full(len(target), lo)
    hi = np.full(len(target), hi)
    for _ in range(iters):
        mid = (lo + hi) / 2
        f = (weights * expit(base_logit + mid[:, None])).sum(axis=1)
        lo, hi = np.where(f < target, mid, lo), np.where(f < target, hi, mid)
    return (lo + hi) / 2


def calibrate(cvap, turnout, dem, votes_D, votes_R):
    """Per-tract offsets so cells reproduce real two-party votes. Returns voters[T,80], dem_votes[T,80]."""
    V = votes_D + votes_R
    tot = cvap.sum(axis=1)
    # CVAP is a survey estimate; where it can't hold the real vote count, scale it up
    cap = 0.97
    scale = np.where(V > cap * tot, V / np.maximum(cap * tot, 1e-9), 1.0)
    cvap = cvap * scale[:, None]
    # tracts with votes but no CVAP estimate: spread votes over the state's average mix
    empty = (cvap.sum(axis=1) <= 0) & (V > 0)
    if empty.any():
        mix = cvap[~empty].sum(axis=0) if (~empty).any() and cvap[~empty].sum() > 0 else np.ones(cvap.shape[1])
        cvap[empty] = mix / mix.sum() * (V[empty] / 0.6)[:, None]
    a = solve_offset(logit(turnout), cvap, V)
    voters = cvap * expit(logit(turnout) + a[:, None])
    b = solve_offset(logit(dem), voters, votes_D)
    demv = voters * expit(logit(dem) + b[:, None])
    voters[V <= 0] = 0
    demv[V <= 0] = 0
    return cvap, voters, demv


def tract_cd_split(usps: str) -> pd.DataFrame:
    out = WORK / usps / "tract_cd.csv"
    if not out.exists():
        import build_units
        b = build_units.load_blocks(usps)
        b.groupby(["tract", "cd"]).POP20.sum().rename("pop").reset_index() \
            .rename(columns={"tract": "GEOID"}).to_csv(out, index=False)
    return pd.read_csv(out, dtype={"GEOID": str, "cd": str})


def run(usps: str, force: bool) -> None:
    w = WORK / usps
    todo = [e for e in ELECTIONS if (w / "votes" / f"{e}.csv").exists()
            and (force or not (w / "demo" / f"{e}.npz").exists())]
    if not todo:
        print(f"[{usps}] demographics up to date")
        return
    tract_cd_split(usps)
    geoids = None
    for eid in todo:
        v = pd.read_csv(w / "votes" / f"{eid}.csv", dtype={"GEOID": str})
        if geoids is None:
            geoids = v.GEOID.tolist()
            cvap0 = composition(usps, geoids)
        v = v.set_index("GEOID").reindex(geoids).fillna(0)
        m = np.load(WORK / "ces" / f"{eid}.npz")
        si = list(m["states"]).index(usps)
        T = np.clip(m["turnout"][si], 0.01, 0.99)[None, :].repeat(len(geoids), 0)
        Dm = np.clip(m["dem"][si], 0.01, 0.99)[None, :].repeat(len(geoids), 0)
        cvap, voters, demv = calibrate(cvap0.copy(), T, Dm, v.D.to_numpy(float), v.R.to_numpy(float))
        (w / "demo").mkdir(exist_ok=True)
        np.savez_compressed(w / "demo" / f"{eid}.npz", geoid=np.array(geoids),
                            cvap=cvap.astype(np.float32), voters=voters.astype(np.float32),
                            dem=demv.astype(np.float32))
        err = np.abs(demv.sum(1) - v.D.to_numpy()).max()
        print(f"[{usps}] {eid}: {len(geoids)} tracts, CVAP {cvap.sum():.0f}, voters {voters.sum():.0f} "
              f"(real {v.D.sum() + v.R.sum():.0f}), max tract D error {err:.2f} votes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="+")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    for s in a.states:
        run(s.upper(), a.force)
