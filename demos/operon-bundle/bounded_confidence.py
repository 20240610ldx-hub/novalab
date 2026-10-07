# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
#
# ---------------------------------------------------------------------------
# Curation (S line): reactive-clean edition of a Claude Science bundle notebook
#
# source: demos/operon-bundle/frames/OPERON-f9fa236d/00-python/notebook.ipynb
#   (Claude Science reproducibility bundle, frame f9fa236d, 1 agent, 18 cells)
# imported with the bridge importer (dogfood, scripts/convert-ipynb.ts):
#   cd bridge && pnpm exec tsx ../scripts/convert-ipynb.ts \
#       ../demos/operon-bundle/frames/OPERON-f9fa236d/00-python/notebook.ipynb \
#       ../demos/operon-bundle/bounded_confidence.py
# the raw import faithfully preserved Jupyter habits that violate NovaLab's
# single-assignment DAG (repeated `import os/numpy/time` per cell, fig/ax/axes
# reused across cells, loop vars leaking -> compile error
# "multiple definitions of 'os' (cells 0a13e8c3, 4ad0be09)").
# curation principles (science content and visual richness preserved):
#   1. single assignment: every top-level name is defined by exactly one cell;
#      all imports consolidated into the first cell (no per-cell re-imports);
#   2. Jupyter iteration chains folded into ONE marimo-style cell per figure:
#      `def _make_figN(): ... return figN` then `figN = _make_figN()`;
#      plt.close() stays inside the figure function; the host.view_image shim
#      cell is kept;
#   3. loop bodies that leaked generic names (eps, s, rows, t0, ax, ...) are
#      wrapped in per-cell helper functions -> loop vars are function-local;
#   4. host-injected claude-science helpers reconstructed locally as shims
#      (host.view_image, apply_figure_style, panel_letter); exploratory cells
#      (help()/dir() introspection, text-overlap QA prints) and the failed
#      warm-up replay cell were dropped, their science prints kept;
#   5. kernel cwd follows the notebook dir (novakernel load_file), so
#      bundle-relative paths resolve; the read-back cell reads the pristine
#      version-prefixed artifacts under outputs/ (globbed, e.g.
#      outputs/32e29f6e-ae3-sweep_eps.csv) with fallback to the fresh copies
#      the sweep cells write at the bundle root.
# original bundle stays untouched under frames/ (fidelity reference).
# ---------------------------------------------------------------------------

# %% [cell-id: a1b2c301]
import glob
import os
import sys
import time

import numpy as np
import pandas as pd

import matplotlib as mpl

mpl.use("Agg")  # headless kernel: figures are saved to file / captured inline
import matplotlib.pyplot as plt

import networkx as nx

# bundle root = kernel cwd (novakernel load_file chdirs to the notebook dir);
# bc_model.py lives beside this file, hence the sys.path guard.
if os.getcwd() not in sys.path:
    sys.path.insert(0, os.getcwd())
import bc_model as bc

# %% [cell-id: a1b2c302]
class _HostShim:
    def view_image(self, *a, **k):
        print("[view_image]", a[0] if a else "")


host = _HostShim()

# %% [cell-id: a1b2c303]
def apply_figure_style(frame="open", sizes=(9, 8, 7)):
    """Local reconstruction of the claude-science host-injected figure style.

    sizes = (titles, labels, ticks) point sizes; frame="open" drops the
    top/right spines; pale blue-grey canvas matches the bundle artifacts.
    """
    title, label, tick = sizes
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.size": label,
        "axes.titlesize": title,
        "axes.labelsize": label,
        "xtick.labelsize": tick,
        "ytick.labelsize": tick,
        "legend.fontsize": tick,
        "figure.facecolor": "#f6f9fc",
        "savefig.facecolor": "#f6f9fc",
        "axes.facecolor": "#f6f9fc",
        "axes.spines.top": frame != "open",
        "axes.spines.right": frame != "open",
    })


