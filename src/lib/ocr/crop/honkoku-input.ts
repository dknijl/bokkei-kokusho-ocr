export const HONKOKU_INPUT_HEIGHT = 256;
export const HONKOKU_INPUT_WIDTH = 2048;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export type HonkokuTensorData = {
  data: Float32Array;
  dims: [1, 3, typeof HONKOKU_INPUT_HEIGHT, typeof HONKOKU_INPUT_WIDTH];
};

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("Honkoku image preprocessing requires a Canvas implementation.");
}

function releaseCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Convert one crop to the v18 [1, 3, 256, 2048] ImageNet-normalized tensor. */
export function createHonkokuInputTensorData(crop: ImageData): HonkokuTensorData {
  if (crop.width <= 0 || crop.height <= 0) throw new Error("Honkoku crop must have positive dimensions.");
  const vertical = crop.height > crop.width;
  const source = createCanvas(crop.width, crop.height);
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("Could not initialize the Honkoku source canvas.");
  sourceContext.putImageData(crop, 0, 0);
  const work = createCanvas(vertical ? crop.height : crop.width, vertical ? crop.width : crop.height);
  const workContext = work.getContext("2d");
  if (!workContext) {
    releaseCanvas(source);
    throw new Error("Could not initialize the Honkoku preprocessing canvas.");
  }
  if (vertical) {
    workContext.fillStyle = "rgb(255,255,255)";
    workContext.fillRect(0, 0, work.width, work.height);
    workContext.translate(work.width, 0);
    workContext.rotate(Math.PI / 2);
    workContext.drawImage(source, 0, 0);
    workContext.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    workContext.drawImage(source, 0, 0);
  }

  const scaledWidth = Math.max(
    1,
    Math.min(HONKOKU_INPUT_WIDTH, Math.round((work.width * HONKOKU_INPUT_HEIGHT) / work.height)),
  );
  const resized = createCanvas(scaledWidth, HONKOKU_INPUT_HEIGHT);
  const resizedContext = resized.getContext("2d");
  if (!resizedContext) {
    releaseCanvas(source);
    releaseCanvas(work);
    throw new Error("Could not initialize the Honkoku resize canvas.");
  }
  resizedContext.imageSmoothingEnabled = true;
  resizedContext.imageSmoothingQuality = "high";
  resizedContext.drawImage(work, 0, 0, work.width, work.height, 0, 0, scaledWidth, HONKOKU_INPUT_HEIGHT);

  const padded = createCanvas(HONKOKU_INPUT_WIDTH, HONKOKU_INPUT_HEIGHT);
  const paddedContext = padded.getContext("2d", { willReadFrequently: true });
  if (!paddedContext) {
    releaseCanvas(source);
    releaseCanvas(work);
    releaseCanvas(resized);
    throw new Error("Could not initialize the Honkoku input canvas.");
  }
  paddedContext.fillStyle = "rgb(255,255,255)";
  paddedContext.fillRect(0, 0, HONKOKU_INPUT_WIDTH, HONKOKU_INPUT_HEIGHT);
  paddedContext.drawImage(resized, 0, 0);
  const pixels = paddedContext.getImageData(0, 0, HONKOKU_INPUT_WIDTH, HONKOKU_INPUT_HEIGHT).data;
  const plane = HONKOKU_INPUT_WIDTH * HONKOKU_INPUT_HEIGHT;
  const data = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 4;
    data[index] = (pixels[pixel] / 255 - MEAN[0]) / STD[0];
    data[plane + index] = (pixels[pixel + 1] / 255 - MEAN[1]) / STD[1];
    data[(plane * 2) + index] = (pixels[pixel + 2] / 255 - MEAN[2]) / STD[2];
  }
  releaseCanvas(work);
  releaseCanvas(resized);
  releaseCanvas(padded);
  releaseCanvas(source);
  return { data, dims: [1, 3, HONKOKU_INPUT_HEIGHT, HONKOKU_INPUT_WIDTH] };
}
