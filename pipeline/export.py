"""Export map packs for the web app.

  us-house-current : 119th Congress districts
  us-house-fair    : ReCom-generated districts (states with a plan)

A map pack (web/static/maps/<id>/) = manifest.json + districts.geojson (geometry only) +
elections/<election>.json ({"results": {district_id: {"D": votes, "R": votes}}}) for every
election in sources.ELECTIONS with data. See MapManifest in web/src/lib/types.ts.

Usage: python export.py
"""
from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd
from shapely.geometry import mapping

import sources
from sources import ELECTIONS, PLANS, ROOT, WORK

MAPS = ROOT.parent / "web" / "static" / "maps"
SIMPLIFY_DEG = 0.002  # ~200 m; plenty for national/state zoom
PRECISION = 4



def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def round_coords(geom, nd=PRECISION):
    def rnd(c):
        return [round(c[0], nd), round(c[1], nd)]
    g = mapping(geom)
    if g["type"] == "Polygon":
        g["coordinates"] = [[rnd(c) for c in ring] for ring in g["coordinates"]]
    elif g["type"] == "MultiPolygon":
        g["coordinates"] = [[[rnd(c) for c in ring] for ring in poly] for poly in g["coordinates"]]
    return g


def write_pack(pack_id: str, gdf: gpd.GeoDataFrame, manifest: dict, results: dict[str, dict],
               extra: dict | None = None) -> None:
    out = MAPS / pack_id
    out.mkdir(parents=True, exist_ok=True)
    gdf = gdf.to_crs("EPSG:4326")
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True)
    feats = []
    for _, row in gdf.iterrows():
        props = {k: (None if pd.isna(v) else v) for k, v in row.drop("geometry").items()}
        feats.append({"type": "Feature", "properties": props, "geometry": round_coords(row.geometry)})
    (out / "districts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                      separators=(",", ":"), default=int))
    elections = []
    (out / "elections").mkdir(exist_ok=True)
    for eid, res in results.items():
        if not res:
            continue
        (out / "elections" / f"{eid}.json").write_text(json.dumps({"results": res}, separators=(",", ":")))
        meta = {k: v for k, v in ELECTIONS[eid].items() if not callable(v)}
        elections.append({"id": eid, "file": f"elections/{eid}.json", **meta})
    manifest = {"file": "districts.geojson", **manifest, "elections": elections}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for name, obj in (extra or {}).items():
        (out / name).write_text(json.dumps(obj, indent=1))
    size = (out / "districts.geojson").stat().st_size / 1e6
    print(f"{pack_id}: {len(feats)} features, {size:.1f} MB")


def common_manifest() -> dict:
    return {
        "projection": "albersUsa",
        "idProperty": "id",
        "labelProperty": "name",
        "groupProperty": "state",
        "seatsProperty": "seats",
        "bordersFile": "states.geojson",
    }


def write_borders(pack_ids: list[str]) -> None:
    """State outlines (dissolved from district boundaries), drawn as a non-clickable overlay."""
    cds = gpd.read_file(sources.cd119())
    cds = cds[cds.STATEFP.isin(sources.STATES)]
    st = cds.dissolve(by="STATEFP").reset_index().to_crs("EPSG:4326")
    st["geometry"] = st.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True)
    feats = [{"type": "Feature", "properties": {"state": sources.STATES[r.STATEFP][0]},
              "geometry": round_coords(r.geometry)} for r in st.itertuples()]
    text = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    for p in pack_ids:
        if (MAPS / p).exists():
            (MAPS / p / "states.geojson").write_text(text)
    print(f"state borders: {len(feats)} states, {len(text) / 1e6:.1f} MB")


