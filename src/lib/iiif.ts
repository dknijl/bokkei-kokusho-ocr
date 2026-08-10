import { LocalizedError, type Locale, type ManifestStatus } from "./i18n";

export type OcrRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrLine = {
  text: string;
  confidence: number;
  region?: OcrRegion;
};

export type ViewerPage = {
  canvasId: string;
  imageServiceId: string;
  label: string;
  labelTranslations: LocalizedText;
  image: string;
  thumbnail: string;
  width: number;
  height: number;
  result: OcrLine[];
  ocrEngine?: string;
  ocrProvider?: string;
};

export type ViewerManifest = {
  url: string;
  title: string;
  titleTranslations: LocalizedText;
  attribution: string;
  attributionTranslations: LocalizedText;
  license: string;
  viewingDirection: string;
  recordId: string;
  status: ManifestStatus;
  pages: ViewerPage[];
};

export type LocalizedText = Record<string, string>;

export type ManifestPreset = {
  title: string;
  detail: string;
  detailEn: string;
  imageCount?: number;
  url: string;
};

export type OcrRequest = {
  manifestId: string;
  canvasId: string;
  imageServiceId: string;
  eraProfile: string;
  output: "iiif-annotation-page";
};

export const manifestPresets: ManifestPreset[] = [
  {
    title: "古今和歌集〈内裏切〉",
    detail: "鎌倉時代写 · 和歌・仮名",
    detailEn: "Kamakura-period manuscript · waka and kana",
    imageCount: 3,
    url: "https://kokusho.nijl.ac.jp/biblio/200021552/manifest",
  },
  {
    title: "陸氏草木鳥獸蟲魚疏圖解",
    detail: "安永8年刊 · 漢籍・挿絵",
    detailEn: "Published in 1779 · Chinese classic and illustrations",
    imageCount: 103,
    url: "https://kokusho.nijl.ac.jp/biblio/200021946/manifest",
  },
  {
    title: "光悦筆和歌帖／版本／はかなくも",
    detail: "和歌帖 · 散らし書き",
    detailEn: "Waka album · scattered writing",
    url: "https://kokusho.nijl.ac.jp/biblio/200043617/manifest",
  },
  {
    title: "繪本松のしらへ",
    detail: "江戸後期 · 版本・絵入",
    detailEn: "Late Edo period · illustrated printed book",
    url: "https://kokusho.nijl.ac.jp/biblio/200011824/manifest",
  },
];

const kokushoManifestPattern = /^https:\/\/kokusho\.nijl\.ac\.jp\/biblio\/(\d+)\/manifest\/?$/;

function appBasePath(): string {
  const baseUrl = import.meta.env.BASE_URL;
  return baseUrl === "./" ? "" : baseUrl.replace(/\/+$/, "");
}

export function appRootPath(): string {
  const basePath = appBasePath();
  return basePath ? `${basePath}/` : "/";
}

export function manifestUrlFromAppPath(pathname: string): string | null {
  const basePath = appBasePath();
  if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null;

  const relativePath = basePath ? pathname.slice(basePath.length) || "/" : pathname;
  const match = relativePath.match(/^\/(\d+)\/?$/);
  return match ? `https://kokusho.nijl.ac.jp/biblio/${match[1]}/manifest` : null;
}

export function appPathFromManifestUrl(manifestUrl: string): string {
  const match = manifestUrl.match(kokushoManifestPattern);
  const basePath = appBasePath();
  return match ? `${basePath}/${match[1]}` : appRootPath();
}

const initialService = "https://kokusho.nijl.ac.jp/api/iiif/200021552/v4/NIIP";

export const initialManifest: ViewerManifest = {
  url: manifestPresets[0].url,
  title: manifestPresets[0].title,
  titleTranslations: { ja: manifestPresets[0].title },
  attribution: "国文学研究資料館",
  attributionTranslations: { ja: "国文学研究資料館", en: "National Institute of Japanese Literature" },
  license: "https://creativecommons.org/publicdomain/mark/1.0/deed.ja",
  viewingDirection: "right-to-left",
  recordId: "200021552",
  status: "ocrNotRun",
  pages: ["00001", "00002", "00003"].map((number, index) => {
    const service = `${initialService}/YU1-0025/YU1-0025-${number}.tif`;
    return {
      canvasId: `https://kokusho.nijl.ac.jp/biblio/200021552/canvas/${index + 1}`,
      imageServiceId: service,
      label: ["表", "裏", "紙背"][index],
      labelTranslations: { ja: ["表", "裏", "紙背"][index] },
      image: `${service}/full/1200,/0/default.jpg`,
      thumbnail: `${service}/full/180,/0/default.jpg`,
      width: 3744,
      height: 5616,
      result: [],
    };
  }),
};

