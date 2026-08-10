import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { sites } from "./build/sites-vite-plugin.ts";

const workerSource = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accept = request.headers.get("accept") || "";

    // A BID is an application route, not a static asset. Serving the root
    // document internally keeps the original /{bid} URL in the browser.
    // Asking ASSETS for /index.html causes Sites to canonicalize it to /.
    if (
      request.method === "GET" &&
      accept.includes("text/html") &&
      /^\\/\\d+\\/?$/.test(url.pathname)
    ) {
      const appShell = new URL("/", request.url);
      return env.ASSETS.fetch(new Request(appShell, request));
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    if (!accept.includes("text/html")) return response;

    const fallback = new URL("/", request.url);
    return env.ASSETS.fetch(new Request(fallback, request));
  }
};
`;

function sitesWorker(): Plugin {
  let root = process.cwd();

  return {
    name: "sites-svelte-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      await rm(resolve(root, "dist"), { recursive: true, force: true });
    },
    async closeBundle() {
      const serverDir = resolve(root, "dist", "server");
      await mkdir(serverDir, { recursive: true });
      await writeFile(resolve(serverDir, "index.js"), workerSource.trimStart());
    },
  };
}

export default defineConfig({
  base: "/ocr/",
  plugins: [svelte(), sitesWorker(), sites()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
