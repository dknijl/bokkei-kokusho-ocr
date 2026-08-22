import type { RecognitionOrientation, RecognitionPreprocessing } from "./types.ts";

type RgbaImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

function clamp(value: number, minimum = 0, maximum = 255): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function luminance(red: number, green: number, blue: number): number {
  return (red * 0.299) + (green * 0.587) + (blue * 0.114);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))] ?? 0;
}

function imageData(source: HTMLCanvasElement): RgbaImage {
  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Preprocessing requires a 2D canvas.");
  const image = context.getImageData(0, 0, source.width, source.height);
  return { width: source.width, height: source.height, data: image.data };
}

function canvasFromImage(image: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error("Preprocessing could not create a 2D canvas.");
  }
  const output = context.createImageData(image.width, image.height);
  output.data.set(image.data);
  context.putImageData(output, 0, 0);
  return canvas;
}

function grayscaleContrastImage(source: RgbaImage): RgbaImage {
  const values: number[] = [];
  for (let index = 0; index < source.data.length; index += 4) {
    values.push(luminance(source.data[index], source.data[index + 1], source.data[index + 2]));
  }
  const low = percentile(values, 0.02);
  const high = Math.max(low + 1, percentile(values, 0.98));
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = clamp(((values[index] - low) * 255) / (high - low));
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = source.data[offset + 3];
  }
  return { ...source, data };
}

function integralImage(source: RgbaImage): Float64Array {
  const stride = source.width + 1;
  const integral = new Float64Array((source.width + 1) * (source.height + 1));
  for (let y = 1; y <= source.height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= source.width; x += 1) {
      const pixel = ((y - 1) * source.width + (x - 1)) * 4;
      rowSum += luminance(source.data[pixel], source.data[pixel + 1], source.data[pixel + 2]);
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  return integral;
}

function boxAverage(integral: Float64Array, width: number, height: number, x: number, y: number, radius: number): number {
  const stride = width + 1;
  const x1 = Math.max(0, x - radius);
  const y1 = Math.max(0, y - radius);
  const x2 = Math.min(width - 1, x + radius);
  const y2 = Math.min(height - 1, y + radius);
  const sum = integral[(y2 + 1) * stride + (x2 + 1)]
    - integral[y1 * stride + (x2 + 1)]
    - integral[(y2 + 1) * stride + x1]
    + integral[y1 * stride + x1];
  return sum / Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1));
}

function backgroundNormalizedImage(source: RgbaImage): RgbaImage {
  const integral = integralImage(source);
  const radius = Math.max(2, Math.round(Math.min(source.width, source.height) * 0.06));
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const value = luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
      const background = boxAverage(integral, source.width, source.height, x, y, radius);
      const normalized = clamp(128 + (value - background) * 2.4);
      data[offset] = normalized;
      data[offset + 1] = normalized;
      data[offset + 2] = normalized;
      data[offset + 3] = source.data[offset + 3];
    }
  }
  return { ...source, data };
}

function bestInkChannelImage(source: RgbaImage): RgbaImage {
  const channels = [0, 1, 2].map((channel) => {
    const values: number[] = [];
    for (let index = channel; index < source.data.length; index += 4) values.push(source.data[index]);
    return {
      channel,
      separation: percentile(values, 0.95) - percentile(values, 0.05),
    };
  });
  const channel = channels.sort((first, second) => second.separation - first.separation)[0]?.channel ?? 0;
  const values: number[] = [];
  for (let index = channel; index < source.data.length; index += 4) values.push(source.data[index]);
  const low = percentile(values, 0.02);
  const high = Math.max(low + 1, percentile(values, 0.98));
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = clamp(((values[index] - low) * 255) / (high - low));
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = source.data[offset + 3];
  }
  return { ...source, data };
}

function adaptiveBinaryImage(source: RgbaImage): RgbaImage {
  const integral = integralImage(source);
  const radius = Math.max(2, Math.round(Math.min(source.width, source.height) * 0.035));
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const value = luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
      const average = boxAverage(integral, source.width, source.height, x, y, radius);
      const binary = value < average * 0.9 ? 0 : 255;
      data[offset] = binary;
      data[offset + 1] = binary;
      data[offset + 2] = binary;
      data[offset + 3] = source.data[offset + 3];
    }
  }
  return { ...source, data };
}