function collectLocalizedText(value: unknown, language: string, output: LocalizedText): void {
  if (typeof value === "string") {
    if (!output[language]) output[language] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectLocalizedText(item, language, output));
    return;
  }
  if (!value || typeof value !== "object") return;

  const map = value as Record<string, unknown>;
  const literal = map["@value"] ?? map.value;
  if (typeof literal === "string") {
    const literalLanguage = String(map["@language"] ?? language);
    if (!output[literalLanguage]) output[literalLanguage] = literal;
    return;
  }

  Object.entries(map).forEach(([key, item]) => {
    if (key === "@id" || key === "id" || key === "type" || key === "@type") return;
    collectLocalizedText(item, key, output);
  });
}

export function localizedValues(value: unknown): LocalizedText {
  const output: LocalizedText = {};
  collectLocalizedText(value, "none", output);
  return output;
}

export function localizedText(value: unknown, locale: Locale): string {
  const values = localizedValues(value);
  return values[locale] ?? values.none ?? values.ja ?? values.en ?? Object.values(values)[0] ?? "";
}

const serviceUrl = (service: unknown): string => {
  const item = Array.isArray(service) ? service[0] : service;
  if (!item || typeof item !== "object") return "";
  const value = item as Record<string, unknown>;
  return String(value.id ?? value["@id"] ?? "").replace(/\/$/, "");
};

const sizedIiifImage = (service: string, fallback: string, width: number) =>
  service ? `${service}/full/${width},/0/default.jpg` : fallback;

export function parseManifest(raw: Record<string, any>, fallbackUrl: string, locale: Locale = "ja"): ViewerManifest {
  const canvases = raw.sequences?.[0]?.canvases ?? raw.items ?? [];

  const pages: ViewerPage[] = canvases.flatMap((canvas: Record<string, any>, index: number) => {
    const body = canvas.images?.[0]?.resource ?? canvas.items?.[0]?.items?.[0]?.body ?? {};
    const imageServiceId = serviceUrl(body.service);
    const original = String(body.id ?? body["@id"] ?? canvas.thumbnail?.[0]?.id ?? canvas.thumbnail?.id ?? "");
    if (!imageServiceId && !original) return [];

    const labelTranslations = localizedValues(canvas.label);

    return [{
      canvasId: String(canvas.id ?? canvas["@id"] ?? `${fallbackUrl}#canvas-${index + 1}`),
      imageServiceId,
      label: localizedText(labelTranslations, locale) || String(index + 1),
      labelTranslations: Object.keys(labelTranslations).length ? labelTranslations : { none: String(index + 1) },
      image: sizedIiifImage(imageServiceId, original, 1200),
      thumbnail: sizedIiifImage(imageServiceId, original, 180),
      width: Number(canvas.width ?? body.width ?? 0),
      height: Number(canvas.height ?? body.height ?? 0),
      result: [],
    }];
  });

  if (!pages.length) {
    throw new LocalizedError("errorManifestImages");
  }

  const manifestUrl = String(raw.id ?? raw["@id"] ?? fallbackUrl);
  const recordId = manifestUrl.match(/\/biblio\/(\d+)/)?.[1] ?? "EXTERNAL";
  const licenseValue = Array.isArray(raw.rights) ? raw.rights[0] : raw.rights ?? raw.license;
  const titleTranslations = localizedValues(raw.label);
  const attributionTranslations = localizedValues(raw.requiredStatement?.value ?? raw.attribution);

  return {
    url: manifestUrl,
    title: localizedText(titleTranslations, locale) || "無題のIIIF資料",
    titleTranslations: Object.keys(titleTranslations).length ? titleTranslations : { none: "無題のIIIF資料" },
    attribution: localizedText(attributionTranslations, locale) || new URL(fallbackUrl).hostname,
    attributionTranslations: Object.keys(attributionTranslations).length ? attributionTranslations : { none: new URL(fallbackUrl).hostname },
    license: typeof licenseValue === "string" ? licenseValue : "",
    viewingDirection: raw.viewingDirection || "right-to-left",
    recordId,
    status: "iiifLoaded",
    pages,
  };
}

export function buildOcrRequest(manifest: ViewerManifest, page: ViewerPage, eraProfile: string): OcrRequest {
  return {
    manifestId: manifest.url,
    canvasId: page.canvasId,
    imageServiceId: page.imageServiceId,
    eraProfile,
    output: "iiif-annotation-page",
  };
}
