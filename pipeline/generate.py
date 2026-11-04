"""Generate a partisan-blind "fair" congressional plan for a state with ReCom (GerryChain).

1. Build a tract adjacency graph (disconnected pieces, e.g. islands, are bridged to
   their nearest tract so every plan can be contiguous).
2. Seed with a random spanning-tree partition within the population tolerance.
3. Run a ReCom Markov chain. ReCom samples plans that are equal-population, contiguous,
   and favour compactness; it never looks at votes.
4. Select a plan from the post-burn-in samples:
   --select typical (default): the most compact plan (fewest cut edges) among plans
       whose 2020 seat outcome equals the ensemble's most common outcome. Votes only
       serve to keep the pick representative of neutral maps, never to target a result.
   --select compact: the most compact plan overall (fully vote-blind, but can land in
       the tail of the seat distribution).

Usage: python generate.py WI [--steps 2000] [--epsilon 0.01] [--seed 2020]
Outputs: plans/<USPS>/fair_assignment.csv, plans/<USPS>/fair_report.json
"""
from __future__ import annotations

import argparse
import json
import random
from functools import partial
import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
from gerrychain import Graph, MarkovChain, Partition, accept, constraints, updaters
from gerrychain.proposals import recom
from gerrychain.tree import recursive_seed_part, recursive_tree_part

from sources import PLANS, WORK

SELECT_ELECTION = "pres-2020"
EQ = "EPSG:5070"


def connect_components(graph: Graph, gdf: gpd.GeoDataFrame) -> int:
    """Add edges so the graph is connected (islands -> nearest tract in the largest component)."""
    added = 0
    while True:
        comps = sorted(nx.connected_components(graph), key=len, reverse=True)
        if len(comps) == 1:
            return added
        main = gdf.loc[list(comps[0])]
        for comp in comps[1:]:
            piece = gdf.loc[list(comp)]
            d = piece.geometry.apply(lambda g: main.distance(g))
            i, j = np.unravel_index(np.nanargmin(d.to_numpy()), d.shape)
            u, v = piece.index[i], main.index[j]
            graph.add_edge(u, v, shared_perim=0)
            added += 1


def seed_plan(graph: Graph, k: int, ideal: float, epsilon: float, tries: int = 5) -> dict:
    """Initial plan within tolerance. Recursive tree splitting can get stuck on coarse units
    in states with many districts (e.g. CA), so retry, then fall back to recursive_seed_part,
    which splits into balanced chunks first."""
    for attempt in range(tries):
        try:
            return recursive_tree_part(graph, range(k), ideal, "pop", epsilon, node_repeats=2)
        except RuntimeError as e:
            print(f"  seed attempt {attempt + 1} failed: {e}")
    print("  falling back to recursive_seed_part")
    return recursive_seed_part(graph, range(k), ideal, "pop", epsilon, node_repeats=2)


