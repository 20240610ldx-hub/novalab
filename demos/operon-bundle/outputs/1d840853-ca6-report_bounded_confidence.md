# Bounded-confidence opinion dynamics: consensus, polarization and fragmentation

Simulation study of two bounded-confidence models on a continuous opinion space,
measuring how the confidence threshold ε, the population size N, and the social
network topology determine the number of surviving opinion clusters.

## 1. Models

Each of N agents holds an opinion `x_i ∈ [0,1]`, drawn i.i.d. uniform at t = 0.
Both rules let agents influence each other **only** when their opinions already
differ by at most the confidence threshold ε — the bounded-confidence assumption.

**Hegselmann–Krause (HK)** — synchronous, all-neighbour averaging:

    x_i(t+1) = mean{ x_j(t) : |x_i(t) − x_j(t)| ≤ ε, j ∈ N(i) ∪ {i} }

**Deffuant–Weisbuch** — asynchronous pairwise compromise with convergence rate
μ = 0.5. For a randomly drawn pair (i, j):

    if |x_i − x_j| ≤ ε:   x_i ← x_i + μ(x_j − x_i),   x_j ← x_j + μ(x_i − x_j)

One Deffuant "sweep" applies N/2 disjoint random pairs, so one sweep updates
every agent once on average and is directly comparable to one HK step.

## 2. Protocol

| | |
|---|---|
| Threshold sweep | ε = 0.01 … 0.50 (step 0.01), N = 400, 30 seeds per point, both models |
| Finite-size sweep | N ∈ {50, 100, 200, 400, 800}, ε = 0.12 … 0.35 (step 0.01), 20–40 seeds, HK |
| Topology sweep | complete graph, Erdős–Rényi, Watts–Strogatz (p = 0.1), Barabási–Albert, all at N = 200 and mean degree 8; 12 seeds on a coarse grid plus 24 seeds on ε = 0.17 … 0.35 |
| Convergence | HK: max opinion change < 1e-9; Deffuant: no agent moved for 100 consecutive sweeps |
| Clusters | opinions sorted; a gap > 0.01 separates clusters. Reported cluster count is the inverse-Simpson *effective* number, 1/Σp_k², which discounts single-agent stragglers |
| Consensus | largest cluster holds > 95 % of agents |

Both update rules are deterministic given the initial condition (HK) or the
pairing sequence (Deffuant); all reported quantities are means over seeds.

## 3. Results

### 3.1 Three regimes, selected by ε alone

{{artifact:art_259acb7c-48fe-435f-902e-5a907f875843}}

*Opinion trajectories for one initial condition (N = 200) under both update
rules. Time is in sweeps (one update per agent), log scale; the two rows span
different timescales. Annotations give the final cluster count and the largest
cluster's share. At ε = 0.30 the Deffuant run retains a second cluster of 48 %
— that rule needs a wider confidence window than HK to reach consensus
(§3.2).*

The qualitative picture is the same for both rules: narrow confidence freezes
the population into many small blocs; intermediate confidence yields a handful
of mutually unreachable camps, including the textbook polarized state of two
extreme clusters plus a shrinking centre; wide confidence collapses everything
onto the mean. The *dynamics* differ sharply — HK settles in under ten sweeps,
Deffuant needs hundreds.

### 3.2 Phase diagram, finite-size effects, and critical slowing

{{artifact:art_f8fe7c40-970f-4a27-ac76-815e672cbf89}}

*(a) Effective number of surviving clusters vs ε, N = 400, 30 seeds; bands are
±1 SD across seeds; dashed line is the 1/(2ε) rule. (b) Fraction of HK runs
reaching consensus, for five population sizes. (c) Sweeps to convergence; HK
peaks at the transition, Deffuant is monotone in ε.*

**The 1/(2ε) rule holds, with model-specific prefactors.** Fitting
`clusters = a/ε` over the fragmented regime ε ∈ [0.02, 0.15]:

| | raw cluster count | effective (inverse-Simpson) count |
|---|---|---|
| Deffuant | 1/(1.91 ε) | 1/(2.43 ε) |
| Hegselmann–Krause | 1/(2.58 ε) | 1/(3.01 ε) |

Deffuant sits almost exactly on the classical 1/(2ε) spacing rule; HK packs its
clusters ~30 % further apart, consistent with the "2.2ε" prefactor reported for
HK in the literature, and the effective count is lower still because HK leaves
a few isolated stragglers that the inverse-Simpson measure discounts.

**Consensus thresholds (N = 400, ≥ 95 % of runs):** HK ε\* = 0.26, Deffuant
ε\* = 0.31. The pairwise rule is the more conservative of the two: a compromise
step only ever moves two agents, so a minority bloc can survive at thresholds
where HK's simultaneous averaging would have swallowed it.

