"""Check a pip --report against a minimum release age; suggest newest safe version.

Usage: python tools/pypi_age_check.py report.json [min_days]
Queries only https://pypi.org/pypi/<name>/json (read-only metadata).
"""
import json, sys, urllib.request, datetime as dt

report, min_days = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 14
cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=min_days)
bad = 0
for item in json.load(open(report))["install"]:
    name, ver = item["metadata"]["name"], item["metadata"]["version"]
    data = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{name}/json", timeout=30))
    def uploaded(v):
        files = data["releases"].get(v) or []
        times = [dt.datetime.fromisoformat(f["upload_time_iso_8601"].replace("Z", "+00:00")) for f in files]
        return min(times) if times else None
    t = uploaded(ver)
    ok = t is not None and t <= cutoff
    line = f"{'OK ' if ok else 'NEW'} {name}=={ver} uploaded {t:%Y-%m-%d}" if t else f"??? {name}=={ver}"
    if not ok:
        bad += 1
        safe = [(uploaded(v), v) for v in data["releases"] if uploaded(v) and uploaded(v) <= cutoff
                and not any(c in v for c in "abrcdev")]
        line += f"  -> newest safe: {max(safe)[1] if safe else 'NONE'}"
    print(line)
sys.exit(1 if bad else 0)