def panel_letter(ax, letter, dx=-0.1, dy=1.05):
    """Bold panel letter outside the top-left corner (axes-fraction offset)."""
    return ax.annotate(letter, xy=(dx, dy), xycoords="axes fraction",
                       fontsize=11, fontweight="bold", color="#111111",
                       ha="left", va="bottom", annotation_clip=False)


apply_figure_style(frame="open", sizes=(9, 8, 7))

# %% [cell-id: a1b2c304]
def _quick_sweep_report():
    """HK vs Deffuant on one initial condition — the bundle's model sanity run."""
    rng = np.random.default_rng(0)
    x0 = rng.random(200)
    for eps in (0.05, 0.15, 0.30):
        t0 = time.perf_counter()
        xf, st, _ = bc.hk_run(x0, eps)
        nc, neff, lf, cen, sz = bc.cluster_summary(xf)
        t1 = time.perf_counter()
        xd, rd, _ = bc.deffuant_run(x0, eps, rng=np.random.default_rng(1))
        ncd, neffd, lfd, _, _ = bc.cluster_summary(xd)
        print(f"eps={eps}: HK steps={st} nc={nc} neff={neff:.2f} lf={lf:.2f} centers={np.round(cen,3)} t={t1-t0:.2f}s "
              f"|| Deff rounds={rd} nc={ncd} neff={neffd:.2f} lf={lfd:.2f} t={time.perf_counter()-t1:.2f}s")


_quick_sweep_report()

# %% [cell-id: a1b2c305]
def _run_eps_sweep():
    """Threshold sweep: eps=0.01..0.50, N=400, 30 seeds, both models."""
    N, SEEDS = 400, 30
    EPS = np.round(np.arange(0.01, 0.505, 0.01), 3)
    rows = []
    t0 = time.perf_counter()
    for eps in EPS:
        for s in range(SEEDS):
            x0 = np.random.default_rng(1000 + s).random(N)
            xf, st, _ = bc.hk_run(x0, eps)
            nc, neff, lf, _, _ = bc.cluster_summary(xf)
            rows.append(dict(model="Hegselmann-Krause", eps=eps, seed=s, N=N,
                             n_clusters=nc, n_eff=neff, largest_frac=lf, steps=st))
            xd, rd, _ = bc.deffuant_run(x0, eps, mu=0.5, rounds=12000,
                                        rng=np.random.default_rng(5000 + s))
            ncd, neffd, lfd, _, _ = bc.cluster_summary(xd)
            rows.append(dict(model="Deffuant", eps=eps, seed=s, N=N,
                             n_clusters=ncd, n_eff=neffd, largest_frac=lfd, steps=rd))
    sweep_df = pd.DataFrame(rows)
    sweep_df.to_csv("sweep_eps.csv", index=False)
    agg_df = (sweep_df.groupby(["model", "eps"])
              .agg(n_eff=("n_eff", "mean"), n_eff_sd=("n_eff", "std"),
                   largest_frac=("largest_frac", "mean"),
                   p_consensus=("largest_frac", lambda v: (v > 0.95).mean()),
                   steps=("steps", "mean")).reset_index())
    agg_df.to_csv("sweep_eps_summary.csv", index=False)
    print(f"{len(sweep_df)} runs in {time.perf_counter()-t0:.1f}s")
    for m in agg_df.model.unique():
        a = agg_df[agg_df.model == m]
        thr = a[a.p_consensus >= 0.95].eps.min()
        print(m, "| consensus(>=95% of runs) from eps =", thr,
              "| n_eff at eps=0.05,0.10,0.20:",
              [round(float(a.loc[np.isclose(a.eps, e), "n_eff"].iloc[0]), 2) for e in (0.05, 0.10, 0.20)])
    return sweep_df, agg_df


sweep, agg = _run_eps_sweep()