export function preprocessCanvas(
  source: HTMLCanvasElement,
  preprocessing: Exclude<RecognitionPreprocessing, "original" | "padded" | "high-resolution-original" | "high-resolution-padded">,
): HTMLCanvasElement {
  const image = imageData(source);
  const processed = preprocessing === "grayscale-contrast"
    ? grayscaleContrastImage(image)
    : preprocessing === "background-normalized"
      ? backgroundNormalizedImage(image)
      : preprocessing === "ink-channel"
        ? bestInkChannelImage(image)
        : adaptiveBinaryImage(image);
  return canvasFromImage(processed);
}

export function releasePreprocessedCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function transformLineCanvas(
  source: HTMLCanvasElement,
  orientation: RecognitionOrientation = "auto",
  deskewAngle = 0,
): HTMLCanvasElement {
  const rotateQuarterTurn = orientation === "rotate-90"
    || (orientation === "auto" && source.height > source.width);
  const oriented = document.createElement("canvas");
  oriented.width = Math.max(1, rotateQuarterTurn ? source.height : source.width);
  oriented.height = Math.max(1, rotateQuarterTurn ? source.width : source.height);

  try {
    const orientedContext = oriented.getContext("2d");
    if (!orientedContext) throw new Error("Line orientation requires a 2D canvas.");
    orientedContext.imageSmoothingEnabled = true;
    orientedContext.imageSmoothingQuality = "high";
    if (rotateQuarterTurn) {
      orientedContext.translate(0, source.width);
      orientedContext.rotate(-Math.PI / 2);
    }
    orientedContext.drawImage(source, 0, 0);

    if (!Number.isFinite(deskewAngle) || Math.abs(deskewAngle) < 0.001) return oriented;
    const radians = (deskewAngle * Math.PI) / 180;
    const width = Math.max(
      1,
      Math.ceil(Math.abs(oriented.width * Math.cos(radians)) + Math.abs(oriented.height * Math.sin(radians))),
    );
    const height = Math.max(
      1,
      Math.ceil(Math.abs(oriented.width * Math.sin(radians)) + Math.abs(oriented.height * Math.cos(radians))),
    );
    const rotated = document.createElement("canvas");
    rotated.width = width;
    rotated.height = height;
    try {
      const rotatedContext = rotated.getContext("2d");
      if (!rotatedContext) throw new Error("Deskew requires a 2D canvas.");
      rotatedContext.imageSmoothingEnabled = true;
      rotatedContext.imageSmoothingQuality = "high";
      rotatedContext.fillStyle = "#fff";
      rotatedContext.fillRect(0, 0, width, height);
      rotatedContext.translate(width / 2, height / 2);
      rotatedContext.rotate(radians);
      rotatedContext.drawImage(oriented, -oriented.width / 2, -oriented.height / 2);
      oriented.width = 0;
      oriented.height = 0;
      return rotated;
    } catch (error) {
      rotated.width = 0;
      rotated.height = 0;
      throw error;
    }
  } catch (error) {
    oriented.width = 0;
    oriented.height = 0;
    throw error;
  }
}

function projectionScore(source: HTMLCanvasElement): number {
  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context || source.width <= 0 || source.height <= 0) return 0;
  const pixels = context.getImageData(0, 0, source.width, source.height).data;
  const rows = new Float64Array(source.height);
  for (let y = 0; y < source.height; y += 1) {
    let darkness = 0;
    for (let x = 0; x < source.width; x += 1) {
      const offset = ((y * source.width) + x) * 4;
      darkness += 255 - luminance(pixels[offset] ?? 255, pixels[offset + 1] ?? 255, pixels[offset + 2] ?? 255);
    }
    rows[y] = darkness / Math.max(1, source.width);
  }
  const mean = Array.from(rows).reduce((sum, value) => sum + value, 0) / Math.max(1, rows.length);
  return Array.from(rows).reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, rows.length);
}

export function rankDeskewAngles(
  source: HTMLCanvasElement,
  orientation: RecognitionOrientation = "auto",
  angles = [-3, -1.5, 0, 1.5, 3],
): number[] {
  return angles
    .filter((angle) => Number.isFinite(angle))
    .map((angle, order) => {
      let transformed: HTMLCanvasElement | null = null;
      try {
        transformed = transformLineCanvas(source, orientation, angle);
        return { angle, score: projectionScore(transformed), order };
      } finally {
        releasePreprocessedCanvas(transformed);
      }
    })
    .sort((first, second) => second.score - first.score || Math.abs(first.angle) - Math.abs(second.angle) || first.order - second.order)
    .map((item) => item.angle);
}