**Finite-size drift.** The HK threshold falls monotonically with population
size — 0.32 (N = 50), 0.29 (100), 0.26 (200), 0.26 (400), 0.25 (800) — and the
transition sharpens. Larger crowds fill the opinion axis more densely, so
fewer initial gaps exceed ε and bridging agents are almost always present. The
trend is consistent with the ε\* ≈ 0.19–0.2 asymptotic value reported for HK in
the thermodynamic limit, approached slowly from above.

**Critical slowing down.** HK convergence time peaks at ε = 0.23 (≈ 30 sweeps,
against ≈ 10 away from the transition): right at the threshold the population
hovers in a near-degenerate state in which a thin bridge of centrists is slowly
either absorbed or cut. Deffuant shows no such peak — its timescale is set by
the probability that a random pair is within ε, so it falls monotonically from
≈ 1 800 sweeps at ε = 0.05 to ≈ 200 at ε = 0.5, and is 20–100× slower than HK
throughout.

### 3.3 Network structure changes both the outcome and the clock

{{artifact:art_bcf4a5e8-20a1-466e-9dc7-445980a5519e}}

*HK on four topologies, all at N = 200 and mean degree 8 (the complete graph is
the mean-field reference, dashed). (a) effective cluster count; (b) sweeps to
convergence; (c) consensus threshold, shown as the ε at which half the runs and
at which all runs reach consensus (24 seeds, 0.01 grid).*

Sparse interaction has two opposing effects. Below ε ≈ 0.15 it **fragments**
the population far more than mean-field mixing: at ε = 0.05 the effective
cluster count is 23.8 (Watts–Strogatz), 17.9 (Erdős–Rényi) and 16.7
(Barabási–Albert) against 7.0 on the complete graph, because an agent can only
average over the handful of neighbours it happens to have. Near the transition
the ordering reverses — local averaging lets neighbouring blocs merge
pairwise along the graph, so the sparse networks sit slightly *below*
mean-field — but only the Erdős–Rényi graph lowers the consensus threshold
materially (ε\* = 0.19–0.24 against 0.23–0.28 for the complete graph);
Watts–Strogatz (0.23–0.29) and Barabási–Albert (0.22–0.28) are
indistinguishable from mean-field at this resolution.

The cost is paid in time. At ε = 0.30, convergence takes 5.4 sweeps on the
complete graph, 50 (Barabási–Albert), 54 (Erdős–Rényi) and 281
(Watts–Strogatz). The clustered, locally-wired Watts–Strogatz graph is the
slowest by a wide margin: agreement has to diffuse along a ring rather than
jump across shortcuts, and hubs (Barabási–Albert) or random long ties
(Erdős–Rényi) act as the shortcut that the ring lacks.

## 4. Interpretation

Three claims survive the sweeps, each in the form a social scientist would want:

1. **Openness is a threshold phenomenon, not a dial.** The number of surviving
   opinion camps is set by ε through a 1/ε law, and consensus switches on over a
   window of width ≈ 0.05 in ε. Small changes in how much disagreement people
   will tolerate produce discontinuous changes in collective outcome.
2. **Interaction protocol matters as much as tolerance.** With identical ε and
   identical initial conditions, simultaneous group averaging (HK) reaches
   consensus at ε = 0.26 while pairwise compromise (Deffuant) needs ε = 0.31
   and 20–100× more interactions.
3. **Sparse social structure fragments opinion at low tolerance and slows
   agreement at every tolerance**, and local clustering (Watts–Strogatz) is far
   more costly in time than either random ties or hubs.

## 5. Limitations

Initial opinions are uniform on [0,1] throughout; a bimodal or skewed start
would shift every threshold reported here. ε is homogeneous and constant — no
heterogeneous open-mindedness, no stubborn extremists, no noise term, and no
rewiring of the network in response to opinion. Consensus thresholds are
resolved only to the sweep grid (0.01 in ε, 0.025 on the coarse topology grid)
and to the seed count (12–40 runs per point), so differences below ~0.02 in ε
between topologies are not resolved. Convergence criteria differ in kind
between the two models (fixed point vs. 100 quiet sweeps), so the absolute
sweep counts in Fig. 2c are comparable only up to that definition. No
assumption or sensitivity diagnostics beyond the seed-to-seed spread shown were
assessed.

## 6. Files

- `bc_model.py` — model implementations and the cluster observables
- `sweep_eps.csv` / `sweep_eps_summary.csv` — per-run and aggregated ε sweep, both models, N = 400
- `sweep_finite_size.csv` — HK ε sweep for five population sizes
- `sweep_topology.csv` / `sweep_topology_transition.csv` — coarse and refined topology sweeps