def run(usps: str, steps: int, epsilon: float, seed: int, burn_in: int, select: str) -> None:
    random.seed(seed)
    np.random.seed(seed)
    work = WORK / usps
    out = PLANS / usps
    out.mkdir(parents=True, exist_ok=True)
    gdf = gpd.read_file(work / "tracts.gpkg").to_crs(EQ)
    # Votes are only used to pick a representative plan (--select typical), never by ReCom itself.
    votes = pd.read_csv(work / "votes" / f"{SELECT_ELECTION}.csv", dtype={"GEOID": str})
    gdf = gdf.drop(columns=["dem", "rep"], errors="ignore").merge(
        votes.rename(columns={"D": "dem", "R": "rep"}), on="GEOID", how="left").fillna({"dem": 0, "rep": 0})
    gdf = gdf.reset_index(drop=True)
    k = int(len(pd.read_csv(work / "current_districts.csv", dtype={"cd": str})))
    if k == 1:
        print(f"[{usps}] at-large state; fair plan = whole state")
        gdf[["GEOID"]].assign(district=0).to_csv(out / "fair_assignment.csv", index=False)
        tot = gdf[["pop", "dem", "rep"]].sum()
        (out / "fair_report.json").write_text(json.dumps({
            "state": usps, "seats": 1, "method": "at-large",
            "chosen": {"dem_seats_2020": int(tot.dem > tot.rep)},
            "ensemble": {"dem_seats_2020": {str(int(tot.dem > tot.rep)): 1}}}, indent=1))
        return

    graph = Graph.from_geodataframe(gdf, ignore_errors=True)
    bridged = connect_components(graph, gdf)
    ideal = gdf["pop"].sum() / k
    print(f"[{usps}] {len(gdf)} tracts, {k} districts, ideal pop {ideal:.0f}, bridged {bridged} islands")

    ups = {
        "population": updaters.Tally("pop", alias="population"),
        "dem": updaters.Tally("dem", alias="dem"),
        "rep": updaters.Tally("rep", alias="rep"),
        "cut_edges": updaters.cut_edges,
    }
    seed_assignment = seed_plan(graph, k, ideal, epsilon)
    init = Partition(graph, seed_assignment, ups)

    proposal = partial(recom, pop_col="pop", pop_target=ideal, epsilon=epsilon, node_repeats=2)
    chain = MarkovChain(
        proposal=proposal,
        constraints=[constraints.within_percent_of_ideal_population(init, epsilon)],
        accept=accept.always_accept,
        initial_state=init,
        total_steps=steps,
    )

    def dem_seats(p: Partition) -> int:
        return sum(p["dem"][d] > p["rep"][d] for d in p.parts)

    best_by_seats: dict[int, tuple[int, dict]] = {}  # seats -> (cut_edges, assignment)
    seats_hist: dict[int, int] = {}
    for i, part in enumerate(chain):
        if i < burn_in:
            continue
        s = dem_seats(part)
        seats_hist[s] = seats_hist.get(s, 0) + 1
        cut = len(part["cut_edges"])
        if s not in best_by_seats or cut < best_by_seats[s][0]:
            best_by_seats[s] = (cut, dict(part.assignment))
        if i % 500 == 0:
            print(f"  step {i}: cut_edges={cut}")

    if select == "typical":
        mode = max(seats_hist, key=lambda s: (seats_hist[s], -abs(s - k / 2)))
        best_cut, assignment = best_by_seats[mode]
    else:
        best_cut, assignment = min(best_by_seats.values(), key=lambda t: t[0])
    best = Partition(graph, assignment, ups)
    gdf["district"] = gdf.index.map(assignment)
    gdf[["GEOID", "district"]].to_csv(out / "fair_assignment.csv", index=False)

    pops = list(best["population"].values())
    tot = gdf[["dem", "rep"]].sum()
    report = {
        "state": usps,
        "seats": k,
        "method": "recom",
        "params": {"steps": steps, "burn_in": burn_in, "epsilon": epsilon, "seed": seed, "units": "2020 tracts", "select": select},
        "statewide_dem_share_2020": round(tot.dem / (tot.dem + tot.rep), 4),
        "chosen": {
            "cut_edges": best_cut,
            "max_pop_deviation": round(max(abs(p - ideal) / ideal for p in pops), 4),
            "dem_seats_2020": dem_seats(best),
        },
        "ensemble": {"samples": sum(seats_hist.values()), "dem_seats_2020": dict(sorted(seats_hist.items()))},
    }
    (out / "fair_report.json").write_text(json.dumps(report, indent=1, default=int))
    print(json.dumps(report, indent=1, default=int))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="+")
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--burn-in", type=int, default=500)
    ap.add_argument("--epsilon", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=2020)
    ap.add_argument("--select", choices=["typical", "compact"], default="typical")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    for s in a.states:
        if not a.force and (PLANS / s.upper() / "fair_report.json").exists():
            print(f"[{s.upper()}] plan exists (use --force to regenerate)")
            continue
        run(s.upper(), a.steps, a.epsilon, a.seed, a.burn_in, a.select)
