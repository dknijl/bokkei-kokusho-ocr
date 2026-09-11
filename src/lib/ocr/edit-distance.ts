export function levenshteinDistance(first: string, second: string): number {
  const left = Array.from(first);
  const right = Array.from(second);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[right.length] ?? 0;
}

export function normalizedEditDistance(first: string, second: string): number {
  const length = Math.max(Array.from(first).length, Array.from(second).length);
  return length ? levenshteinDistance(first, second) / length : 0;
}

/** Unicode code points; ties prefer substitution, then deletion, then insertion. O(prediction) space. */
export function characterErrors(reference: string, prediction: string): { substitutions: number; deletions: number; insertions: number; distance: number } {
  const left = Array.from(reference), right = Array.from(prediction);
  type Counts = { substitutions: number; deletions: number; insertions: number; distance: number };
  let previous: Counts[] = Array.from({ length: right.length + 1 }, (_, insertions) => ({ substitutions: 0, deletions: 0, insertions, distance: insertions }));
  for (let i = 1; i <= left.length; i++) {
    const current: Counts[] = [{ substitutions: 0, deletions: i, insertions: 0, distance: i }];
    for (let j = 1; j <= right.length; j++) {
      const change = Number(left[i - 1] !== right[j - 1]);
      const diagonal = previous[j - 1], deletion = previous[j], insertion = current[j - 1];
      const cost = Math.min(diagonal.distance + change, deletion.distance + 1, insertion.distance + 1);
      current[j] = cost === diagonal.distance + change ? { ...diagonal, substitutions: diagonal.substitutions + change, distance: cost }
        : cost === deletion.distance + 1 ? { ...deletion, deletions: deletion.deletions + 1, distance: cost }
        : { ...insertion, insertions: insertion.insertions + 1, distance: cost };
    }
    previous = current;
  }
  return previous[right.length];
}
