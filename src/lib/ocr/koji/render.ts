import { parseKoji, type KojiNode } from "./parse.ts";

export type SafeKojiRenderNode =
  | { type: "text"; text: string }
  | { type: "ruby"; base: SafeKojiRenderNode[]; reading: SafeKojiRenderNode[]; alternateReading?: SafeKojiRenderNode[] }
  | { type: "kaeriten"; children: SafeKojiRenderNode[] }
  | { type: "okurigana"; children: SafeKojiRenderNode[] }
  | { type: "warichu"; right: SafeKojiRenderNode[]; left?: SafeKojiRenderNode[] };

function renderText(nodes: SafeKojiRenderNode[]): string {
  return nodes.map((child) => {
    if (child.type === "text") return child.text;
    if (child.type === "ruby") return `${renderText(child.base)}${renderText(child.reading)}`;
    if (child.type === "warichu") return `${renderText(child.right)}${child.left ? renderText(child.left) : ""}`;
    return renderText(child.children);
  }).join("");
}

function renderNode(node: KojiNode): SafeKojiRenderNode {
  switch (node.type) {
    case "text": return { type: "text", text: node.value };
    case "ruby": return {
      type: "ruby",
      base: node.base.map(renderNode),
      reading: node.reading.map(renderNode),
      ...(node.alternateReading ? { alternateReading: node.alternateReading.map(renderNode) } : {}),
    };
    case "kaeriten": return { type: "kaeriten", children: node.children.map(renderNode) };
    case "okurigana": return { type: "okurigana", children: node.children.map(renderNode) };
    case "warichu": return {
      type: "warichu",
      right: node.right.map(renderNode),
      ...(node.left ? { left: node.left.map(renderNode) } : {}),
    };
    case "tate": return { type: "text", text: "ー" };
    case "block": return { type: "text", text: "" };
    case "unknown": return { type: "text", text: renderText(node.children.map(renderNode)) };
  }
}

/** Return a data-only render model. It is safe to use in Svelte without {@html}. */
export function buildSafeKojiRenderModel(rawKoji: string): SafeKojiRenderNode[] {
  return parseKoji(rawKoji).map(renderNode);
}
