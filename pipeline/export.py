"""Export map packs for the web app.

  us-house-current : 119th Congress districts
  us-house-fair    : ReCom-generated districts (states with a plan)

A map pack (web/static/maps/<id>/) = manifest.json + districts.geojson (geometry only) +
elections/<election>.json ({"results": {district_id: {"D": votes, "R": votes}}}) for every
election in sources.ELECTIONS with data, plus per election its demographic cells
(<election>.cells.json header + <election>.cells.bin, sparse) and per pack local.json (local
factors per district and which districts border which). See MapManifest in web/src/lib/types.ts.

Usage: python export.py
"""
from __future__ import annotations

import json
import struct

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.special import expit, logit
from shapely.geometry import mapping

import cells

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


# ---------- demographic cells ----------
def tract_cells(usps: str, eid: str):
    """(geoids, [T, 3N] = cvap | voters | dem per cell) for a state, or None if not built."""
    f = WORK / usps / "demo" / f"{eid}.npz"
    if not f.exists():
        return None
    z = np.load(f)
    return list(z["geoid"]), np.concatenate([z["cvap"], z["voters"], z["dem"]], axis=1).astype(float)


def match_totals(c: np.ndarray, D: np.ndarray, R: np.ndarray) -> np.ndarray:
    """Re-calibrate district cell rows [districts, 3N] so voters and Dem votes sum to the real D, R."""
    from demographics import solve_offset
    n = cells.N_CELLS
    cv, vo, de = c[:, :n], c[:, n:2 * n], c[:, 2 * n:]
    t = np.clip(vo / np.maximum(cv, 1e-9), 1e-4, 1 - 1e-4)
    q = np.clip(de / np.maximum(vo, 1e-9), 1e-4, 1 - 1e-4)
    vo = cv * expit(logit(t) + solve_offset(logit(t), cv, D + R)[:, None])
    de = vo * expit(logit(q) + solve_offset(logit(q), vo, D)[:, None])
    return np.concatenate([cv, vo, de], axis=1)


def write_cells(out, eid: str, rows: dict[str, np.ndarray]) -> str:
    """Write <eid>.cells.json (header) + <eid>.cells.bin; returns the header's name.
    Binary, per region in header["regions"] order, little-endian: uint16 m = non-empty cells,
    then m uint16 cell indices, then m float32 values for each of header["fields"]."""
    bad = [k for k, v in rows.items() if not np.isfinite(v).all() or (v < -0.5).any()]
    assert not bad, f"invalid demographic cells (NaN/negative) for {bad[:10]}"
    n = cells.N_CELLS
    ids = sorted(rows)
    buf = bytearray()
    for k in ids:
        v = np.maximum(rows[k].reshape(3, n), 0)
        nz = np.flatnonzero(v[0] > 0.5)  # cells with any citizens of voting age
        buf += struct.pack("<H", len(nz)) + nz.astype("<u2").tobytes()
        buf += np.rint(v[:, nz]).astype("<f4").tobytes()
    (out / "elections" / f"{eid}.cells.bin").write_bytes(bytes(buf))
    header = {"dims": cells.DIMS, "order": cells.ORDER, "parties": ["D", "R"],
              "fields": ["cvap", "voters", "dem"], "regions": ids, "bin": f"{eid}.cells.bin"}
    name = f"elections/{eid}.cells.json"
    (out / name).write_text(json.dumps(header, separators=(",", ":")))
    return name


def district_factors(num, den) -> list[float]:
    """Factor shares for one district from its summed numerators and denominators."""
    return [round(float(a / b), 5) if b > 0 else 0.0 for a, b in zip(num, den)]


def neighbors(gdf: gpd.GeoDataFrame) -> dict[str, list[str]]:
    """District id -> ids of the districts it borders."""
    g = gdf.to_crs("EPSG:5070").reset_index(drop=True)
    g["geometry"] = g.geometry.buffer(50)
    pairs = gpd.sjoin(g[["id", "geometry"]], g[["id", "geometry"]], predicate="intersects")
    out: dict[str, list[str]] = {i: [] for i in g.id}
    for a, b in zip(pairs.id_left, pairs.id_right):
        if a != b:
            out[a].append(b)
    return {k: sorted(set(v)) for k, v in out.items()}


def local_table() -> pd.DataFrame:
    """Per tract: numerator and denominator columns of each local factor (local_factors.py)."""
    import local_factors
    return local_factors.load()


