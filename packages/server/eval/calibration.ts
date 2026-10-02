/**
 * Offline fitting for the confidence model: a small L2-regularised logistic regression, leave-one-out
 * predictions to choose the regularisation and the cutoffs honestly, and the cutoff rules. Pure and deterministic.
 */

export interface Fit {
  weights: number[];
  bias: number;
}

export function standardize(rows: number[][]): { mean: number[]; sd: number[] } {
  const width = rows[0]?.length ?? 0;
  const mean = Array.from({ length: width }, (_, j) => rows.reduce((sum, row) => sum + row[j]!, 0) / rows.length);
  const sd = Array.from({ length: width }, (_, j) => {
    const variance = rows.reduce((sum, row) => sum + (row[j]! - mean[j]!) ** 2, 0) / rows.length;
    // A constant feature carries no information; a unit sd keeps its standardised value at zero.
    return Math.sqrt(variance) || 1;
  });
  return { mean, sd };
}

const apply = (row: number[], mean: number[], sd: number[]) => row.map((value, j) => (value - mean[j]!) / sd[j]!);
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** Solves A x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const divisor = m[col]![col]!;
    if (Math.abs(divisor) < 1e-12) throw new Error('Singular matrix in logistic fit');
    for (let row = col + 1; row < n; row++) {
      const factor = m[row]![col]! / divisor;
      for (let k = col; k <= n; k++) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row]![n]!;
    for (let k = row + 1; k < n; k++) sum -= m[row]![k]! * x[k]!;
    x[row] = sum / m[row]![row]!;
  }
  return x;
}

/** Newton's method for L2-penalised logistic regression on standardised features. The bias is not penalised. */
export function fitLogistic(z: number[][], y: number[], lambda: number): Fit {
  const width = z[0]?.length ?? 0;
  const size = width + 1;
  let theta = new Array<number>(size).fill(0);
  for (let iteration = 0; iteration < 100; iteration++) {
    const gradient = new Array<number>(size).fill(0);
    const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    z.forEach((row, i) => {
      const x = [1, ...row];
      const p = sigmoid(x.reduce((sum, value, k) => sum + value * theta[k]!, 0));
      const weight = p * (1 - p);
      for (let a = 0; a < size; a++) {
        gradient[a]! += (p - y[i]!) * x[a]!;
        for (let b = 0; b < size; b++) hessian[a]![b]! += weight * x[a]! * x[b]!;
      }
    });
    for (let a = 1; a < size; a++) {
      gradient[a]! += lambda * theta[a]!;
      hessian[a]![a]! += lambda;
    }
    hessian[0]![0]! += 1e-9;
    const step = solve(hessian, gradient);
    theta = theta.map((value, k) => value - step[k]!);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return { bias: theta[0]!, weights: theta.slice(1) };
}

export function predict(row: number[], fit: Fit, mean: number[], sd: number[]): number {
  const z = apply(row, mean, sd);
  return sigmoid(fit.bias + z.reduce((sum, value, k) => sum + value * fit.weights[k]!, 0));
}

/** Out-of-sample probability for every row: each is predicted by a model that never saw it. */
export function leaveOneOut(rows: number[][], y: number[], lambda: number): number[] {
  return rows.map((row, held) => {
    const train = rows.filter((_, i) => i !== held);
    const labels = y.filter((_, i) => i !== held);
    const { mean, sd } = standardize(train);
    const fit = fitLogistic(train.map((r) => apply(r, mean, sd)), labels, lambda);
    return predict(row, fit, mean, sd);
  });
}

export function logLoss(probabilities: number[], y: number[]): number {
  const eps = 1e-12;
  return -probabilities.reduce((sum, p, i) => sum + (y[i] === 1 ? Math.log(p + eps) : Math.log(1 - p + eps)), 0) / probabilities.length;
}

export interface Sample {
  /** Out-of-sample probability that the results contain the answering section. */
  p: number;
  /** True when the results should be trusted: answerable and the gold section is in the top results. */
  positive: boolean;
  /** An unanswerable query, which the retriever must abstain on. */
  unanswerable: boolean;
}

export interface Cutoffs {
  high: number;
  medium: number;
}

/**
 * Choose where "high" and "medium" begin, from out-of-sample probabilities:
 * - high starts just above the most confident wrong sample, so no wrong sample is rated high (100% precision on the
 *   data it was chosen on), and never below 0.5;
 * - medium starts just above the (maxAbstainMisses + 1)-th most confident unanswerable sample, so at most
 *   `maxAbstainMisses` unanswerable queries reach medium: abstaining is never made worse than the baseline allowed.
 */
export function chooseCutoffs(samples: Sample[], maxAbstainMisses: number): Cutoffs {
  const margin = 1e-6;
  const wrong = samples.filter((sample) => !sample.positive).map((sample) => sample.p);
  const high = Math.max(0.5, wrong.length ? Math.max(...wrong) + margin : 0.5);

  const unanswerable = samples.filter((sample) => sample.unanswerable).map((sample) => sample.p).sort((a, b) => b - a);
  const reference = unanswerable[maxAbstainMisses];
  const medium = Math.min(high, reference === undefined ? 0.5 : reference + margin);
  return { high, medium };
}
