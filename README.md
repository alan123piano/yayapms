# yayapms

A YAPMS-style interactive House map with pluggable map packs and a partisan-blind
"fair districts" generator.

```
pipeline/   Python: download Census + VEST data, build tract units, generate ReCom plans, export map packs
web/        SvelteKit app (static): render packs, click ratings, uniform-swing simulation, compare maps
tools/      Supply-chain helpers (package age checks)
```

## Quick start

```sh
make setup            # install pinned deps (first time only)
make                  # run the app -> http://localhost:5173
make data             # finish any missing states + rebuild map files
make data S="TX NC"   # recompute specific states
make audit            # supply-chain checks
```

In the app: pick a color in the legend, click districts to paint (click again to cycle
Safe → Likely → Lean → Tilt), right-click to reset. Scroll/drag/pinch to zoom and pan,
"Jump to state" to fly to a state, Esc or "← United States" to come back.

## Regenerate data

`make data` wraps these:

```sh
pipeline/run_all.sh                 # only does missing work; with plans/ present this is just the export
pipeline/run_all.sh --force TX NC   # recompute specific states (raw downloads stay cached)
```

Generated plans live in `pipeline/plans/<STATE>/` (`fair_assignment.csv` = tract -> district,
`fair_report.json` = ensemble stats). They are small (~2 MB total), tracked in git, and are the
only expensive output: `export.py` rebuilds the web map packs from them in ~15 s.
Runs are deterministic (fixed seed + pinned versions), so `--force` reproduces the same plans.
The full from-scratch run took ~1 h on 20 cores (downloads ~6 GB, cached in `pipeline/data/raw/`).

Steps per state:
1. `build_units.py`: tract populations, then for each election in `sources.ELECTIONS`
   (2020: VEST, 2024: NYT) precinct votes split to 2020 census blocks by population and summed
   to tracts and current districts. Add an election = add a registry entry + `make data`.
   House 2022/2026 are inferred: the 2020/2024 presidential map shifted by each state's House swing
   (FEC certified results for 2022; hand-entered `pipeline/inputs/house_votes.csv` for 2026).
2. `generate.py`: ReCom Markov chain (GerryChain) on the tract graph, ±1% population,
   contiguous, vote-blind proposals. Picks the most compact plan with the ensemble's most common
   2020 seat outcome (`--select typical`, default) or the most compact overall (`--select compact`).
3. `export.py`: dissolve + simplify into `web/static/maps/us-house-{current,fair}/`.

### Caveats
- Units are census tracts, so population deviation is up to ±1% (real plans use blocks, ±1 person).
- The "current" map is the 119th Congress (Jan 2025) Census file; states that redrew mid-decade
  for 2026 (e.g. TX, CA) are not reflected until a newer Census CD file is swapped in.
- The fair generator does not model the Voting Rights Act (no majority-minority constraints),
  county/city splitting, or communities of interest.
- Elections are presidential two-party votes; the swing is uniform. Not a candidate-level forecast.
- House 2022/2026 are presidential geography + a state-level House swing, not real House returns
  (no candidate effects, presidential turnout). 2026 uses unofficial national counts until state
  totals are added to `pipeline/inputs/house_votes.csv` (needs both 2024 and 2026 rows per state).
- 2024: no Alaska data (NYT), parts of OK and SD missing. NYT data is non-commercial, credit required.

## Supply-chain policy
- npm: `web/.npmrc` pins `before=` (≥14 days old) and `ignore-scripts=true`; exact versions.
  To upgrade, move the date and pick versions with `node tools/npm_safe_versions.mjs 14 <pkgs>`
  (`npm view` ignores `before=`).
- Python: everything pinned in `pipeline/requirements.lock` (transitive included);
  verify with `pip install --dry-run --report r.json ...` and `tools/pypi_age_check.py r.json`.
- Data downloads are limited to an allowlist (census.gov, Harvard Dataverse, fec.gov, ...) and hashed to
  `pipeline/data/raw/SHA256SUMS`. Nothing downloaded is executed.
- App ships a strict CSP (same-origin scripts/data only); imported files are parsed as JSON.
