import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
const root = resolve("work/ocr-evaluation");
const revision = "ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8";
const sources = [
  ["manuscript-manifest.json", "https://kokusho.nijl.ac.jp/biblio/200021552/manifest"],
  ["illustrated-manifest.json", "https://kokusho.nijl.ac.jp/biblio/200011824/manifest"],
  ["scattered-manifest.json", "https://kokusho.nijl.ac.jp/biblio/200043617/manifest"],
  ["scroll-manifest.json", "https://da.dl.itc.u-tokyo.ac.jp/portal/repo/iiif/fbd0479b-dbb4-4eaa-95b8-f27e1c423e4b/manifest"],
  ...["rtmdet-s-1280x1280.onnx", "parseq-ndl-32x384-tiny-10.onnx", "NDLmoji.yaml"].map(name => [
    `models/${name}`, `https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/${revision}/src/${name.endsWith("yaml") ? "config" : "model"}/${name}`,
  ]),
];
await mkdir(`${root}/models`, { recursive: true });
for (const [file, url] of sources) {
  try { if ((await readFile(`${root}/${file}`)).length) continue; } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  await writeFile(`${root}/${file}`, new Uint8Array(await response.arrayBuffer()));
  console.log(`Saved ${file}`);
}
await writeFile(`${root}/sources.json`, JSON.stringify({ revision, sources }, null, 2));

// Preserve the pre-change tracked pipeline as a reproducible comparison, outside production imports.
const baselineRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
for (const path of execFileSync("git", ["ls-tree", "-r", "--name-only", baselineRevision, "src/lib"], { encoding: "utf8" }).trim().split("\n")) {
  if (!path) continue;
  const target = `${root}/legacy/${path}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, execFileSync("git", ["show", `${baselineRevision}:${path}`], { maxBuffer: 20 * 1024 * 1024 }));
}
await writeFile(`${root}/legacy/revision.txt`, baselineRevision + "\n");
