export type DecodedRecognition = {
  text: string;
  recognitionScore: number;
  tokenScores: number[];
  tokenMargins: number[];
  minimumTokenScore: number;
  meanTokenMargin: number;
  eosScore: number;
  endedWithEos: boolean;
};

const PROBABILITY_FLOOR = 1e-12;

export function stableLogSoftmax(logits: ArrayLike<number>): number[] {
  if (!logits.length) return [];

  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < logits.length; index += 1) {
    const value = Number(logits[index]);
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }

  if (!Number.isFinite(maximum)) {
    return Array.from({ length: logits.length }, () => -Math.log(logits.length));
  }

  let sum = 0;
  for (let index = 0; index < logits.length; index += 1) {
    const value = Number(logits[index]);
    sum += Number.isFinite(value) ? Math.exp(value - maximum) : 0;
  }
  const logSum = Math.log(Math.max(sum, PROBABILITY_FLOOR));

  return Array.from({ length: logits.length }, (_, index) => {
    const value = Number(logits[index]);
    return Number.isFinite(value) ? value - maximum - logSum : Number.NEGATIVE_INFINITY;
  });
}

function probability(logProbability: number): number {
  return Math.max(PROBABILITY_FLOOR, Math.min(1, Math.exp(logProbability)));
}

export function decodeRecognition(
  values: ArrayLike<number>,
  sequenceLength: number,
  classCount: number,
  charset: string[],
): DecodedRecognition {
  if (sequenceLength < 1 || classCount < 1) {
    throw new Error("Recognition output has no sequence or classes.");
  }

  let text = "";
  const tokenScores: number[] = [];
  const tokenMargins: number[] = [];
  let negativeLogLikelihood = 0;
  let tokenCount = 0;
  let eosScore = PROBABILITY_FLOOR;
  let endedWithEos = false;

  for (let position = 0; position < sequenceLength; position += 1) {
    const start = position * classCount;
    const logits = Array.from({ length: classCount }, (_, index) => Number(values[start + index]));
    const logProbabilities = stableLogSoftmax(logits);
    let bestIndex = 0;
    let bestLogProbability = Number.NEGATIVE_INFINITY;
    let secondBestLogProbability = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < logProbabilities.length; index += 1) {
      const value = logProbabilities[index];
      if (value > bestLogProbability) {
        secondBestLogProbability = bestLogProbability;
        bestLogProbability = value;
        bestIndex = index;
      } else if (value > secondBestLogProbability) {
        secondBestLogProbability = value;
      }
    }

    const bestProbability = probability(bestLogProbability);
    eosScore = probability(logProbabilities[0]);
    const margin = Number.isFinite(secondBestLogProbability)
      ? bestLogProbability - secondBestLogProbability
      : 0;

    if (bestIndex === 0) {
      negativeLogLikelihood += -Math.log(bestProbability);
      tokenCount += 1;
      endedWithEos = true;
      break;
    }

    tokenScores.push(bestProbability);
    tokenMargins.push(Math.max(0, margin));
    negativeLogLikelihood += -Math.log(bestProbability);
    tokenCount += 1;
    text += charset[bestIndex - 1] ?? "";
  }

  if (!endedWithEos) {
    negativeLogLikelihood += -Math.log(Math.max(PROBABILITY_FLOOR, eosScore));
    tokenCount += 1;
  }

  const recognitionScore = Math.max(
    0,
    Math.min(1, Math.exp(-negativeLogLikelihood / Math.max(1, tokenCount))),
  );

  return {
    text,
    recognitionScore,
    tokenScores,
    tokenMargins,
    minimumTokenScore: tokenScores.length ? Math.min(...tokenScores) : eosScore,
    meanTokenMargin: tokenMargins.length
      ? tokenMargins.reduce((sum, value) => sum + value, 0) / tokenMargins.length
      : 0,
    eosScore,
    endedWithEos,
  };
}
