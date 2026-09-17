import type {
  LineRecognizer,
  RecognizerContext,
  RecognizerInput,
  RecognizerOutput,
} from "../engine/types.ts";

/**
 * The page-level NDL pipeline remains the source of truth for PARSeq.
 * This adapter reserves the common line-recognizer boundary without loading
 * a second model or changing the established NDL retry policy.
 */
export class ParseqRecognizer implements LineRecognizer {
  readonly id = "ndl-parseq" as const;
  readonly revision = "ndl-parseq-adapter";

  async initialize(_context: RecognizerContext): Promise<void> {
    // NDL model initialization is owned by recognizePageWithNdlLite().
  }

  async recognize(_input: RecognizerInput, _context?: RecognizerContext): Promise<RecognizerOutput> {
    throw new Error("PARSeq line recognition is owned by the NDL page pipeline.");
  }

  async dispose(): Promise<void> {
    // The NDL page pipeline owns its shared model lifetime.
  }
}