def current_pack() -> list[str]:
    cds = gpd.read_file(sources.cd119())
    cds = cds[cds.STATEFP.isin(sources.STATES)]  # 50 states; drops DC & territories (non-voting)
    rows, built = [], []
    results: dict[str, dict] = {e: {} for e in ELECTIONS}
    for fips, (usps, sname) in sources.STATES.items():
        pop_csv = WORK / usps / "current_districts.csv"
        pop = pd.read_csv(pop_csv, dtype={"cd": str}).set_index("cd")["pop"] if pop_csv.exists() else None
        votes = {e: pd.read_csv(f, dtype={"cd": str}).set_index("cd")
                 for e in ELECTIONS if (f := WORK / usps / "current" / f"{e}.csv").exists()}
        if votes:
            built.append(usps)
        for _, r in cds[cds.STATEFP == fips].iterrows():
            n = int(r.CD119FP)
            did = f"{usps}-{'AL' if n == 0 else f'{n:02d}'}"
            rows.append({
                "id": did, "state": usps, "seats": 1,
                "name": f"{sname} {'At-Large' if n == 0 else ordinal(n)}",
                "pop": None if pop is None else int(pop[r.CD119FP]),
                "geometry": r.geometry,
            })
            for e, v in votes.items():
                results[e][did] = {"D": round(v.loc[r.CD119FP, "D"]), "R": round(v.loc[r.CD119FP, "R"])}
    write_pack("us-house-current", gpd.GeoDataFrame(rows, crs=cds.crs), {
        "id": "us-house-current",
        "name": "Current districts (119th Congress)",
        "description": "119th Congress (2025–2027) district boundaries, Census cartographic file.",
        **common_manifest(),
    }, results)
    return built


def fair_pack() -> list[str]:
    tr = gpd.read_file(sources.tracts())[["GEOID", "geometry"]]
    rows, reports, done = [], {}, []
    results: dict[str, dict] = {e: {} for e in ELECTIONS}
    for fips, (usps, sname) in sources.STATES.items():
        asg = PLANS / usps / "fair_assignment.csv"
        if not asg.exists():
            continue
        done.append(usps)
        units = gpd.read_file(WORK / usps / "tracts.gpkg", ignore_geometry=True)[["GEOID", "pop"]]
        a = pd.read_csv(asg, dtype={"GEOID": str})
        g = tr.merge(units, on="GEOID").merge(a, on="GEOID")
        d = g.dissolve(by="district", aggfunc={"pop": "sum"}, method="coverage")  # tracts tile without overlap
        votes = {e: pd.read_csv(f, dtype={"GEOID": str}).merge(a, on="GEOID").groupby("district")[["D", "R"]].sum()
                 for e in ELECTIONS if (f := WORK / usps / "votes" / f"{e}.csv").exists()}
        # Number districts north-to-south, then west-to-east, for stable readable labels
        c = d.to_crs("EPSG:5070").geometry.centroid
        order = sorted(d.index, key=lambda i: (-round(c[i].y / 50_000), c[i].x))
        k = len(d)
        for n, idx in enumerate(order, start=1):
            did = f"{usps}-{'AL' if k == 1 else f'{n:02d}'}"
            rows.append({
                "id": did, "state": usps, "seats": 1,
                "name": f"{sname} {'At-Large' if k == 1 else ordinal(n)} (fair)",
                "pop": int(d.loc[idx, "pop"]), "geometry": d.loc[idx, "geometry"],
            })
            for e, v in votes.items():
                if idx in v.index:
                    results[e][did] = {"D": round(v.loc[idx, "D"]), "R": round(v.loc[idx, "R"])}
        reports[usps] = json.loads((PLANS / usps / "fair_report.json").read_text())
    if not rows:
        print("us-house-fair: no states generated yet")
        return done
    gdf = gpd.GeoDataFrame(rows, crs=tr.crs)
    write_pack("us-house-fair", gdf, {
        "id": "us-house-fair",
        "name": "Fair districts (ReCom)",
        "description": "Partisan-blind districts generated with ReCom (GerryChain) on 2020 census tracts. "
                       "States not yet generated are absent.",
        "reportFile": "report.json",
        **common_manifest(),
    }, results, extra={"report.json": reports})
    return done


def write_index() -> None:
    packs = sorted(p.name for p in MAPS.iterdir() if (p / "manifest.json").exists())
    index = [{"id": p, "name": json.loads((MAPS / p / "manifest.json").read_text())["name"]} for p in packs]
    (MAPS / "index.json").write_text(json.dumps(index, indent=2))


if __name__ == "__main__":
    MAPS.mkdir(parents=True, exist_ok=True)
    current_pack()
    fair_pack()
    write_borders(["us-house-current", "us-house-fair"])
    write_index()