# %% [cell-id: a1b2c306]
TOPO_ORDER = ["complete", "Erdos-Renyi", "Watts-Strogatz", "Barabasi-Albert"]


def make_graph(kind, N, k, seed):
    if kind == "complete":
        return None
    if kind == "Erdos-Renyi":
        return nx.gnm_random_graph(N, N * k // 2, seed=seed)
    if kind == "Watts-Strogatz":
        return nx.watts_strogatz_graph(N, k, 0.1, seed=seed)
    if kind == "Barabasi-Albert":
        return nx.barabasi_albert_graph(N, k // 2, seed=seed)


def _run_topology_sweep():
    """HK on four graphs with identical mean degree (N=200, k=8, 12 seeds)."""
    Nn, K, SEEDS_T = 200, 8, 12
    EPS_T = np.round(np.arange(0.025, 0.501, 0.025), 4)
    rows = []
    t0 = time.perf_counter()
    for kind in TOPO_ORDER:
        for s in range(SEEDS_T):
            G = make_graph(kind, Nn, K, 200 + s)
            A = None if G is None else bc.adjacency_with_self_loops(G, Nn)
            x0 = np.random.default_rng(1000 + s).random(Nn)
            for eps in EPS_T:
                xf, st, _ = bc.hk_run(x0, eps, A=A, max_steps=600)
                nc, neff, lf, _, _ = bc.cluster_summary(xf)
                rows.append(dict(topology=kind, eps=eps, seed=s, N=Nn, mean_degree=K,
                                 n_clusters=nc, n_eff=neff, largest_frac=lf, steps=st))
    topo_df = pd.DataFrame(rows)
    topo_df.to_csv("sweep_topology.csv", index=False)
    print("topology sweep", len(topo_df), f"{time.perf_counter()-t0:.0f}s")
    return topo_df


def _run_finite_size_sweep():
    """Finite-size behaviour of the consensus transition (HK, complete graph)."""
    rows = []
    t0 = time.perf_counter()
    for Nf, seeds in [(50, 40), (100, 40), (200, 40), (400, 30), (800, 20)]:
        for eps in np.round(np.arange(0.12, 0.351, 0.01), 3):
            for s in range(seeds):
                x0 = np.random.default_rng(7000 + s).random(Nf)
                xf, st, _ = bc.hk_run(x0, eps)
                nc, neff, lf, _, _ = bc.cluster_summary(xf)
                rows.append(dict(N=Nf, eps=eps, seed=s, n_clusters=nc, n_eff=neff,
                                 largest_frac=lf, steps=st))
    fs_df = pd.DataFrame(rows)
    fs_df.to_csv("sweep_finite_size.csv", index=False)
    print("finite-size sweep", len(fs_df), f"{time.perf_counter()-t0:.0f}s")
    print(fs_df.assign(cons=fs_df.largest_frac > 0.95).groupby("N")
          .apply(lambda d: d.groupby("eps").cons.mean().pipe(lambda v: v[v >= 0.95].index.min()),
                 include_groups=False))
    return fs_df


topo = _run_topology_sweep()
fs = _run_finite_size_sweep()

# %% [cell-id: a1b2c307]
def _scaling_report():
    # scaling coefficient a in  n_eff ~ a/eps  over the fragmented regime
    for m in ["Hegselmann-Krause", "Deffuant"]:
        d = sweep[(sweep.model == m) & (sweep.eps <= 0.15) & (sweep.eps >= 0.02)]
        g = d.groupby("eps").n_eff.mean()
        a = float(np.sum((1 / g.index.values) * g.values) / np.sum((1 / g.index.values) ** 2))
        resid = g.values - a / g.index.values
        print(m, f"a={a:.3f}  (1/a={1/a:.2f})  max|resid|={np.abs(resid).max():.2f}")
    print(agg[agg.model == "Hegselmann-Krause"].set_index("eps").steps.loc[[0.05, 0.15, 0.2, 0.26, 0.4]].round(1).to_dict())
    print(topo.groupby("topology").apply(lambda d: d.groupby("eps").largest_frac.mean().pipe(lambda v: v[v > 0.95].index.min()), include_groups=False).to_dict())
    print(topo[np.isclose(topo.eps, 0.3)].groupby("topology")[["n_eff", "largest_frac", "steps"]].mean().round(2).to_string())


_scaling_report()

# %% [cell-id: a1b2c308]
def _fit_inverse_eps():
    """1/eps law fits: n_clusters and n_eff over eps in [0.02, 0.15]."""
    fit_d = {}
    for m in ["Hegselmann-Krause", "Deffuant"]:
        for col in ["n_clusters", "n_eff"]:
            g = sweep[(sweep.model == m) & (sweep.eps.between(0.02, 0.15))].groupby("eps")[col].mean()
            a = float(np.sum((1 / g.index.values) * g.values) / np.sum((1 / g.index.values) ** 2))
            fit_d[(m, col)] = 1 / a
    print({f"{m[:4]}/{c}": round(v, 2) for (m, c), v in fit_d.items()})
    return fit_d


def _run_trajectories():
    """Opinion trajectories, N=200, for the three eps values of fig1."""
    x0t = np.random.default_rng(12).random(200)
    traj_d = {}
    for eps in EPS_TRAJ:
        _, st, T = bc.hk_run(x0t, eps, keep_traj=True)
        traj_d[("Hegselmann-Krause", eps)] = T
        _, rd, Td = bc.deffuant_run(x0t, eps, mu=0.5, rounds=12000, keep_every=10,
                                    rng=np.random.default_rng(3))
        traj_d[("Deffuant", eps)] = Td
        print(eps, "HK steps", st, "clusters", bc.cluster_summary(T[-1])[0],
              "| Deff rounds", rd, "clusters", bc.cluster_summary(Td[-1])[0],
              "neff", round(bc.cluster_summary(Td[-1])[1], 2))
    return traj_d


EPS_TRAJ = [0.06, 0.15, 0.30]
fit = _fit_inverse_eps()
traj = _run_trajectories()

# %% [cell-id: a1b2c309]
MODELS = ["Hegselmann-Krause", "Deffuant"]


def _make_fig1():
    plt.close("all")
    fig1, axes1 = plt.subplots(2, 3, figsize=(7.2, 4.4))
    for i, m in enumerate(MODELS):
        for j, eps in enumerate(EPS_TRAJ):
            ax = axes1[i, j]
            T = traj[(m, eps)]
            step = 10 if m == "Deffuant" else 1
            t = np.arange(T.shape[0]) * step
            ax.plot(np.where(t == 0, 0.5, t), T, lw=0.5, alpha=0.35, color="#3a4a6b")
            nc, neff, lf, cen, sz = bc.cluster_summary(T[-1])
            ax.set_xscale("log"); ax.set_xlim(0.5, max(t.max() * 1.6, 20))
            ax.set_ylim(-0.03, 1.03); ax.set_yticks([0, 0.5, 1])
            ax.text(0.97, 0.52, f"{nc} cluster{'s' if nc > 1 else ''}\nlargest {lf:.0%}",
                    transform=ax.transAxes, ha="right", va="center", fontsize=8,
                    bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none", alpha=0.85))
            if i == 0:
                ax.set_title(f"$\\varepsilon$ = {eps:.2f}", pad=6)
            if j == 0:
                ax.set_ylabel(f"{m}\n\nopinion")
                ax.set_xlabel("sweeps (one update per agent)")
            else:
                ax.set_yticklabels([])
            panel_letter(ax, "abcdef"[i * 3 + j], dx=-0.10 if j else -0.26, dy=1.04)
    fig1.suptitle("The confidence threshold $\\varepsilon$ sets how many opinion clusters survive:\n"
                  "fragmentation, then polarization, then consensus", y=1.005, fontsize=9)
    fig1.tight_layout(w_pad=0.6, h_pad=1.4)
    fig1.savefig("fig1_trajectories.png", dpi=300, bbox_inches="tight")
    return fig1


fig1 = _make_fig1()
host.view_image("fig1_trajectories.png", crop=(0.0, 0.45, 0.45, 1.0))
fig1  # 收尾裸表达式：触发内核 matplotlib 捕获 → run.mime image/png

# %% [cell-id: a1b2c30a]
def _make_fig2():
    plt.close("all")
    C = {"Hegselmann-Krause": "#1f5fa9", "Deffuant": "#d1702f"}
    fig2, ax2 = plt.subplots(1, 3, figsize=(7.6, 2.8))

    # --- (a) cluster count vs eps, log-log, with the 1/(2 eps) rule
    ax = ax2[0]
    for m in MODELS:
        a_ = agg[agg.model == m].sort_values("eps")
        ax.fill_between(a_.eps, a_.n_eff - a_.n_eff_sd, a_.n_eff + a_.n_eff_sd,
                        color=C[m], alpha=0.18, lw=0)
        ax.plot(a_.eps, a_.n_eff, color=C[m], lw=1.4, marker="o", ms=2.6)
    e = np.linspace(0.012, 0.52, 200)
    ax.plot(e, 1 / (2 * e), color="0.45", lw=1.0, ls="--")
    ax.set(xscale="log", yscale="log", ylim=(0.8, 30),
           xlabel="confidence threshold $\\varepsilon$", ylabel="surviving clusters (effective)")
    ax.set_xticks([0.02, 0.05, 0.1, 0.2, 0.5]); ax.set_xticklabels(["0.02", "0.05", "0.1", "0.2", "0.5"])
    ax.set_yticks([1, 2, 5, 10, 20]); ax.set_yticklabels(["1", "2", "5", "10", "20"]); ax.minorticks_off()
    ax.set_title("Cluster count follows a $1/\\varepsilon$ law", pad=6)
    ax.annotate("Deffuant", xy=(0.021, 17), color=C["Deffuant"], fontsize=8)
    ax.annotate("Hegselmann–Krause", xy=(0.034, 6.6), color=C["Hegselmann-Krause"], fontsize=8)
    ax.annotate("$1/(2\\varepsilon)$ rule", xy=(0.285, 1.85), color="0.35", fontsize=8)

    # --- (b) consensus probability vs eps for increasing N
    ax = ax2[1]
    fsg = (fs.assign(cons=fs.largest_frac > 0.95).groupby(["N", "eps"]).cons.mean().reset_index())
    Ns = sorted(fsg.N.unique())
    greys = plt.cm.Greys(np.linspace(0.45, 0.95, len(Ns)))
    for i, Nv in enumerate(Ns):
        d = fsg[fsg.N == Nv]
        ax.plot(d.eps, d.cons, color=greys[i], lw=1.3, marker="o", ms=2.4)
        ax.text(0.325, 0.70 - 0.095 * i, f"N = {Nv}", color=greys[i], fontsize=7.5, va="center")
    ax.set(xlim=(0.115, 0.385), ylim=(-0.04, 1.08), xlabel="confidence threshold $\\varepsilon$",
           ylabel="fraction of runs at consensus")
    ax.set_title("Larger crowds agree more easily", pad=6)

    # --- (c) time to converge
    ax = ax2[2]
    for m in MODELS:
        a_ = agg[agg.model == m].sort_values("eps")
        ax.plot(a_.eps, a_.steps, color=C[m], lw=1.4, marker="o", ms=2.6)
    hk = agg[agg.model == "Hegselmann-Krause"].sort_values("eps")
    k = hk.steps.idxmax()
    ax.annotate(f"peak at $\\varepsilon$ = {hk.loc[k,'eps']:.2f}", xy=(hk.loc[k, "eps"], hk.loc[k, "steps"]),
                xytext=(14, 16), textcoords="offset points", fontsize=7.5, color=C["Hegselmann-Krause"],
                arrowprops=dict(arrowstyle="-", color=C["Hegselmann-Krause"], lw=0.7))
    ax.annotate("Deffuant", xy=(0.30, 330), color=C["Deffuant"], fontsize=8)
    ax.annotate("Hegselmann–Krause", xy=(0.02, 3.6), color=C["Hegselmann-Krause"], fontsize=8)
    ax.set(yscale="log", ylim=(3, 4000), xlabel="confidence threshold $\\varepsilon$",
           ylabel="sweeps to convergence")
    ax.set_yticks([10, 100, 1000]); ax.set_yticklabels(["10", "100", "1k"]); ax.minorticks_off()
    ax.set_title("Pairwise mixing is ~100$\\times$ slower;\nHK slows near its transition", pad=6, fontsize=8.5)
    for i, a_ in enumerate(ax2):
        panel_letter(a_, "abc"[i], dx=-0.27, dy=1.07)
    fig2.tight_layout(w_pad=1.8)
    fig2.savefig("fig2_phase_diagram.png", dpi=300, bbox_inches="tight")
    print("HK max-steps eps:", float(hk.loc[k, "eps"]), "| Deffuant steps at eps 0.05/0.5:",
          [round(float(agg.loc[(agg.model == "Deffuant") & np.isclose(agg.eps, x), "steps"].iloc[0]), 0) for x in (0.05, 0.5)])
    return fig2


fig2 = _make_fig2()
fig2  # 收尾裸表达式：触发内核 matplotlib 捕获 → run.mime image/png

# %% [cell-id: a1b2c30b]
def _topology_summary():
    """Coarse-grid topology aggregates: consensus threshold per graph family."""
    tg_df = (topo.assign(cons=topo.largest_frac > 0.95)
             .groupby(["topology", "eps"])
             .agg(n_eff=("n_eff", "mean"), steps=("steps", "mean"),
                  p_cons=("cons", "mean")).reset_index())
    thr_c = {k: float(d[d.p_cons >= 0.95].eps.min()) for k, d in tg_df.groupby("topology")}
    print(thr_c, {k: round(v, 1) for k, v in tg_df[np.isclose(tg_df.eps, 0.3)].set_index("topology").steps.items()})
    return tg_df, thr_c


tg, thr_coarse = _topology_summary()

# %% [cell-id: a1b2c30c]
def _run_transition_sweep():
    """Refined transition window: eps=0.17..0.35, 24 seeds, HK, max_steps=1500."""
    Nn, K = 200, 8
    EPS_R = np.round(np.arange(0.17, 0.351, 0.01), 3)
    rows = []
    t0 = time.perf_counter()
    for kind in TOPO_ORDER:
        for s in range(24):
            G = make_graph(kind, Nn, K, 200 + s)
            A = None if G is None else bc.adjacency_with_self_loops(G, Nn)
            x0 = np.random.default_rng(1000 + s).random(Nn)
            for eps in EPS_R:
                xf, st, _ = bc.hk_run(x0, eps, A=A, max_steps=1500)
                nc, neff, lf, _, _ = bc.cluster_summary(xf)
                rows.append(dict(topology=kind, eps=eps, seed=s, N=Nn, mean_degree=K,
                                 n_clusters=nc, n_eff=neff, largest_frac=lf, steps=st))
    topo_r_df = pd.DataFrame(rows)
    topo_r_df.to_csv("sweep_topology_transition.csv", index=False)
    tr_df = (topo_r_df.assign(cons=topo_r_df.largest_frac > 0.95)
             .groupby(["topology", "eps"])
             .agg(p_cons=("cons", "mean"), n_eff=("n_eff", "mean")).reset_index())
    thr_d = {k: float(d[d.p_cons >= 0.95].eps.min()) for k, d in tr_df.groupby("topology")}
    half_d = {k: float(d[d.p_cons >= 0.5].eps.min()) for k, d in tr_df.groupby("topology")}
    print(f"{len(topo_r_df)} runs {time.perf_counter()-t0:.0f}s")
    print("all-runs:", thr_d)
    print("half-runs:", half_d)
    cross = tg.pivot(index="eps", columns="topology", values="n_eff")
    print(cross.round(2).to_string())
    return topo_r_df, tr_df, thr_d, half_d


topo_r, tr, thr, half = _run_transition_sweep()

# %% [cell-id: a1b2c30d]
def _make_fig3():
    plt.close("all")
    TC = {"complete": "0.45", "Erdos-Renyi": "#1f5fa9", "Watts-Strogatz": "#2d8a5e", "Barabasi-Albert": "#7a4ba0"}
    TL = {"complete": "complete graph", "Erdos-Renyi": "Erdős–Rényi",
          "Watts-Strogatz": "Watts–Strogatz", "Barabasi-Albert": "Barabási–Albert"}
    fig3, ax3 = plt.subplots(1, 3, figsize=(7.8, 2.9))
    for k in TOPO_ORDER:
        d = tg[tg.topology == k].sort_values("eps")
        sty = dict(color=TC[k], lw=1.4, marker="o", ms=2.6, ls="--" if k == "complete" else "-")
        ax3[0].plot(d.eps, d.n_eff, **sty); ax3[1].plot(d.eps, d.steps, **sty)
    ax3[0].set(xscale="log", yscale="log", ylim=(0.8, 40), xlabel="confidence threshold $\\varepsilon$",
               ylabel="surviving clusters (effective)")
    ax3[0].set_xticks([0.025, 0.05, 0.1, 0.2, 0.5]); ax3[0].set_xticklabels(["0.025", "0.05", "0.1", "0.2", "0.5"])
    ax3[0].set_yticks([1, 2, 5, 10, 20]); ax3[0].set_yticklabels(["1", "2", "5", "10", "20"]); ax3[0].minorticks_off()
    ax3[0].set_title("Sparse ties fragment more at low $\\varepsilon$,\nless near the transition", pad=6, fontsize=8.5)
    for k, xy in zip(TOPO_ORDER, [(0.245, 2.6), (0.245, 5.4), (0.245, 11.5), (0.245, 24)]):
        ax3[0].annotate(TL[k], xy=xy, color=TC[k], fontsize=7.5, ha="left")
    ax3[1].set(yscale="log", ylim=(2.5, 1500), xlim=(0.0, 0.53),
               xlabel="confidence threshold $\\varepsilon$", ylabel="sweeps to convergence")
    ax3[1].set_yticks([10, 100, 1000]); ax3[1].set_yticklabels(["10", "100", "1k"]); ax3[1].minorticks_off()
    ax3[1].set_title("Sparse topologies converge\n10–100$\\times$ slower", pad=6, fontsize=8.5)
    for k, xy, ha in zip(TOPO_ORDER, [(0.012, 3.4), (0.52, 19), (0.52, 450), (0.07, 700)],
                         ["left", "right", "right", "left"]):
        ax3[1].annotate(TL[k], xy=xy, color=TC[k], fontsize=7.5, ha=ha)

    y = np.arange(len(TOPO_ORDER))[::-1]
    for i, k in enumerate(TOPO_ORDER):
        ax3[2].plot([half[k], thr[k]], [y[i]] * 2, color=TC[k], lw=1.6, alpha=0.5, solid_capstyle="round")
        ax3[2].plot([half[k]], [y[i]], "o", color="white", mec=TC[k], mew=1.4, ms=5.5)
        ax3[2].plot([thr[k]], [y[i]], "o", color=TC[k], ms=5.5)
        ax3[2].annotate(f"{half[k]:.2f}–{thr[k]:.2f}", xy=(thr[k] + 0.006, y[i]), va="center",
                        fontsize=7.5, color=TC[k])
    ax3[2].set_yticks(y, [TL[k] for k in TOPO_ORDER], fontsize=7.5)
    ax3[2].set(xlim=(0.17, 0.345), ylim=(-0.6, 4.3), xticks=[0.18, 0.22, 0.26, 0.30],
               xlabel="confidence threshold $\\varepsilon$")
    ax3[2].set_title("Only random sparse ties lower\nthe consensus threshold", pad=6, fontsize=8.5)
    ax3[2].spines["left"].set_visible(False); ax3[2].tick_params(axis="y", length=0)
    ax3[2].annotate("half of runs\nat consensus", xy=(half["complete"], 3.08),
                    xytext=(half["complete"] - 0.004, 4.25),
                    fontsize=7, color="0.3", ha="center", va="top",
                    arrowprops=dict(arrowstyle="-", color="0.5", lw=0.6, shrinkB=4))
    ax3[2].annotate("all runs", xy=(thr["complete"], 3.08), xytext=(thr["complete"] + 0.004, 4.25),
                    fontsize=7, color="0.3", ha="center", va="top",
                    arrowprops=dict(arrowstyle="-", color="0.5", lw=0.6, shrinkB=4))
    panel_letter(ax3[0], "a", dx=-0.27, dy=1.07)
    panel_letter(ax3[1], "b", dx=-0.27, dy=1.07)
    panel_letter(ax3[2], "c", dx=-0.45, dy=1.07)
    fig3.tight_layout(w_pad=2.2)
    fig3.savefig("fig3_topology.png", dpi=300, bbox_inches="tight")
    return fig3


fig3 = _make_fig3()
fig3  # 收尾裸表达式：触发内核 matplotlib 捕获 → run.mime image/png

# %% [cell-id: a1b2c30e]
def _read_sweep_tables():
    """Read back the bundle artifacts and restate the headline results.

    outputs/ keeps version-prefixed artifact names (e.g.
    outputs/32e29f6e-ae3-sweep_eps.csv); the glob picks the pristine artifact
    and falls back to the fresh copy the sweep cells wrote at bundle root.
    """
    def _artifact(name):
        hits = sorted(glob.glob(f"outputs/*-{name}"))
        return hits[-1] if hits else name

    s = pd.read_csv(_artifact("sweep_eps.csv"))
    f = pd.read_csv(_artifact("sweep_finite_size.csv"))
    t1 = pd.read_csv(_artifact("sweep_topology.csv"))
    t2 = pd.read_csv(_artifact("sweep_topology_transition.csv"))
    cons = lambda d, q=0.95: (d.assign(c=d.largest_frac > 0.95).groupby("eps").c.mean()
                              .pipe(lambda v: v[v >= q].index.min()))
    print("eps* :", {m: round(float(cons(d)), 3) for m, d in s.groupby("model")})
    print("finite:", {int(n): round(float(cons(d)), 2) for n, d in f.groupby("N")})
    print("Deff steps 0.05/0.5:", [round(float(s[(s.model == "Deffuant") & np.isclose(s.eps, x)].steps.mean())) for x in (0.05, 0.5)])
    print("HK peak eps:", float(s[s.model == "Hegselmann-Krause"].groupby("eps").steps.mean().idxmax()))
    print("neff@0.05:", t1[np.isclose(t1.eps, 0.05)].groupby("topology").n_eff.mean().round(1).to_dict())
    print("steps@0.30:", t1[np.isclose(t1.eps, 0.30)].groupby("topology").steps.mean().round(1).to_dict())
    print("topo eps* all/half:", {k: (round(float(cons(d)), 2), round(float(cons(d, 0.5)), 2)) for k, d in t2.groupby("topology")})


_read_sweep_tables()
