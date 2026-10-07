"""Bounded-confidence opinion dynamics: Hegselmann-Krause and Deffuant.

Opinions live in [0, 1]. Interaction is restricted to agents whose opinions
differ by at most the confidence threshold eps (and, optionally, who are
adjacent on a social network).
"""
import numpy as np

CLUSTER_TOL = 1e-2  # opinion gap above which two groups count as distinct


# ---------------------------------------------------------------- observables
def cluster_summary(x, tol=CLUSTER_TOL):
    """Count opinion clusters in a converged profile.

    Returns (n_clusters, n_eff, largest_frac, centers, sizes) where n_eff is the
    inverse-Simpson effective number of clusters -- robust to tiny stragglers.
    """
    xs = np.sort(x)
    cuts = np.flatnonzero(np.diff(xs) > tol) + 1
    groups = np.split(xs, cuts)
    sizes = np.array([len(g) for g in groups], dtype=float)
    centers = np.array([g.mean() for g in groups])
    p = sizes / sizes.sum()
    return len(groups), 1.0 / np.sum(p ** 2), p.max(), centers, sizes


# ------------------------------------------------------- Hegselmann-Krause
def hk_run(x0, eps, A=None, max_steps=1000, tol=1e-9, keep_traj=False):
    """Synchronous HK: each agent moves to the mean of its eps-neighbourhood.

    A : boolean (N, N) adjacency WITH self-loops, or None for a complete graph.
    Returns (x_final, n_steps, traj) ; traj is None unless keep_traj.
    """
    x = np.asarray(x0, dtype=float).copy()
    traj = [x.copy()] if keep_traj else None
    steps = 0
    for steps in range(1, max_steps + 1):
        D = np.abs(x[:, None] - x[None, :]) <= eps
        if A is not None:
            D &= A
        xn = (D @ x) / D.sum(axis=1)
        delta = np.max(np.abs(xn - x))
        x = xn
        if keep_traj:
            traj.append(x.copy())
        if delta < tol:
            break
    return x, steps, (np.array(traj) if keep_traj else None)


# ------------------------------------------------------------------ Deffuant
def deffuant_run(x0, eps, mu=0.5, rounds=4000, rng=None, edge_list=None,
                 tol=1e-9, keep_every=0):
    """Deffuant: random pairs compromise by a fraction mu if within eps.

    One "round" updates N/2 disjoint random pairs (complete graph) or N/2
    randomly drawn network edges, so rounds are comparable to HK time steps.
    Returns (x_final, n_rounds, traj_or_None).
    """
    rng = np.random.default_rng() if rng is None else rng
    x = np.asarray(x0, dtype=float).copy()
    N = len(x)
    npair = N // 2
    traj = [x.copy()] if keep_every else None
    r = 0
    win_max = 0.0
    for r in range(1, rounds + 1):
        if edge_list is None:
            perm = rng.permutation(N)
            i, j = perm[:npair], perm[npair:2 * npair]
        else:
            e = edge_list[rng.integers(0, len(edge_list), npair)]
            i, j = e[:, 0], e[:, 1]
        d = x[j] - x[i]
        act = np.abs(d) <= eps
        step = mu * d * act
        xn = x.copy()
        xn[i] += step
        xn[j] -= step
        win_max = max(win_max, np.max(np.abs(xn - x)))
        x = xn
        if keep_every and r % keep_every == 0:
            traj.append(x.copy())
        if r % 100 == 0:
            if win_max < tol:   # nothing moved anywhere in the last 100 rounds
                break
            win_max = 0.0
    return x, r, (np.array(traj) if keep_every else None)


# ------------------------------------------------------------------ helpers
def adjacency_with_self_loops(G, N):
    import networkx as nx
    A = nx.to_numpy_array(G, nodelist=range(N)).astype(bool)
    np.fill_diagonal(A, True)
    return A


def edge_array(G):
    return np.array([(u, v) for u, v in G.edges()], dtype=int)
