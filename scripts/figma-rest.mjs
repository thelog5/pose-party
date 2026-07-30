#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const source = await readFile(path.join(root, name), "utf8");
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        /* tolerate stray spaces around the key ("FIGMA_ACCESS_TOKEN_2 =...") */
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match || process.env[match[1]]) continue;
        let value = match[2].trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      }
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function fileKeyFrom(input = "") {
  const value = input.trim();
  const urlMatch = value.match(
    /figma\.com\/(?:design|file|board)\/([A-Za-z0-9_-]+)/i,
  );
  return urlMatch?.[1] || value;
}

function nodeIdFrom(input = "") {
  try {
    const url = new URL(input);
    return (url.searchParams.get("node-id") || "").replace("-", ":");
  } catch {
    return "";
  }
}

/* Every configured token, in order. Consecutive calls alternate between them
   so a burst spreads across accounts instead of hammering one rate limit. */
function tokens() {
  const configured = [
    process.env.FIGMA_ACCESS_TOKEN,
    process.env.FIGMA_ACCESS_TOKEN_2,
    process.env.FIGMA_ACCESS_TOKEN_3 || process.env.Figma_3,
  ].map((t) => t?.trim());
  const requested = Number.parseInt(process.env.FIGMA_TOKEN_SLOT || "", 10);
  if(Number.isInteger(requested) && configured[requested - 1])
    return [configured[requested - 1]];
  return configured.filter(Boolean);
}

/* The CLI normally performs one request and exits, so an in-memory counter
   always restarted at token one. Persist only the next numeric cursor in the
   OS temp directory; no token or response data is ever written there. */
const tokenCursorFile = path.join(os.tmpdir(), "pose-party-figma-token-cursor");

