"""Registry of raw data sources + a cached, allowlisted downloader.

Only fetches from hosts in ALLOWED_HOSTS. Downloads are data only (zip/shapefiles);
nothing downloaded is ever executed. Each file's sha256 is appended to
data/raw/SHA256SUMS so later runs can detect upstream changes.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
PLANS = ROOT / "plans"
ALLOWED_HOSTS = {"www2.census.gov", "dataverse.harvard.edu", "int.nyt.com", "www.usreligioncensus.org"}

# Current (119th Congress) district boundaries, cartographic (shoreline-clipped)
CD119_URL = "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cd119_500k.zip"
# 2020 census tracts, cartographic
TRACTS_URL = "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_tract_500k.zip"
# 2020 blocks per state; attribute POP20 = 2020 census population (P.L. 94-171)
BLOCKS_URL = "https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{fips}_tabblock20.zip"
# VEST 2020 precinct-level results (Harvard Dataverse, doi:10.7910/DVN/K7760H)
VEST_DATASET = "doi:10.7910/DVN/K7760H"
# MEDSL 2024 precinct returns by state (Harvard Dataverse, CC0) - tabular, used for statewide totals
MEDSL2024_DATASET = "doi:10.7910/DVN/NYTPDU"
DATAVERSE = "https://dataverse.harvard.edu"
# NYT 2024 presidential precinct map (github.com/nytimes/presidential-precinct-map-2024).
# License: NYT C-UDA, non-commercial, credit required.
NYT2024_URL = "https://int.nyt.com/newsgraphics/elections/map-data/2024/national/{usps}-precincts-with-results.geojson.gz"

STATES = {  # fips: (usps, name)
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"),
    "06": ("CA", "California"), "08": ("CO", "Colorado"), "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"), "16": ("ID", "Idaho"),
    "17": ("IL", "Illinois"), "18": ("IN", "Indiana"), "19": ("IA", "Iowa"), "20": ("KS", "Kansas"),
    "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"), "23": ("ME", "Maine"), "24": ("MD", "Maryland"),
    "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"), "28": ("MS", "Mississippi"),
    "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"), "32": ("NV", "Nevada"),
    "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"), "36": ("NY", "New York"),
    "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"), "40": ("OK", "Oklahoma"),
    "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"), "44": ("RI", "Rhode Island"), "45": ("SC", "South Carolina"),
    "46": ("SD", "South Dakota"), "47": ("TN", "Tennessee"), "48": ("TX", "Texas"), "49": ("UT", "Utah"),
    "50": ("VT", "Vermont"), "51": ("VA", "Virginia"), "53": ("WA", "Washington"), "54": ("WV", "West Virginia"),
    "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}
USPS_TO_FIPS = {v[0]: k for k, v in STATES.items()}


def download(url: str, dest: Path) -> Path:
    host = urllib.parse.urlparse(url).hostname
    if urllib.parse.urlparse(url).scheme != "https" or host not in ALLOWED_HOSTS:
        raise ValueError(f"refusing to download from non-allowlisted URL: {url}")
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "yayapms-pipeline"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        final_host = urllib.parse.urlparse(r.geturl()).hostname
        # Dataverse redirects file downloads to its S3 bucket; allow only that.
        if final_host not in ALLOWED_HOSTS and not final_host.endswith(".s3.amazonaws.com"):
            raise ValueError(f"unexpected redirect to {r.geturl()}")
        shutil.copyfileobj(r, f)
    tmp.rename(dest)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    with open(RAW / "SHA256SUMS", "a") as f:
        f.write(f"{digest}  {dest.relative_to(RAW)}  {url}\n")
    return dest


# 2020 U.S. Religion Census (ASARB): adherents per denomination per county (XLSX, read as XML)
RELIGION_URL = "https://www.usreligioncensus.org/sites/default/files/2023-06/2020_USRC_Group_Detail.xlsx"


def religion() -> Path:
    return download(RELIGION_URL, RAW / "religion2020" / "2020_USRC_Group_Detail.xlsx")


def cd119() -> Path:
    return download(CD119_URL, RAW / "cb_2024_us_cd119_500k.zip")


def tracts() -> Path:
    return download(TRACTS_URL, RAW / "cb_2020_us_tract_500k.zip")


def blocks(fips: str) -> Path:
    return download(BLOCKS_URL.format(fips=fips), RAW / "blocks" / f"tl_2020_{fips}_tabblock20.zip")


def dataverse_file(dataset: str, folder: str, name: str) -> Path:
    """Download one file of a Harvard Dataverse dataset by filename (index cached per folder)."""
    dest = RAW / folder / name
    if dest.exists():
        return dest
    index = RAW / folder / "index.json"
    if not index.exists():
        index.parent.mkdir(parents=True, exist_ok=True)
        url = f"{DATAVERSE}/api/datasets/:persistentId/?persistentId={dataset}"
        req = urllib.request.Request(url, headers={"User-Agent": "yayapms-pipeline"})
        with urllib.request.urlopen(req, timeout=60) as r:
            files = json.load(r)["data"]["latestVersion"]["files"]
        index.write_text(json.dumps({f["dataFile"]["filename"]: f["dataFile"]["id"] for f in files}, indent=1))
    ids = json.loads(index.read_text())
    if name not in ids:
        raise KeyError(f"{dataset} has no {name}")
    return download(f"{DATAVERSE}/api/access/datafile/{ids[name]}", dest)


def vest(usps: str) -> Path:
    return dataverse_file(VEST_DATASET, "vest2020", f"{usps.lower()}_2020.zip")


def nyt2024(usps: str) -> Path:
    return download(NYT2024_URL.format(usps=usps), RAW / "nyt2024" / f"{usps}-precincts-with-results.geojson.gz")


# ---------- elections ----------
# Each loader returns a GeoDataFrame of precincts with columns D, R (votes) and geometry,
# or raises Unavailable. To add an election, add an entry here; build_units.py and
# export.py pick it up.

class Unavailable(Exception):
    pass


def _load_vest2020(usps: str):
    import geopandas as gpd
    g = gpd.read_file(vest(usps))
    d = [c for c in g.columns if c.startswith("G20PRED")]
    r = [c for c in g.columns if c.startswith("G20PRER")]
    if len(d) != 1 or len(r) != 1:
        raise ValueError(f"ambiguous presidential columns: {d} {r}")
    return g.rename(columns={d[0]: "D", r[0]: "R"})[["D", "R", "geometry"]]


def _statewide_medsl2024(usps: str) -> tuple[float, float]:
    """Statewide 2024 presidential D/R totals from MEDSL (excludes under/over-vote rows)."""
    import pandas as pd
    lo = usps.lower()
    try:
        f = dataverse_file(MEDSL2024_DATASET, "medsl2024", f"2024-{lo}-precinct-general.tab")
    except KeyError:
        f = dataverse_file(MEDSL2024_DATASET, "medsl2024", f"2024-{lo}-precinct-general.csv")
    d = pd.read_csv(f, sep="\t" if f.suffix == ".tab" else ",", dtype=str)
    d = d[(d.office == "US PRESIDENT") & (d.stage == "GEN")
          & ~d.candidate.str.upper().isin(["UNDERVOTES", "OVERVOTES", "BLANK", "WRITEIN"])]
    v = pd.to_numeric(d.votes, errors="coerce").groupby(d.party_simplified).sum()
    return float(v.get("DEMOCRAT", 0)), float(v.get("REPUBLICAN", 0))


def _load_nyt2024(usps: str):
    import geopandas as gpd
    if usps == "AK":  # NYT: absentee/early votes reported district-wide; precinct data unusable
        raise Unavailable("NYT marks Alaska precinct data unusable")
    g = gpd.read_file(f"/vsigzip/{nyt2024(usps)}")
    return g.rename(columns={"votes_dem": "D", "votes_rep": "R"})[["D", "R", "geometry"]]


ELECTIONS = {
    "pres-2020": {
        "label": "2020 President",
        "candidates": {"D": "Biden", "R": "Trump"},
        "source": "VEST 2020 precinct results (Harvard Dataverse), allocated to 2020 census blocks by population",
        "load": _load_vest2020,
    },
    "pres-2024": {
        "label": "2024 President",
        "candidates": {"D": "Harris", "R": "Trump"},
        "source": "The New York Times 2024 presidential precinct map, allocated to 2020 census blocks by population. "
                  "Alaska (at-large): statewide MEDSL totals. Parts of OK and SD missing.",
        "credit": "2024 precinct data: The New York Times",
        "load": _load_nyt2024,
        # used when precinct data is unavailable in an at-large state (statewide total is exact there)
        "statewide": _statewide_medsl2024,
    },
}
