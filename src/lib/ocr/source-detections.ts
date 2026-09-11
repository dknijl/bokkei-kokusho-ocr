import { globalNms, intersectionArea, mergeAdjacentDetections, type Detection } from "./nms.ts";

/** Merge only overlapping observations from different source tiles. Never reconnect same-tile ink-gap splits. */
export function mergeSourceDetections(input: Array<Detection & { sourceTile: number }>, writingMode: "auto" | "vertical" | "horizontal"): Detection[] {
  const vertical = writingMode === "vertical" || writingMode === "auto" && input.filter(box => box.height >= box.width).length >= input.length / 2;
  const groups: Array<{ box: Detection; tiles: Set<number> }> = [];
  for (const { sourceTile, ...box } of input) {
    let current = { box, tiles: new Set([sourceTile]) };
    for (let index = 0; index < groups.length;) {
      const prior = groups[index];
      const sharesTile = [...current.tiles].some(tile => prior.tiles.has(tile));
      const merged = !sharesTile && intersectionArea(prior.box, current.box) > 0
        ? mergeAdjacentDetections([prior.box, current.box], { orientation: vertical ? "vertical" : "horizontal", maxGapRatio: 0, transverseOverlapThreshold: 0.65 }) : [];
      if (merged.length !== 1) { index++; continue; }
      current = { box: merged[0], tiles: new Set([...current.tiles, ...prior.tiles]) };
      groups.splice(index, 1); index = 0;
    }
    groups.push(current);
  }
  return globalNms(groups.map(group => group.box));
}
