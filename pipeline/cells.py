"""Demographic cells: age x race x education x sex x place (4 x 5 x 2 x 2 x 3 = 240), and how each
data source's codes map onto them.

The first four are traits of a person (an 80-way "person cell", estimated per tract by IPF); place
(urban / suburban / rural) is a trait of where they live, so every person in a tract shares the
tract's class (urbanicity.py). Cell index = person_cell * 3 + place, with
person_cell = ((age * 5 + race) * 2 + edu) * 2 + sex.
"""
from __future__ import annotations

import numpy as np

AGES = ["18-29", "30-44", "45-64", "65+"]
RACES = ["White", "Black", "Hispanic", "Asian", "Other"]  # White/Black/Asian/Other are non-Hispanic
EDUS = ["No college", "College"]                        # College = bachelor's degree or higher
SEXES = ["Men", "Women"]
PLACES = ["Urban", "Suburban", "Rural"]                 # self-described city / suburb / town or rural
PERSON_DIMS = {"age": AGES, "race": RACES, "edu": EDUS, "sex": SEXES}
DIMS = {**PERSON_DIMS, "place": PLACES}
ORDER = list(DIMS)
PERSON_SHAPE = (len(AGES), len(RACES), len(EDUS), len(SEXES))
N_PERSON = int(np.prod(PERSON_SHAPE))
SHAPE = (*PERSON_SHAPE, len(PLACES))
N_CELLS = int(np.prod(SHAPE))

REGIONS = {  # Census regions, by USPS
    "Northeast": "CT ME MA NH RI VT NJ NY PA",
    "Midwest": "IL IN MI OH WI IA KS MN MO NE ND SD",
    "South": "DE FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX",
    "West": "AZ CO ID MT NV NM UT WY AK CA HI OR WA",
}
REGION_OF = {s: i for i, (_, states) in enumerate(REGIONS.items()) for s in states.split()}


def person_index(age, race, edu, sex):
    return ((np.asarray(age) * 5 + np.asarray(race)) * 2 + np.asarray(edu)) * 2 + np.asarray(sex)


def cell_index(age, race, edu, sex, place):
    return person_index(age, race, edu, sex) * len(PLACES) + np.asarray(place)


def expand_places(person: np.ndarray, place: np.ndarray) -> np.ndarray:
    """[T, N_PERSON] person cells + [T] tract place class -> [T, N_CELLS], everyone in the tract's class."""
    out = np.zeros((len(person), N_PERSON, len(PLACES)))
    out[np.arange(len(person)), :, place] = person
    return out.reshape(len(person), N_CELLS)


def age_band(age):
    a = np.asarray(age)
    return np.select([a < 30, a < 45, a < 65], [0, 1, 2], 3)


def labels() -> list[dict]:
    """One dict per cell, in index order, e.g. {"age": "18-29", "race": "White", ..., "place": "Rural"}."""
    out = []
    for a in AGES:
        for r in RACES:
            for e in EDUS:
                for s in SEXES:
                    for p in PLACES:
                        out.append({"age": a, "race": r, "edu": e, "sex": s, "place": p})
    return out


# ---------- ACS PUMS person records ----------
def pums_cells(df):
    """Person-cell index for PUMS rows (citizens 18+ only; others -> -1).
    RAC1P: 1 White, 2 Black, 6 Asian, 7 NHPI, other codes -> Other. HISP > 1 = Hispanic.
    SCHL >= 21 = bachelor's or higher. SEX: 1 male, 2 female. CIT 5 = not a citizen."""
    hisp = df.HISP > 1
    race = np.select([hisp, df.RAC1P == 1, df.RAC1P == 2, df.RAC1P == 6], [2, 0, 1, 3], 4)
    idx = person_index(age_band(df.AGEP), race, (df.SCHL >= 21).astype(int), (df.SEX == 2).astype(int))
    ok = (df.AGEP >= 18) & (df.CIT != 5)
    return np.where(ok, idx, -1)


# ---------- CES survey ----------
def ces_cells(df, year: int, gender_col: str):
    """Cell index for CES rows (-1 if a dimension is unknown).
    race: 1 White 2 Black 3 Hispanic 4 Asian 5-8 other; hispanic == 1 -> Hispanic.
    educ: 5 four-year, 6 post-grad -> College. gender: 1 man, 2 woman (others -> -1).
    urbancity: 1 City -> Urban, 2 Suburb -> Suburban, 3 Town / 4 Rural area -> Rural, 5 Other -> -1."""
    hisp = (df.race == 3) | (df.hispanic == 1)
    race = np.select([hisp, df.race == 1, df.race == 2, df.race == 4], [2, 0, 1, 3], 4)
    sex = np.select([df[gender_col] == 1, df[gender_col] == 2], [0, 1], -1)
    place = np.select([df.urbancity == 1, df.urbancity == 2, df.urbancity.isin([3, 4])], [0, 1, 2], -1)
    age = year - df.birthyr
    idx = cell_index(age_band(age), race, (df.educ >= 5).astype(int), np.maximum(sex, 0), np.maximum(place, 0))
    return np.where((sex >= 0) & (place >= 0) & (age >= 18) & df.educ.notna(), idx, -1)
