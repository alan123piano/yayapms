"""Build per-state inputs: tract units (population) and per-election vote estimates.

Votes are estimated the same way for every election (as in Dave's Redistricting App):
  1. Each 2020 census block (with POP20) is located by its interior point.
  2. Each block is assigned to the precinct containing it, and to the current district.
  3. A precinct's votes are split across its blocks proportional to population.
  4. Blocks are summed to tracts (generator/fair-map units) and to current districts.

Usage: python build_units.py [--force] [--elections pres-2020,pres-2024] WI [NC ...]
Outputs (skipped if present unless --force), under data/work/<USPS>/:
  tracts.gpkg                 tract geometry + pop
  current_districts.csv       current district pop
  votes/<election>.csv        tract votes (GEOID, D, R)
  current/<election>.csv      current-district votes (cd, D, R)
"""
from __future__ import annotations

import argparse

import geopandas as gpd
import numpy as np
import pandas as pd

import sources
from sources import ELECTIONS, WORK

CRS = "EPSG:4269"  # NAD83, used by Census files


def assign_points(points: gpd.GeoDataFrame, polys: gpd.GeoDataFrame, key: str) -> pd.Series:
    """Point-in-polygon, falling back to nearest polygon for points that land in water/gaps."""
    hit = gpd.sjoin(points, polys[[key, "geometry"]], how="left", predicate="within")
    hit = hit[~hit.index.duplicated(keep="first")][key]
    missing = hit.isna()
    if missing.any():
        eq = "EPSG:5070"
        near = gpd.sjoin_nearest(points[missing].to_crs(eq), polys[[key, "geometry"]].to_crs(eq), how="left")
        hit.loc[missing] = near[~near.index.duplicated(keep="first")][key]
    return hit


def load_blocks(usps: str) -> gpd.GeoDataFrame:
    fips = sources.USPS_TO_FIPS[usps]
    b = gpd.read_file(sources.blocks(fips), ignore_geometry=True,
                      columns=["GEOID20", "POP20", "INTPTLAT20", "INTPTLON20"])
    b = gpd.GeoDataFrame(b, geometry=gpd.points_from_xy(b.INTPTLON20.astype(float), b.INTPTLAT20.astype(float)),
                         crs=CRS)
    cds = gpd.read_file(sources.cd119()).to_crs(CRS)
    b["cd"] = assign_points(b, cds[cds.STATEFP == fips], "CD119FP")
    b["tract"] = b.GEOID20.str[:11]
    return b


def build_units(usps: str, blocks: gpd.GeoDataFrame) -> None:
    out = WORK / usps
    fips = sources.USPS_TO_FIPS[usps]
    pop = blocks.groupby("tract").POP20.sum().rename("pop")
    tracts = gpd.read_file(sources.tracts())
    tracts = tracts[tracts.STATEFP == fips].to_crs(CRS)[["GEOID", "ALAND", "geometry"]]
    tracts = tracts.merge(pop, left_on="GEOID", right_index=True, how="left").fillna({"pop": 0})
    tracts = tracts[~((tracts["pop"] == 0) & (tracts.ALAND == 0))]  # pure water
    tracts.to_file(out / "tracts.gpkg", driver="GPKG")
    blocks.groupby("cd").POP20.sum().rename("pop").to_csv(out / "current_districts.csv")
    print(f"[{usps}] units: {len(tracts)} tracts, pop {int(pop.sum())}")


def build_election(usps: str, eid: str, blocks: gpd.GeoDataFrame) -> None:
    out = WORK / usps
    (out / "votes").mkdir(exist_ok=True)
    e = ELECTIONS[eid]
    try:
        prec = e["load"](usps).to_crs(CRS)
    except sources.Unavailable as err:
        if blocks.cd.nunique() != 1 or "statewide" not in e:
            print(f"[{usps}] {eid}: skipped ({err})")
            (out / "votes" / f"{eid}.unavailable").write_text(str(err))
            return
        # At-large state: the statewide total is the district result; spread by population for tracts.
        d, r = e["statewide"](usps)
        w = blocks.POP20 / blocks.POP20.sum()
        v = pd.DataFrame({"tract": blocks.tract, "cd": blocks.cd, "D": w * d, "R": w * r})
        print(f"[{usps}] {eid}: precincts unavailable ({err}); using statewide totals D={d:.0f} R={r:.0f}")
        prec = None
    if prec is not None:
        prec = prec.reset_index(drop=True)
        prec["prec_id"] = prec.index
        prec["geometry"] = prec.geometry.buffer(0)  # repair invalid rings common in precinct files
        pid = assign_points(blocks, prec, "prec_id")
        ppop = blocks.POP20.groupby(pid).transform("sum")
        pn = blocks.POP20.groupby(pid).transform("size")
        w = np.where(ppop > 0, blocks.POP20 / ppop.replace(0, 1), 1 / pn)
        v = pd.DataFrame({
            "tract": blocks.tract, "cd": blocks.cd,
            "D": w * pid.map(prec.D).fillna(0).to_numpy(),
            "R": w * pid.map(prec.R).fillna(0).to_numpy(),
        })
        lost = prec.loc[~prec.prec_id.isin(pid.unique()), ["D", "R"]].sum()
        print(f"[{usps}] {eid}: D={v.D.sum():.0f} R={v.R.sum():.0f} "
              f"(precincts D={prec.D.sum():.0f} R={prec.R.sum():.0f}; dropped D={lost.D:.0f} R={lost.R:.0f})")
    (out / "current").mkdir(exist_ok=True)
    v.groupby("tract")[["D", "R"]].sum().rename_axis("GEOID").to_csv(out / "votes" / f"{eid}.csv")
    v.groupby("cd")[["D", "R"]].sum().to_csv(out / "current" / f"{eid}.csv")


def pending_done(out, eid: str) -> bool:
    return (out / "votes" / f"{eid}.csv").exists() or (out / "votes" / f"{eid}.unavailable").exists()


def build(usps: str, elections: list[str], force: bool) -> None:
    out = WORK / usps
    out.mkdir(parents=True, exist_ok=True)
    need_units = force or not (out / "tracts.gpkg").exists()
    todo = [e for e in elections if force or not pending_done(out, e)]
    if not need_units and not todo:
        print(f"[{usps}] up to date")
        return
    blocks = load_blocks(usps)
    if need_units:
        build_units(usps, blocks)
    for e in todo:
        build_election(usps, e, blocks)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="+")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--elections", default=",".join(ELECTIONS))
    a = ap.parse_args()
    for s in a.states:
        build(s.upper(), a.elections.split(","), a.force)
