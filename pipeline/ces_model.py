"""Estimate turnout and two-party Democratic vote share for every state x demographic cell
from the Cooperative Election Study (validated vote).

Two weighted ridge logistic regressions per election:
  turnout:  P(voted | cell, state)         (validated vote record; unmatched = non-voter, per CES guide)
  vote:     P(Dem | cell, state, voted)    (self-reported, two-party)
Features: main effects and pairwise interactions of age/race/edu/sex, plus state, region x
demographic and state x race/edu effects. Penalties shrink sparse state-level effects toward
regional and national patterns. Tract calibration later fixes levels to real results, so what
matters most here is the *relative* pattern between groups within each state.

Usage: python ces_model.py [--force] [pres-2020 pres-2024]
Output: data/work/ces/<election>.npz with turnout[state, cell], dem[state, cell], states
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.optimize import minimize
from scipy.special import expit

import cells
import sources
from sources import WORK

USPS = [v[0] for v in sources.STATES.values()]
FIPS_NUM = {int(k): v[0] for k, v in sources.STATES.items()}

CES = {
    "pres-2020": {"dataset": "doi:10.7910/DVN/E9N6PH", "folder": "ces2020", "file": "CES20_Common_OUTPUT_vv.csv",
                  "year": 2020, "gender": "gender", "vote": "CC20_410", "dem": 1, "rep": 2,
                  "voted": lambda d: d.CL_2020gvm.between(1, 5)},
    "pres-2024": {"dataset": "doi:10.7910/DVN/X11EP6", "folder": "ces2024",
                  "file": "CCES24_Common_OUTPUT_vv_topost_final.csv",
                  "year": 2024, "gender": "gender4", "vote": "CC24_410", "dem": 1, "rep": 2,
                  "voted": lambda d: d.TS_g2024.between(1, 6)},
}

# (block name, penalty). Larger penalty = more shrinkage toward 0.
BLOCKS = [
    ("age", 0.1), ("race", 0.1), ("edu", 0.1), ("sex", 0.1),
    ("age*race", 1), ("age*edu", 1), ("age*sex", 1), ("race*edu", 1), ("race*sex", 1), ("edu*sex", 1),
    ("region*age", 2), ("region*race", 2), ("region*edu", 2),
    ("state", 3), ("state*race", 15), ("state*edu", 15),
]


def design(age, race, edu, sex, state, region) -> sp.csr_matrix:
    """Sparse one-hot design matrix (all levels kept; ridge handles identifiability) + intercept."""
    cols, offset, n = [], 0, len(age)
    sizes = {"age": 4, "race": 5, "edu": 2, "sex": 2, "state": 50, "region": 4}
    vals = {"age": age, "race": race, "edu": edu, "sex": sex, "state": state, "region": region}
    pen = [0.0]  # intercept
    rows = [np.arange(n)]
    cols.append(np.zeros(n, int))
    offset = 1
    for name, p in BLOCKS:
        parts = name.split("*")
        code = np.zeros(n, int)
        size = 1
        for part in parts:
            code = code * sizes[part] + vals[part]
            size *= sizes[part]
        rows.append(np.arange(n))
        cols.append(offset + code)
        pen += [p] * size
        offset += size
    r, c = np.concatenate(rows), np.concatenate(cols)
    return sp.csr_matrix((np.ones(len(r)), (r, c)), shape=(n, offset)), np.array(pen)


def fit(X: sp.csr_matrix, y: np.ndarray, w: np.ndarray, pen: np.ndarray) -> np.ndarray:
    w = w * (len(w) / w.sum())  # normalize weights to the sample size

    def loss(beta):
        z = X @ beta
        val = (w * (np.logaddexp(0, z) - y * z)).sum() + 0.5 * (pen * beta**2).sum()
        grad = X.T @ (w * (expit(z) - y)) + pen * beta
        return val, grad

    res = minimize(loss, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B", options={"maxiter": 2000})
    if not res.success:
        print("  warning:", res.message)
    return res.x


def all_cells_grid():
    """Design inputs for every (state, cell) pair, in [state][cell] order."""
    s, c = np.meshgrid(np.arange(50), np.arange(cells.N_CELLS), indexing="ij")
    s, c = s.ravel(), c.ravel()
    a, r, e, x = np.unravel_index(c, cells.SHAPE)
    reg = np.array([cells.REGION_OF[USPS[i]] for i in s])
    return a, r, e, x, s, reg


def run(eid: str) -> None:
    cfg = CES[eid]
    f = sources.dataverse_file(cfg["dataset"], cfg["folder"], cfg["file"])
    use = ["birthyr", cfg["gender"], "educ", "race", "hispanic", "inputstate", "cit1",
           "vvweight_post", "commonpostweight", cfg["vote"],
           "CL_2020gvm" if cfg["year"] == 2020 else "TS_g2024"]
    d = pd.read_csv(f, usecols=use, low_memory=False)
    d = d[(d.cit1 == 1) & d.inputstate.isin(FIPS_NUM.keys())].copy()
    d["cell"] = cells.ces_cells(d, cfg["year"], cfg["gender"])
    d = d[d.cell >= 0]
    d["st"] = d.inputstate.map({k: USPS.index(v) for k, v in FIPS_NUM.items()})
    d["reg"] = d.inputstate.map(lambda k: cells.REGION_OF[FIPS_NUM[k]])
    a, r, e, x = np.unravel_index(d.cell.to_numpy(), cells.SHAPE)

    out = {}
    grid = all_cells_grid()
    Xg, _ = design(*grid)
    # turnout: post-wave respondents with validated-vote weights
    t = d.vvweight_post.notna()
    X, pen = design(a[t], r[t], e[t], x[t], d.st[t].to_numpy(), d.reg[t].to_numpy())
    beta = fit(X, cfg["voted"](d[t]).to_numpy(float), d.vvweight_post[t].to_numpy(), pen)
    out["turnout"] = expit(Xg @ beta).reshape(50, cells.N_CELLS)
    # vote choice: two-party voters
    v = d[cfg["vote"]].isin([cfg["dem"], cfg["rep"]]) & d.commonpostweight.notna()
    X, pen = design(a[v], r[v], e[v], x[v], d.st[v].to_numpy(), d.reg[v].to_numpy())
    beta = fit(X, (d[cfg["vote"]][v] == cfg["dem"]).to_numpy(float), d.commonpostweight[v].to_numpy(), pen)
    out["dem"] = expit(Xg @ beta).reshape(50, cells.N_CELLS)

    (WORK / "ces").mkdir(parents=True, exist_ok=True)
    np.savez(WORK / "ces" / f"{eid}.npz", states=np.array(USPS), **out)
    print(f"{eid}: fit on {t.sum()} (turnout) / {v.sum()} (vote) respondents")


if __name__ == "__main__":
    force = "--force" in sys.argv
    for e in [a for a in sys.argv[1:] if a != "--force"] or list(CES):
        if not force and (WORK / "ces" / f"{e}.npz").exists():
            print(f"{e}: survey model up to date")
            continue
        run(e)
