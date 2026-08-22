export type ViewerDebugEvent = {
  event: string;
  instanceId: string;
  manifestUrl: string;
  pageIndex: number;
  canvasId?: string;
  locationHref: string;
  timestamp: number;
  extra?: Record<string, unknown>;
};

export type PendingOcrMarker = {
  instanceId: string;
  manifestUrl: string;
  canvasId: string;
  pageIndex: number;
  startedAt: number;
};

type ViewerDebugState = {
  manifestUrl: string;
  pageIndex: number;
  canvasId?: string;
};

const pendingOcrKey = "bokkei-pending-ocr";

function newInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readPendingOcr(): PendingOcrMarker | null {
  try {
    const raw = window.sessionStorage.getItem(pendingOcrKey);
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<PendingOcrMarker>;
    if (
      typeof marker.instanceId !== "string"
      || typeof marker.manifestUrl !== "string"
      || typeof marker.canvasId !== "string"
      || typeof marker.pageIndex !== "number"
      || typeof marker.startedAt !== "number"
    ) return null;
    return marker as PendingOcrMarker;
  } catch {
    return null;
  }
}

export function createViewerDebug(getState: () => ViewerDebugState) {
  const instanceId = newInstanceId();
  const enabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "ocr";

  function log(event: string, extra?: Record<string, unknown>): void {
    if (!enabled) return;
    const state = getState();
    const payload: ViewerDebugEvent = {
      event,
      instanceId,
      manifestUrl: state.manifestUrl,
      pageIndex: state.pageIndex,
      locationHref: window.location.href,
      timestamp: Date.now(),
      ...(state.canvasId ? { canvasId: state.canvasId } : {}),
      ...(extra ? { extra } : {}),
    };
    console.debug("[bokkei-viewer]", payload);
  }

  function setPendingOcr(marker: Omit<PendingOcrMarker, "instanceId">): PendingOcrMarker | null {
    if (!enabled) return null;
    const nextMarker = { ...marker, instanceId };
    try {
      window.sessionStorage.setItem(pendingOcrKey, JSON.stringify(nextMarker));
    } catch {
      // Diagnostics must not interrupt OCR when storage is unavailable.
    }
    return nextMarker;
  }

  function clearPendingOcr(marker?: PendingOcrMarker | null): void {
    if (!enabled) return;
    const current = readPendingOcr();
    if (marker && current?.startedAt !== marker.startedAt) return;
    try {
      window.sessionStorage.removeItem(pendingOcrKey);
    } catch {
      // Ignore restricted storage contexts.
    }
  }

  return {
    enabled,
    instanceId,
    log,
    setPendingOcr,
    clearPendingOcr,
    readPendingOcr,
  };
}
