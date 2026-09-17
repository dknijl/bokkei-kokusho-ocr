export type KojiNode =
  | { type: "text"; value: string }
  | { type: "ruby"; base: KojiNode[]; reading: KojiNode[]; alternateReading?: KojiNode[] }
  | { type: "kaeriten"; children: KojiNode[] }
  | { type: "okurigana"; children: KojiNode[] }
  | { type: "warichu"; right: KojiNode[]; left?: KojiNode[] }
  | { type: "tate" }
  | { type: "block" }
  | { type: "unknown"; name: string; children: KojiNode[] };

type RawNode =
  | { kind: "text"; value: string }
  | { kind: "tag"; name: string; children: RawNode[] };

type RawContainer = { name: string; children: RawNode[] };

const TAG_PATTERN = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>/y;

function appendNode(stack: RawContainer[], node: RawNode): void {
  stack[stack.length - 1]?.children.push(node);
}

function closeTag(stack: RawContainer[], name: string): boolean {
  const index = [...stack].reverse().findIndex((container) => container.name === name);
  if (index < 0) return false;
  const targetIndex = stack.length - 1 - index;
  while (stack.length - 1 >= targetIndex) {
    const container = stack.pop();
    if (!container) break;
    appendNode(stack, { kind: "tag", name: container.name, children: container.children });
  }
  return true;
}

function parseRawKoji(raw: string): RawNode[] {
  const root: RawContainer = { name: "__root__", children: [] };
  const stack: RawContainer[] = [root];
  let offset = 0;
  while (offset < raw.length) {
    const tagStart = raw.indexOf("<", offset);
    if (tagStart < 0) {
      appendNode(stack, { kind: "text", value: raw.slice(offset) });
      break;
    }
    if (tagStart > offset) appendNode(stack, { kind: "text", value: raw.slice(offset, tagStart) });
    TAG_PATTERN.lastIndex = tagStart;
    const match = TAG_PATTERN.exec(raw);
    if (!match) {
      appendNode(stack, { kind: "text", value: "<" });
      offset = tagStart + 1;
      continue;
    }
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const token = match[0];
    const selfClosing = /\/\s*>$/.test(token);
    if (closing) {
      if (!closeTag(stack, name)) appendNode(stack, { kind: "text", value: token });
    } else if (selfClosing) {
      appendNode(stack, { kind: "tag", name, children: [] });
    } else {
      stack.push({ name, children: [] });
    }
    offset = tagStart + token.length;
  }
  while (stack.length > 1) {
    const container = stack.pop();
    if (!container) break;
    appendNode(stack, { kind: "tag", name: container.name, children: container.children });
  }
  return root.children;
}

function convertChildren(nodes: RawNode[]): KojiNode[] {
  return nodes.flatMap(convertNode);
}

function convertNode(node: RawNode): KojiNode[] {
  if (node.kind === "text") return node.value ? [{ type: "text", value: node.value }] : [];
  switch (node.name) {
    case "ruby": {
      const readingIndex = node.children.findIndex(
        (child) => child.kind === "tag" && (child.name === "rt" || child.name === "rt2"),
      );
      const baseChildren = readingIndex < 0 ? node.children : node.children.slice(0, readingIndex);
      const reading = node.children.find((child) => child.kind === "tag" && child.name === "rt");
      const alternate = node.children.find((child) => child.kind === "tag" && child.name === "rt2");
      return [{
        type: "ruby",
        base: convertChildren(baseChildren),
        reading: reading && reading.kind === "tag" ? convertChildren(reading.children) : [],
        ...(alternate && alternate.kind === "tag" ? { alternateReading: convertChildren(alternate.children) } : {}),
      }];
    }
    case "kaeri":
      return [{ type: "kaeriten", children: convertChildren(node.children) }];
    case "okuri":
      return [{ type: "okurigana", children: convertChildren(node.children) }];
    case "wari": {
      const separator = node.children.findIndex(
        (child) => child.kind === "tag" && child.name === "wari_sep",
      );
      const right = separator < 0 ? node.children : node.children.slice(0, separator);
      const left = separator < 0 ? undefined : node.children.slice(separator + 1);
      return [{ type: "warichu", right: convertChildren(right), ...(left ? { left: convertChildren(left) } : {}) }];
    }
    case "tate":
      return [{ type: "tate" }];
    case "block":
      return [{ type: "block" }];
    case "rt":
    case "rt2":
    case "wari_sep":
      return convertChildren(node.children);
    default:
      return [{ type: "unknown", name: node.name, children: convertChildren(node.children) }];
  }
}

/** Parse Koji tags into data-only nodes. No input is interpreted as HTML. */
export function parseKoji(raw: string): KojiNode[] {
  return convertChildren(parseRawKoji(raw));
}

export function kojiNodeText(nodes: KojiNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "ruby":
        return `${kojiNodeText(node.base)}${kojiNodeText(node.reading)}${node.alternateReading ? kojiNodeText(node.alternateReading) : ""}`;
      case "warichu":
        return `${kojiNodeText(node.right)}${node.left ? kojiNodeText(node.left) : ""}`;
      case "kaeriten":
      case "okurigana":
      case "unknown":
        return kojiNodeText(node.children);
      case "tate":
        return "ー";
      case "block":
        return "";
    }
  }).join("");
}
