import {
  KOKUSHO_ITAIJI_COMMIT,
  KOKUSHO_ITAIJI_ENTRIES,
  KOKUSHO_ITAIJI_PAIR_COUNT,
  KOKUSHO_ITAIJI_SOURCE,
} from "./kokusho-itaiji-data";

export type ItaijiEntry = {
  normalized: string;
  variants: readonly string[];
};

export const itaijiSource = {
  repository: KOKUSHO_ITAIJI_SOURCE,
  commit: KOKUSHO_ITAIJI_COMMIT,
  pairCount: KOKUSHO_ITAIJI_PAIR_COUNT,
  groupCount: KOKUSHO_ITAIJI_ENTRIES.length,
} as const;

export const itaijiEntries: readonly ItaijiEntry[] = KOKUSHO_ITAIJI_ENTRIES.map(
  ([normalized, variants]) => ({ normalized, variants }),
);

const matchingPosition = (text: string, entry: ItaijiEntry) => {
  let position = Number.POSITIVE_INFINITY;
  for (const term of [entry.normalized, ...entry.variants]) {
    const index = text.indexOf(term);
    if (index >= 0 && index < position) position = index;
  }
  return position;
};

export function findItaijiEntries(needle: string): ItaijiEntry[] {
  const text = needle.trim();
  if (!text) return [...itaijiEntries];

  const forms = [...new Set([text, text.normalize("NFKC")])];
  return itaijiEntries
    .map((entry) => ({
      entry,
      position: Math.min(...forms.map((form) => matchingPosition(form, entry))),
    }))
    .filter(({ position }) => Number.isFinite(position))
    .sort((a, b) => a.position - b.position || a.entry.normalized.localeCompare(b.entry.normalized, "ja"))
    .map(({ entry }) => entry);
}
