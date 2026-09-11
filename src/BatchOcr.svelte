<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ViewerManifest, ViewerPage } from "./lib/iiif";
  import type { NdlOcrOptions } from "./lib/ocr/profiles";
  import type { NdlOcrResult, NdlOcrProgress } from "./lib/ndl-ocr";
  import { BatchController, createOcrJob, latestOcrJob, indexedDbJobStore, type OcrJob } from "./lib/ocr/batch";
  import { executeOcrPage, supportsOcrWorker } from "./lib/ocr/worker-client";
  import { chooseZipDestination, writeJobZip, planZipParts, downloadZipPart, type ZipPart } from "./lib/ocr/zip-export";
  import { OCR_PIPELINE_VERSION } from "./lib/ocr/benchmark";
  import { NDL_MODEL_REVISION, isNdlModelRevision } from "./lib/ocr/model-revision";
  import { resolveLatestNdlModelRevision } from "./lib/ocr/model-source";
  import { batchProgress, type BatchPhase } from "./lib/ocr/batch-progress";
  import { t, type Locale } from "./lib/i18n";

  let { manifest, options, currentCanvasId, singleRunning, locale, onBusy, onPageResult }: {
    manifest: ViewerManifest;
    options: NdlOcrOptions;
    currentCanvasId: string;
    singleRunning: boolean;
    locale: Locale;
    onBusy: (value: boolean) => void;
    onPageResult: (manifestUrl: string, page: ViewerPage, result: NdlOcrResult) => void;
  } = $props();
  let job = $state<OcrJob | null>(null);
  let running = $state(false);
  let pausing = $state(false);
  let exporting = $state(false);
  let error = $state("");
  let progress = $state<NdlOcrProgress | null>(null);
  let parts = $state<ZipPart[]>([]);
  let controller: BatchController | null = null;
  let restoreGeneration = 0;
  const workerAvailable = supportsOcrWorker();
  const label = (ja: string, en: string) => locale === "ja" ? ja : en;
  const resumable = $derived(job && isNdlModelRevision(job.modelRevision)
    && job.modelRevision === (job.options.modelRevision ?? NDL_MODEL_REVISION) && job.pipelineVersion === OCR_PIPELINE_VERSION);
  const status = $derived(job ? batchProgress(job, running, pausing) : null);
  const finished = $derived(status?.phase === "completed" || status?.phase === "completed-with-errors");
  const phaseLabels: Record<BatchPhase, [string, string]> = {
    processing: ["処理中", "Processing"], pausing: ["保存後に一時停止", "Pausing after save"],
    completed: ["全コマのOCR完了", "OCR complete"],
    "completed-with-errors": ["全コマの処理完了（失敗・未対応あり）", "Finished with failed / unsupported canvases"],
    paused: ["一時停止中", "Paused"], cancelled: ["中止しました", "Cancelled"],
    interrupted: ["中断・再開待ち", "Interrupted — ready to resume"], ready: ["開始待ち", "Ready"],
  };

  $effect(() => {
    const url = manifest.url;
    const active = running;
    if (active) return;
    const generation = ++restoreGeneration;
    void latestOcrJob(url).then((saved) => {
      if (generation === restoreGeneration && !running) job = saved;
    }).catch((failure) => { if (generation === restoreGeneration) error = String(failure); });
  });
  $effect(() => {
    const id = job?.id;
    const canvas = currentCanvasId;
    const completed = job?.completed;
    const url = manifest.url;
    if (!id || !completed || job?.manifestUrl !== url || !resumable) return;
    const index = manifest.pages.findIndex((page) => page.canvasId === canvas);
    if (index < 0) return;
    let cancelled = false;
    void indexedDbJobStore.getPage(id, index).then((row) => {
      if (!cancelled && row.page.canvasId === canvas && row.result) onPageResult(url, row.page, row.result);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  });

  async function run(newJob: boolean, retryFailures = false) {
    if (running || singleRunning || !workerAvailable) return;
    running = true; onBusy(true); error = ""; parts = []; pausing = false; progress = null;
    ++restoreGeneration;
    const snapshot = $state.snapshot(manifest);
    const settings = $state.snapshot(options);
    controller = new BatchController();
    const operation = async () => {
      if (newJob || !job) {
        settings.modelRevision = await resolveLatestNdlModelRevision(controller!.signal);
        job = await createOcrJob(snapshot, settings);
      }
      const initial = $state.snapshot(job!);
      await controller!.run(initial, {
        recognize: executeOcrPage, retryFailures,
        onChange: (next, nextProgress) => { job = next; progress = nextProgress ?? null; },
        onPageSaved: (row) => {
          if (row.result && row.page.canvasId === untrack(() => currentCanvasId)) onPageResult(initial.manifestUrl, row.page, row.result);
        },
      });
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request("bokkei-manifest-ocr", { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error(label("別のタブで全コマOCRが実行中です。", "A manifest OCR job is running in another tab."));
          await operation();
        });
      } else await operation();
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { controller = null; running = false; pausing = false; onBusy(false); }
  }

  function pause() { pausing = true; controller?.pause(); }
  function cancel() { controller?.cancel(); }
  async function exportZip() {
    if (!job || exporting || running) return;
    const snapshot = $state.snapshot(job);
    // Acquire the file handle inside this click before any asynchronous preparation.
    const destination = chooseZipDestination(snapshot);
    exporting = true; error = "";
    try {
      if (destination) {
        const handle = await destination;
        const stream = await handle.createWritable();
        try { await writeJobZip(snapshot, stream); }
        catch (failure) { try { await stream.abort(); } catch {} throw failure; }
      } else {
        parts = await planZipParts(snapshot);
        if (parts.length === 1) { await downloadZipPart(snapshot, parts[0]); parts = []; }
      }
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) error = String(failure);
    } finally { exporting = false; }
  }
  async function savePart(part: ZipPart, index: number) {
    if (!job || exporting) return;
    exporting = true; error = "";
    try { await downloadZipPart($state.snapshot(job), $state.snapshot(part), index); }
    catch (failure) { error = String(failure); }
    finally { exporting = false; }
  }

  onDestroy(() => { ++restoreGeneration; controller?.cancel(); onBusy(false); });
</script>

<section class="batch-ocr" aria-label={label("全コマOCR", "Manifest OCR")}>
  <div class="batch-actions">
    <button type="button" class="batch-start" disabled={running || singleRunning || exporting || !workerAvailable} onclick={() => void run(true)}>{label("全コマをOCR", "OCR all canvases")}</button>
    {#if running}
      <button type="button" disabled={pausing} onclick={pause}>{pausing ? label("保存後に停止…", "Pausing after save…") : label("一時停止", "Pause")}</button>
      <button type="button" onclick={cancel}>{label("中止", "Cancel")}</button>
    {:else if job}
      {#if job.completed < job.total}
        <button type="button" disabled={singleRunning || exporting || !workerAvailable || !resumable} onclick={() => void run(false)}>{label("再開", "Resume")}</button>
      {/if}
      {#if job.failed}
        <button type="button" disabled={singleRunning || exporting || !workerAvailable || !resumable} onclick={() => void run(false, true)}>{label("失敗コマを再実行", "Retry failed canvases")}</button>
      {/if}
    {/if}
    {#if job && job.completed > 0}
      <button type="button" class="batch-export" disabled={running || exporting} onclick={() => void exportZip()}>{exporting ? label("ZIPを生成中…", "Creating ZIP…") : label("処理済みをZIP保存", "Save processed canvases as ZIP")}</button>
    {/if}
  </div>
  {#if job && status}
    <div class="batch-status">
      <div class="batch-summary" role="status" aria-live="polite" aria-atomic="true">
        <span class="batch-phase" class:complete={finished} class:has-errors={status.phase === "completed-with-errors"}>{label(...phaseLabels[status.phase])}</span>
        <strong class="batch-percent">{label("全体（保存済み）", "Overall (saved)")} {status.percent}%</strong>
        <span class="batch-counts">{label("保存済み", "Saved")} {job.completed}/{job.total} · {label("失敗・未対応", "Failed / unsupported")} {job.failed}</span>
      </div>
      <progress max={Math.max(1, job.total)} value={job.completed} aria-label={label("全体の保存済みコマ数", "Overall saved canvas count")}></progress>
      <div class="batch-detail">
        <strong class="batch-title">{job.title}</strong>
        {#if running}
          <span class="batch-current">{label("現在のコマ", "Current canvas")} {Math.min(job.total, job.nextIndex + 1)}/{job.total}{progress ? ` · ${t(locale, progress.messageKey, progress.params)} · ${Math.round(progress.percent)}%` : ""}</span>
        {:else if finished}
          <span>{label("処理結果を保存しました。ZIPでダウンロードできます。", "Results saved. Download them as a ZIP.")}</span>
        {:else if resumable}
          <span>{label("保存した続きから再開できます。", "Resume from the saved checkpoint.")}</span>
        {:else}
          <span>{label("処理結果は保存されています。", "Processed results remain saved.")}</span>
        {/if}
      </div>
      {#if !resumable}<p class="batch-note">{label("以前のOCR方式で保存した結果です。ZIP保存は可能です。今回の修正を反映するには「全コマをOCR」を実行してください。", "These results use an older OCR version. You can export them, or run OCR all canvases to apply the update.")}</p>{/if}
    </div>
  {:else if running}
    <p role="status">{label("全コマOCRを準備中…", "Preparing manifest OCR…")}</p>
  {/if}
  {#if parts.length > 1}
    <p>{label("容量を抑えるためZIPを分割しました。各ファイルを保存してください。", "The ZIP is split to limit memory use. Save each file.")}</p>
    {#each parts as part, index (index)}
      <button type="button" disabled={exporting} onclick={() => void savePart(part, index)}>ZIP {index + 1}/{parts.length}</button>
    {/each}
  {/if}
  <p class="batch-note">{workerAvailable ? (running ? label("タブを開いたまま実行してください。", "Keep this tab open while processing. ") : "") + label("文字未検出は白紙の判定ではありません。", "No text detected does not mean the canvas is blank.") : label("このブラウザでは全コマOCRを利用できません。単ページOCRを使用してください。", "This browser does not support batch OCR. Use single-page OCR.")}</p>
  {#if error || job?.error}<p class="batch-error" role="alert">{error || job?.error}</p>{/if}
</section>

<style>
  .batch-ocr { border-bottom: 1px solid #dedbd3; padding: 12px 16px; background: #f9f8f4; color: #342f29; font-size: 12px; }
  .batch-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { border: 1px solid #cbc7bd; border-radius: 5px; padding: 7px 10px; background: white; color: #342f29; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .batch-start { background: #343d32; color: white; border-color: #343d32; }
  .batch-status { padding-top: 12px; }
  .batch-summary, .batch-detail { display: flex; align-items: center; gap: 6px 16px; flex-wrap: wrap; }
  .batch-phase { font-weight: 700; }
  .batch-phase.complete { color: #245335; }
  .batch-phase.has-errors { color: #7b4113; }
  .batch-percent { font-size: 15px; font-variant-numeric: tabular-nums; }
  .batch-title { overflow-wrap: anywhere; }
  .batch-detail { line-height: 1.6; }
  progress { display: block; width: 100%; height: 9px; margin: 9px 0; accent-color: #485541; }
  .batch-note { color: #746b5e; margin: 8px 0 0; line-height: 1.5; }
  .batch-error { color: #942e24; overflow-wrap: anywhere; }
</style>
