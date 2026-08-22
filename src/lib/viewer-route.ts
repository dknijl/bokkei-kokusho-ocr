import {
  appPathFromManifestUrl,
  appRootPath,
  manifestUrlFromAppPath,
} from "./iiif";

export type ViewerRoute = {
  manifestUrl: string | null;
  canvasNumber?: number;
  isRoot: boolean;
};

function isRootPath(pathname: string): boolean {
  const rootPath = appRootPath();
  return pathname === "/"
    || pathname === ""
    || pathname === rootPath
    || pathname === rootPath.replace(/\/$/, "");
}

export function parseCanvasNumber(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function parseViewerLocation(location: Pick<Location, "pathname" | "search">): ViewerRoute {
  return {
    manifestUrl: manifestUrlFromAppPath(location.pathname),
    canvasNumber: parseCanvasNumber(new URLSearchParams(location.search).get("canvas")),
    isRoot: isRootPath(location.pathname),
  };
}

export function viewerPathFromManifestUrl(manifestUrl: string, canvasNumber?: number): string {
  const path = appPathFromManifestUrl(manifestUrl);
  return Number.isSafeInteger(canvasNumber) && (canvasNumber ?? 0) > 0
    ? `${path}?canvas=${canvasNumber}`
    : path;
}
