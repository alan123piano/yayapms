#!/usr/bin/env bash
# Run the pipeline for all (or the given) states; finished work is skipped unless --force.
# Usage: ./run_all.sh [--force] [WI NC ...]      Logs: data/work/logs/
set -uo pipefail
cd "$(dirname "$0")"
PY=../.venv/bin/python
F=""
if [ "${1:-}" = "--force" ]; then F="--force"; shift; fi
STATES=${*:-$($PY -c "import sources;print(' '.join(v[0] for v in sources.STATES.values()))")}
# Cheap pending check (sources.py imports no heavy libraries), so a no-op run stays fast.
pending() {
  [ -n "$F" ] && { echo $STATES; return; }
  $PY - "$1" $STATES <<'PYEOF'
import sys, sources
step, states = sys.argv[1], sys.argv[2:]
def todo(s):
    w = sources.WORK / s
    if step == "build":
        return not (w / "tracts.gpkg").exists() or any(
            not (w / "votes" / f"{e}.csv").exists() and not (w / "votes" / f"{e}.unavailable").exists()
            for e in sources.ELECTIONS)
    if step == "demo":
        return any((w / "votes" / f"{e}.csv").exists() and not (w / "demo" / f"{e}.npz").exists()
                   for e in sources.ELECTIONS)
    return not (sources.PLANS / s / "fair_report.json").exists()
print(" ".join(s for s in states if todo(s)))
PYEOF
}
mkdir -p data/work/logs
export PY F
B=$(pending build); echo "== build units + elections: ${B:-nothing to do}"
[ -n "$B" ] && printf '%s\n' $B | xargs -P 3 -I{} sh -c '$PY build_units.py $F {} > data/work/logs/{}.build.log 2>&1 || echo "BUILD FAILED {}"'
G=$(pending generate); echo "== generate fair plans: ${G:-nothing to do}"
[ -n "$G" ] && printf '%s\n' $G | xargs -P 6 -I{} sh -c '$PY generate.py $F {} > data/work/logs/{}.gen.log 2>&1 || echo "GEN FAILED {}"'
echo "== survey model"; $PY ces_model.py $F 2>&1 | grep -vi warning
echo "== place classes"; $PY urbanicity.py $F
echo "== local factors"; $PY local_factors.py $F
D=$(pending demo); echo "== demographics: ${D:-nothing to do}"
[ -n "$D" ] && printf '%s\n' $D | xargs -P 3 -I{} sh -c '$PY demographics.py $F {} > data/work/logs/{}.demo.log 2>&1 || echo "DEMO FAILED {}"'
echo "== export"
$PY export.py 2>&1 | grep -vi warning
