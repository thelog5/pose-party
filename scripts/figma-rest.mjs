#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const source = await readFile(path.join(root, name), "utf8");
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
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

async function figmaGet(endpoint, query = {}) {
  const token = process.env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Missing FIGMA_ACCESS_TOKEN. Add a NEW token to the repo-root .env file.",
    );
  }

  const url = new URL(endpoint, "https://api.figma.com");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Figma-Token": token,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.message || body.err || response.statusText;
    throw new Error(`Figma API ${response.status}: ${detail}`);
  }
  return body;
}

function usage() {
  console.log(`Figma REST helper

Usage:
  node scripts/figma-rest.mjs me
  node scripts/figma-rest.mjs file <figma-url-or-file-key>
  node scripts/figma-rest.mjs nodes <figma-node-url>
  node scripts/figma-rest.mjs get </v1/endpoint>

The helper reads FIGMA_ACCESS_TOKEN from .env.local, .env, or the shell.
It never prints the token.`);
}

await loadLocalEnv();

const [command = "me", input] = process.argv.slice(2);

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

