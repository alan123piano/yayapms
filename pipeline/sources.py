"""Registry of raw data sources + a cached, allowlisted downloader.

Only fetches from hosts in ALLOWED_HOSTS. Downloads are data only (zip/shapefiles);
nothing downloaded is ever executed. Each file's sha256 is appended to
data/raw/SHA256SUMS so later runs can detect upstream changes.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
PLANS = ROOT / "plans"
INPUTS = ROOT / "inputs"
ALLOWED_HOSTS = {"www2.census.gov", "dataverse.harvard.edu", "int.nyt.com", "www.usreligioncensus.org",
                 "www.fec.gov"}

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
# FEC "Federal Elections <year>" compilations: certified House results per candidate and district
FEC_HOUSE = {
    2020: ("https://www.fec.gov/resources/cms-content/documents/federalelections2020.xlsx", "13. US House Results by State"),
    2022: ("https://www.fec.gov/resources/cms-content/documents/federalelections2022.xlsx", "8. US House Results by State"),
}
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


def xlsx_rows(path, sheet: str):
    """Rows of one sheet of an .xlsx as lists of strings (stdlib only: an .xlsx is zipped XML)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as z:
        strings = [("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
                   for si in ET.parse(z.open("xl/sharedStrings.xml")).getroot()]
        wb = ET.parse(z.open("xl/workbook.xml")).getroot()
        rid = next(s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                   for s in wb.iter(f"{{{ns['m']}}}sheet") if s.get("name") == sheet)
        rels = ET.parse(z.open("xl/_rels/workbook.xml.rels")).getroot()
        target = next(r.get("Target") for r in rels if r.get("Id") == rid)
        with z.open(f"xl/{target}") as f:
            for _, el in ET.iterparse(f):
                if el.tag != f"{{{ns['m']}}}row":
                    continue
                row = {}
                for c in el:
                    v = c.find("m:v", ns)
                    if v is None:
                        continue
                    ref = re.match(r"[A-Z]+", c.get("r")).group()
                    row[ref] = strings[int(v.text)] if c.get("t") == "s" else v.text
                yield row
                el.clear()


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


# ---------- House vote totals (for inferred midterm elections) ----------
# Two-party House vote per state and nationally ("US"): {scope: (D, R, races)}, where races is the
# number of races counted (None for typed-in totals, which are taken as exact).

_DEM_LABELS = {"D", "DFL", "DNL", "N(D)", "W(D)"}
_REP_LABELS = {"R", "N(R)", "W(R)"}
# A state's own swing is trusted in proportion races / (races + SWING_PRIOR_RACES); the rest is the
# national swing. Keeps states with one or two contested races from swinging on a single candidate.
SWING_PRIOR_RACES = 4


def _major_party(label: str) -> str | None:
    """'D/WF' -> 'D', 'R*' -> 'R', 'W(D)/D' -> 'D', 'LIB' -> None (FEC party labels)."""
    parts = {t.strip().rstrip("*") for t in label.split("/")}
    if parts & _DEM_LABELS:
        return "D"
    if parts & _REP_LABELS:
        return "R"
    return None


def fec_house_contested(year: int) -> dict[str, tuple[float, float, int]]:
    """Two-party House vote over races with a Democrat and a Republican on the general ballot
    (unopposed seats would otherwise swamp the swing). All of a party's general-election candidates
    count (LA, AK multi-candidate generals); fusion lines (NY, CT) count toward the candidate's major
    party; special elections for unexpired terms are skipped."""
    url, sheet = FEC_HOUSE[year]
    f = download(url, RAW / "fec" / Path(url).name)
    votes: dict[tuple[str, str], dict[str, float]] = {}   # (usps, district) -> candidate -> GE votes
    party: dict[tuple[str, str], dict[str, str]] = {}     # (usps, district) -> candidate -> D/R
    for r in xlsx_rows(f, sheet):
        usps, dist, cand = r.get("B", ""), r.get("D", "").strip(), r.get("E", "n/a")
        m = re.match(r"\d\d", dist)
        if usps not in USPS_TO_FIPS or cand == "n/a" or "Unexpired" in dist or not m:
            continue
        try:
            v = float(r.get("P", ""))
        except ValueError:
            continue
        key = (usps, m.group())
        votes.setdefault(key, {}).setdefault(cand, 0.0)
        votes[key][cand] += v
        if (mp := _major_party(r.get("K", ""))) and v > 0:
            party.setdefault(key, {})[cand] = mp
    out: dict[str, list[float]] = {}
    for key, cands in party.items():
        d = sum(votes[key][c] for c, mp in cands.items() if mp == "D")
        r_ = sum(votes[key][c] for c, mp in cands.items() if mp == "R")
        if d > 0 and r_ > 0:  # skips unopposed and same-party (CA/WA top-two) races
            for scope in (key[0], "US"):
                acc = out.setdefault(scope, [0.0, 0.0, 0])
                acc[0] += d
                acc[1] += r_
                acc[2] += 1
    return {k: (v[0], v[1], int(v[2])) for k, v in out.items()}


def manual_house_votes(year: int) -> dict[str, tuple[float, float, None]]:
    """House votes typed in from published counts (inputs/house_votes.csv), for years without
    a certified machine-readable source yet."""
    with open(INPUTS / "house_votes.csv") as f:
        return {r["scope"]: (float(r["D"]), float(r["R"]), None) for r in csv.DictReader(f) if int(r["year"]) == year}


def state_swings(before: dict, after: dict) -> dict[str, float]:
    """Change in Democratic two-party share per state, shrunk toward the national change by the
    number of races behind it; states missing from either year get the national change."""
    share = lambda t: t[0] / (t[0] + t[1])
    national = share(after["US"]) - share(before["US"])
    out = {}
    for usps, _ in STATES.values():
        if usps not in after or usps not in before:
            out[usps] = national
            continue
        counts = [t[2] for t in (before[usps], after[usps]) if t[2] is not None]
        w = 1.0 if not counts else min(counts) / (min(counts) + SWING_PRIOR_RACES)
        out[usps] = w * (share(after[usps]) - share(before[usps])) + (1 - w) * national
    return out


# ---------- elections ----------
# Each loader returns a GeoDataFrame of precincts with columns D, R (votes) and geometry,
# or raises Unavailable. To add an election, add an entry here; build_units.py and
# export.py pick it up.
# An inferred election has "base" (an earlier election id) and "swing" (usps -> change in
# Democratic two-party share) instead of "load": every tract of the base election shifts by its
# state's swing. Bases must come before the elections inferred from them.

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
    "house-2022": {
        "label": "2022 House (inferred)",
        "candidates": {"D": "Democrats", "R": "Republicans"},
        "source": "2020 presidential results shifted per state by the 2020→2022 change in the Democratic "
                  "two-party share of the House vote (FEC certified results, races with both a Democrat and a "
                  "Republican). Turnout is 2020 presidential turnout.",
        "base": "pres-2020",
        "swing": lambda: state_swings(fec_house_contested(2020), fec_house_contested(2022)),
    },
    "house-2026": {
        "label": "2026 House (inferred, unofficial)",
        "candidates": {"D": "Democrats", "R": "Republicans"},
        "source": "2024 presidential results shifted by the 2024→2026 change in the Democratic two-party share "
                  "of the House vote; per state where pipeline/inputs/house_votes.csv has both years, else "
                  "national. 2026 counts are unofficial (see that file). Turnout is 2024 presidential turnout.",
        "base": "pres-2024",
        "swing": lambda: state_swings(manual_house_votes(2024), manual_house_votes(2026)),
    },
}