async function nextTokenStart(count) {
  let cursor = 0;
  try {
    cursor = Number.parseInt(await readFile(tokenCursorFile, "utf8"), 10) || 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(tokenCursorFile, String(cursor + 1), "utf8");
  return cursor % count;
}

async function figmaGet(endpoint, query = {}) {
  const pool = tokens();
  if (!pool.length) {
    throw new Error(
      "Missing FIGMA_ACCESS_TOKEN. Add a NEW token to the repo-root .env file.",
    );
  }

  const url = new URL(endpoint, "https://api.figma.com");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  /* start on the rotated token, then fall through to the others on 429 */
  const start = await nextTokenStart(pool.length);
  let last;
  for (let hop = 0; hop < pool.length; hop++) {
    const which = (start + hop) % pool.length;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Figma-Token": pool[which] },
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    last = `Figma API ${response.status}: ${body.message || body.err || response.statusText} (token ${which + 1}/${pool.length})`;
    if (response.status !== 429) break;   // only rate limits are worth retrying
  }
  throw new Error(last);
}

function usage() {
  console.log(`Figma REST helper

Usage:
  node scripts/figma-rest.mjs me
  node scripts/figma-rest.mjs file <figma-url-or-file-key>
  node scripts/figma-rest.mjs overview <figma-url-or-file-key> [page-name]
  node scripts/figma-rest.mjs nodes <figma-node-url>
  node scripts/figma-rest.mjs tree <figma-node-url>
  node scripts/figma-rest.mjs snapshot <figma-node-url> <output-json>
  node scripts/figma-rest.mjs snapshot-nodes <figma-url-or-key> <node-ids> <output-json>
  node scripts/figma-rest.mjs renders <figma-url-or-key> <node-ids> [scale]
  node scripts/figma-rest.mjs download-renders <figma-url-or-key> <node-ids> <directory>
  node scripts/figma-rest.mjs catalog-images <figma-url-or-key> <directory> [max-bytes]
  node scripts/figma-rest.mjs catalog-page <directory> [all|portrait|wide|tall|page:N]
  node scripts/figma-rest.mjs get </v1/endpoint>

The helper reads FIGMA_ACCESS_TOKEN, FIGMA_ACCESS_TOKEN_2, and
FIGMA_ACCESS_TOKEN_3 from .env.local, .env, or the shell.
It never prints the token.`);
}

await loadLocalEnv();

const [command = "me", input, extra, option] = process.argv.slice(2);

function paintSummary(paints = []) {
  return paints.filter(p => p?.visible !== false).map(p => ({
    type: p.type,
    opacity: p.opacity,
    color: p.color,
    imageRef: p.imageRef,
    scaleMode: p.scaleMode,
  }));
}

function flattenNode(node, parent = "", out = []) {
  const box = node.absoluteBoundingBox;
  out.push({
    path: parent ? `${parent}/${node.name}` : node.name,
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
    box: box && {
      x: Math.round(box.x * 100) / 100,
      y: Math.round(box.y * 100) / 100,
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
    },
    rotation: node.rotation,
    opacity: node.opacity,
    characters: node.characters,
    style: node.type === "TEXT" ? node.style : undefined,
    componentId: node.componentId,
    componentProperties: node.componentProperties,
    fills: paintSummary(node.fills),
    strokes: paintSummary(node.strokes),
    effects: node.effects?.filter(e => e.visible !== false),
  });
  for (const child of node.children || []) flattenNode(child, parent ? `${parent}/${node.name}` : node.name, out);
  return out;
}

const imageExtension = contentType => ({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}[String(contentType || "").split(";")[0].toLowerCase()] || ".bin");

function pngDimensions(buffer) {
  if (buffer?.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

try {
  if (command === "me") {
    const me = await figmaGet("/v1/me");
    console.log(
      JSON.stringify(
        {
          id: me.id,
          handle: me.handle,
          email: me.email,
        },
        null,
        2,
      ),
    );
  } else if (command === "file") {
    if (!input) throw new Error("Provide a Figma file URL or file key.");
    const file = await figmaGet(`/v1/files/${encodeURIComponent(fileKeyFrom(input))}`, {
      depth: "1",
    });
    console.log(
      JSON.stringify(
        {
          name: file.name,
          role: file.role,
          editorType: file.editorType,
          lastModified: file.lastModified,
          version: file.version,
          pages: file.document?.children?.map(({ id, name, type }) => ({
            id,
            name,
            type,
          })),
        },
        null,
        2,
      ),
    );
  } else if (command === "overview") {
    if (!input) throw new Error("Provide a Figma file URL or file key.");
    const file = await figmaGet(`/v1/files/${encodeURIComponent(fileKeyFrom(input))}`, {
      depth: "2",
    });
    const pages = (file.document?.children || [])
      .filter(page => !extra || page.name.toLowerCase().includes(extra.toLowerCase()))
      .map(page => ({
        id: page.id,
        name: page.name,
        children: (page.children || []).map(node => ({
          id: node.id,
          name: node.name,
          type: node.type,
          box: node.absoluteBoundingBox && {
            x: Math.round(node.absoluteBoundingBox.x * 100) / 100,
            y: Math.round(node.absoluteBoundingBox.y * 100) / 100,
            width: Math.round(node.absoluteBoundingBox.width * 100) / 100,
            height: Math.round(node.absoluteBoundingBox.height * 100) / 100,
          },
        })),
      }));
    console.log(JSON.stringify({
      file: file.name,
      lastModified: file.lastModified,
      pages,
    }, null, 2));
  } else if (command === "nodes") {
    if (!input) throw new Error("Provide a Figma URL containing node-id.");
    const nodeId = nodeIdFrom(input);
    if (!nodeId) throw new Error("The Figma URL does not contain a node-id.");
    const key = fileKeyFrom(input);
    const nodes = await figmaGet(
      `/v1/files/${encodeURIComponent(key)}/nodes`,
      { ids: nodeId },
    );
    console.log(JSON.stringify(nodes, null, 2));
  } else if (command === "tree") {
    if (!input) throw new Error("Provide a Figma URL containing node-id.");
    const nodeId = nodeIdFrom(input);
    if (!nodeId) throw new Error("The Figma URL does not contain node-id.");
    const key = fileKeyFrom(input);
    const nodes = await figmaGet(
      `/v1/files/${encodeURIComponent(key)}/nodes`,
      { ids: nodeId },
    );
    const rootNode = nodes.nodes?.[nodeId]?.document;
    if (!rootNode) throw new Error(`Node ${nodeId} was not returned.`);
    console.log(JSON.stringify({
      file: nodes.name,
      lastModified: nodes.lastModified,
      nodeId,
      tree: flattenNode(rootNode),
    }, null, 2));
  } else if (command === "snapshot") {
    if (!input || !extra) {
      throw new Error("Provide a Figma URL containing node-id and an output JSON path.");
    }
    const nodeId = nodeIdFrom(input);
    if (!nodeId) throw new Error("The Figma URL does not contain a node-id.");
    const key = fileKeyFrom(input);
    const nodes = await figmaGet(
      `/v1/files/${encodeURIComponent(key)}/nodes`,
      { ids: nodeId },
    );
    const rootNode = nodes.nodes?.[nodeId]?.document;
    if (!rootNode) throw new Error(`Node ${nodeId} was not returned.`);
    const snapshot = {
      file: nodes.name,
      lastModified: nodes.lastModified,
      nodeId,
      tree: flattenNode(rootNode),
    };
    await writeFile(extra, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(JSON.stringify({
      output: path.resolve(extra),
      file: snapshot.file,
      nodeId,
      nodes: snapshot.tree.length,
      lastModified: snapshot.lastModified,
    }, null, 2));
  } else if (command === "snapshot-nodes") {
    if (!input || !extra || !option) {
      throw new Error(
        "Provide a Figma URL/file key, comma-separated node IDs, and an output JSON path.",
      );
    }
    const ids = extra.replaceAll("-", ":");
    const nodes = await figmaGet(
      `/v1/files/${encodeURIComponent(fileKeyFrom(input))}/nodes`,
      { ids },
    );
    await writeFile(option, JSON.stringify(nodes, null, 2), "utf8");
    console.log(JSON.stringify({
      output: path.resolve(option),
      file: nodes.name,
      requested: ids.split(","),
      returned: Object.keys(nodes.nodes || {}),
      lastModified: nodes.lastModified,
    }, null, 2));
  } else if (command === "renders") {
    if (!input || !extra) {
      throw new Error("Provide a Figma URL/file key and comma-separated node IDs.");
    }
    const scale = Math.max(.01, Math.min(4, Number(option) || 1));
    const rendered = await figmaGet(
      `/v1/images/${encodeURIComponent(fileKeyFrom(input))}`,
      { ids: extra.replaceAll("-", ":"), format: "png", scale: String(scale) },
    );
    console.log(JSON.stringify(rendered, null, 2));
  } else if (command === "download-renders") {
    if (!input || !extra || !option) {
      throw new Error(
        "Provide a Figma URL/file key, comma-separated node IDs, and an output directory.",
      );
    }
    const scale = Math.max(
      .01,
      Math.min(4, Number(process.env.FIGMA_RENDER_SCALE) || 1),
    );
    const rendered = await figmaGet(
      `/v1/images/${encodeURIComponent(fileKeyFrom(input))}`,
      { ids: extra.replaceAll("-", ":"), format: "png", scale: String(scale) },
    );
    await mkdir(option, { recursive: true });
    const downloads = await mapLimit(
      Object.entries(rendered.images || {}),
      4,
      async ([id, url]) => {
        if (!url) return { id, downloaded: false };
        const response = await fetch(url);
        if (!response.ok) {
          return { id, downloaded: false, status: response.status };
        }
        const filename = id.replace(":", "-") + ".png";
        const data = Buffer.from(await response.arrayBuffer());
        await writeFile(path.join(option, filename), data);
        return { id, filename, bytes: data.length, downloaded: true };
      },
    );
    console.log(JSON.stringify({
      directory: path.resolve(option),
      scale,
      downloads,
    }, null, 2));
  } else if (command === "catalog-images") {
    if (!input || !extra) {
      throw new Error("Provide a Figma URL/file key and an output directory.");
    }
    const maxBytes = Math.max(1024, Number(option) || 1500000);
    const key = fileKeyFrom(input);
    const response = await figmaGet(`/v1/files/${encodeURIComponent(key)}/images`);
    const entries = Object.entries(response.meta?.images || {});
    await mkdir(extra, { recursive: true });
    const catalog = await mapLimit(entries, 8, async ([imageRef, url]) => {
      try {
        const head = await fetch(url, { method: "HEAD" });
        const bytes = Number(head.headers.get("content-length")) || 0;
        const contentType = head.headers.get("content-type") || "";
        if (!head.ok || (bytes && bytes > maxBytes)) {
          return { imageRef, bytes, contentType, downloaded: false };
        }
        const image = await fetch(url);
        if (!image.ok) return { imageRef, bytes, contentType, downloaded: false };
        const data = Buffer.from(await image.arrayBuffer());
        if (data.length > maxBytes) {
          return { imageRef, bytes: data.length, contentType, downloaded: false };
        }
        const filename = imageRef + imageExtension(contentType);
        await writeFile(path.join(extra, filename), data);
        return { imageRef, filename, bytes: data.length, contentType, downloaded: true };
      } catch (error) {
        return { imageRef, downloaded: false, error: error.message };
      }
    });
    await writeFile(path.join(extra, "index.json"), JSON.stringify(catalog, null, 2), "utf8");
    console.log(JSON.stringify({
      directory: path.resolve(extra),
      total: catalog.length,
      downloaded: catalog.filter(item => item.downloaded).length,
      skipped: catalog.filter(item => !item.downloaded).length,
      maxBytes,
    }, null, 2));
  } else if (command === "catalog-page") {
    if (!input) throw new Error("Provide an image-catalog directory.");
    const catalog = JSON.parse(await readFile(path.join(input, "index.json"), "utf8"));
    const mode = extra || "all";
    const withDimensions = await mapLimit(catalog.filter(item => item.downloaded), 12, async item => ({
      ...item,
      dimensions: pngDimensions(await readFile(path.join(input, item.filename))),
    }));
    let selected = withDimensions.filter(item => {
      const d = item.dimensions;
      if (!d || !d.height) return mode === "all";
      const ratio = d.width / d.height;
      if (mode === "portrait") return ratio >= .65 && ratio <= .95;
      if (mode === "wide") return ratio >= 3.5 && ratio <= 5;
      if (mode === "tall") return ratio <= .16;
      return true;
    });
    if (mode.startsWith("page:")) {
      const page = Math.max(0, Number(mode.slice(5)) || 0);
      selected = withDimensions.slice(page * 36, page * 36 + 36);
    }
    const cards = selected.map(item =>
      `<figure><div><img loading="lazy" src="${encodeURIComponent(item.filename)}"></div>` +
      `<figcaption>${item.imageRef}<small>${item.dimensions ? `${item.dimensions.width}×${item.dimensions.height} · ` : ""}` +
      `${item.bytes} bytes</small></figcaption></figure>`
    ).join("");
    const html = `<!doctype html><meta charset="utf-8"><title>Figma image catalog</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#171b2b;color:#fff;font:12px/1.3 ui-monospace,monospace}
main{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;padding:12px}
figure{margin:0;padding:8px;background:#252b42;border:1px solid #3a4364;border-radius:8px;min-width:0}
figure>div{height:150px;display:grid;place-items:center;overflow:hidden;
background:conic-gradient(#eee 25%,#ccc 0 50%,#eee 0 75%,#ccc 0) 0 0/18px 18px}
img{display:block;max-width:100%;max-height:100%;object-fit:contain}
figcaption{padding-top:7px;overflow-wrap:anywhere}small{display:block;color:#aeb9da;margin-top:3px}
</style><main>${cards}</main>`;
    const output = path.join(input, `catalog-${mode.replace(/[^a-z0-9_-]+/gi, "-")}.html`);
    await writeFile(output, html, "utf8");
    console.log(output);
  } else if (command === "get") {
    if (!input?.startsWith("/v1/")) {
      throw new Error("The endpoint must begin with /v1/.");
    }
    console.log(JSON.stringify(await figmaGet(input), null, 2));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
