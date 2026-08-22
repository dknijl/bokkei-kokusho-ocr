export type OcrRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecognitionPreprocessing =
  | "original"
  | "padded"
  | "high-resolution-original"
  | "high-resolution-padded"
  | "grayscale-contrast"
  | "background-normalized"
  | "ink-channel"
  | "adaptive-binary";

export type RecognitionOrientation = "auto" | "normal" | "rotate-90";

export type OcrAlternative = {
  text: string;
  recognitionScore: number;
  minimumTokenScore: number;
  meanTokenMargin: number;
  eosScore?: number;
  endedWithEos: boolean;
  source: "page" | "iiif-crop" | "segmented";
  preprocessing: RecognitionPreprocessing;
  orientation?: RecognitionOrientation;
  deskewAngle?: number;
};

export type OcrSelectionReason = "consensus" | "score" | "original-tie";

export type OcrLine = {
  text: string;
  region?: OcrRegion;
  id?: string;
  detectionIndex?: number;
  readingOrder?: number;
  detectionScore: number;
  recognitionScore?: number;
  minimumTokenScore?: number;
  meanTokenMargin?: number;
  eosScore?: number;
  endedWithEos?: boolean;
  source?: "page" | "iiif-crop" | "segmented";
  preprocessing?: RecognitionPreprocessing;
  orientation?: RecognitionOrientation;
  deskewAngle?: number;
  paperScore?: number;
  alternatives?: OcrAlternative[];
  uncertain?: boolean;
  selectionReason?: OcrSelectionReason;
};

export type CropPadding = {
  longitudinalRatio: number;
  transverseRatio: number;
};

export type OcrRunStats = {
  detectionCount: number;
  modelInferenceCount: number;
  adaptiveTiles: number;
  initialRecognitions: number;
  extraRecognitions: number;
  extraRecognitionAttempts: number;
  highResolutionRetries: number;
  additionalCropRequests: number;
  additionalCropFailures: number;
  maxCanvasPixels: number;
  durationMs: number;
};