def lf_sums(lf: pd.DataFrame, geoids, keys, w: np.ndarray) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Weighted sums of the factor numerators / denominators per district key."""
    import local_factors
    ids = list(local_factors.factor_labels())
    rows = lf.loc[list(geoids)]
    num = pd.DataFrame(rows[[f"{i}_num" for i in ids]].to_numpy() * w[:, None], columns=ids)
    den = pd.DataFrame(rows[[f"{i}_den" for i in ids]].to_numpy() * w[:, None], columns=ids)
    num["k"] = list(keys)
    den["k"] = list(keys)
    return num.groupby("k").sum(), den.groupby("k").sum()


def write_pack(pack_id: str, gdf: gpd.GeoDataFrame, manifest: dict, results: dict[str, dict],
               extra: dict | None = None, cell_rows: dict[str, dict] | None = None,
               factors: dict[str, list[float]] | None = None) -> None:
    out = MAPS / pack_id
    out.mkdir(parents=True, exist_ok=True)
    import local_factors
    local = {"factors": [{"id": k, "label": v} for k, v in local_factors.factor_labels().items()],
             "values": factors or {}, "neighbors": neighbors(gdf)}
    (out / "local.json").write_text(json.dumps(local, separators=(",", ":")))
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
        entry = {"id": eid, "file": f"elections/{eid}.json", **meta}
        if cell_rows and cell_rows.get(eid):
            entry["cellsFile"] = write_cells(out, eid, cell_rows[eid])
        elections.append(entry)
    manifest = {"file": "districts.geojson", **manifest, "elections": elections, "localFile": "local.json"}
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
    cell_rows: dict[str, dict] = {e: {} for e in ELECTIONS}
    lf = local_table()
    factors: dict[str, list[float]] = {}
    for fips, (usps, sname) in sources.STATES.items():
        split_csv = WORK / usps / "tract_cd.csv"
        if split_csv.exists():
            sp = pd.read_csv(split_csv, dtype={"GEOID": str, "cd": str})
            sp["w"] = sp["pop"] / sp.groupby("GEOID")["pop"].transform("sum").replace(0, np.nan)
            sp["w"] = sp["w"].fillna(1 / sp.groupby("GEOID")["pop"].transform("size"))
            sp = sp[sp.GEOID.isin(lf.index)]
            num, den = lf_sums(lf, sp.GEOID, sp.cd, sp.w.to_numpy())
            for c in num.index:
                factors[f"{usps}-{'AL' if int(c) == 0 else f'{int(c):02d}'}"] = district_factors(num.loc[c], den.loc[c])
        for e in ELECTIONS:
            tc = tract_cells(usps, e)
            vf = WORK / usps / "current" / f"{e}.csv"
            if tc is None or not split_csv.exists() or not vf.exists():
                continue
            geoids, arr = tc
            sp = pd.read_csv(split_csv, dtype={"GEOID": str, "cd": str})
            sp["w"] = sp["pop"] / sp.groupby("GEOID")["pop"].transform("sum").replace(0, np.nan)
            sp["w"] = sp["w"].fillna(1 / sp.groupby("GEOID")["pop"].transform("size"))
            pos = {g: i for i, g in enumerate(geoids)}
            sp = sp[sp.GEOID.isin(pos)]
            cds_ = sorted(sp.cd.unique())
            agg = np.zeros((len(cds_), arr.shape[1]))
            np.add.at(agg, sp.cd.map({c: i for i, c in enumerate(cds_)}).to_numpy(),
                      arr[sp.GEOID.map(pos).to_numpy()] * sp.w.to_numpy()[:, None])
            v = pd.read_csv(vf, dtype={"cd": str}).set_index("cd").reindex(cds_).fillna(0)
            agg = match_totals(agg, v.D.to_numpy(float), v.R.to_numpy(float))
            for c, row in zip(cds_, agg):
                cell_rows[e][f"{usps}-{'AL' if int(c) == 0 else f'{int(c):02d}'}"] = row
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
    }, results, cell_rows=cell_rows, factors=factors)
    return built


def fair_pack() -> list[str]:
    tr = gpd.read_file(sources.tracts())[["GEOID", "geometry"]]
    rows, reports, done = [], {}, []
    results: dict[str, dict] = {e: {} for e in ELECTIONS}
    cell_rows: dict[str, dict] = {e: {} for e in ELECTIONS}
    lf = local_table()
    factors: dict[str, list[float]] = {}
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
        dist_of = dict(zip(a.GEOID, a.district))
        a_lf = a[a.GEOID.isin(lf.index)]
        fnum, fden = lf_sums(lf, a_lf.GEOID, a_lf.district, np.ones(len(a_lf)))
        tcells = {}
        for e in ELECTIONS:
            tc = tract_cells(usps, e)
            if tc is None:
                continue
            geoids, arr = tc
            keys = np.array([dist_of.get(g, -1) for g in geoids])
            tcells[e] = {k: arr[keys == k].sum(axis=0) for k in set(keys) if k != -1}
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
            for e, byd in tcells.items():
                if idx in byd:
                    cell_rows[e][did] = byd[idx]
            if idx in fnum.index:
                factors[did] = district_factors(fnum.loc[idx], fden.loc[idx])
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
    }, results, extra={"report.json": reports}, cell_rows=cell_rows, factors=factors)
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
