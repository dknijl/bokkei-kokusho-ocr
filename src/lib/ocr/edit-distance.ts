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
