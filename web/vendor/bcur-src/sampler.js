// Walker–Vose alias sampler, written for this bundle (replaces the GPL-licensed @apocentre/alias-sampling).
// Must pick exactly what the UR encoder picks, so it follows the BC-UR reference random-sampler step for step:
// small/large worklists filled from the highest index down, popped from the end; next() draws two doubles.
export default function aliasSampler(weights, outcomes, rng) {
  const n = weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const P = weights.map((w) => (w * n) / sum); // scaled so the mean is 1
  const prob = new Array(n);
  const alias = new Array(n);
  const small = [];
  const large = [];
  for (let i = n - 1; i >= 0; i--) (P[i] < 1 ? small : large).push(i);
  while (small.length && large.length) {
    const a = small.pop();
    const g = large.pop();
    prob[a] = P[a];
    alias[a] = g;
    P[g] = P[g] + P[a] - 1;
    (P[g] < 1 ? small : large).push(g);
  }
  while (large.length) prob[large.pop()] = 1;
  while (small.length) prob[small.pop()] = 1; // only via rounding
  return {
    next() {
      const c = Math.floor(rng() * n);
      const i = rng() < prob[c] ? c : alias[c];
      return outcomes ? outcomes[i] : i;
    },
  };
}
