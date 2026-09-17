import { kojiNodeText, parseKoji, type KojiNode } from "./parse.ts";

export function rawKojiToPlainText(rawKoji: string): string {
  return kojiNodeText(parseKoji(rawKoji));
}

export function structuredOcrText(rawKoji: string): {
  format: "koji";
  raw: string;
  plain: string;
} {
  return { format: "koji", raw: rawKoji, plain: rawKojiToPlainText(rawKoji) };
}

export function kojiNodesToPlainText(nodes: KojiNode[]): string {
  return kojiNodeText(nodes);
}
