// Colors both sides of one file's diff with Shiki (VS Code's grammars), for mods/river-changes.
//   node highlight.mjs <repo root> <path> <isUntracked: 0|1>
// Prints { old: Line[], new: Line[] } where Line is [color, text, color, text, …]; old is the
// file at HEAD, new the working file. Prints {} for a language Shiki has no grammar for.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import theme from "./theme.mjs";

// Results are kept by content, so a file opened again (or after a restart) costs no coloring.
const CACHE_DIR = `${tmpdir()}/herdr-river-changes-shiki`;

const MAX_BYTES = 400_000;
const MAX_LINE = 2000;
const BY_EXTENSION = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml", svg: "xml", md: "markdown", mdx: "mdx",
  astro: "astro", svelte: "svelte", vue: "vue", yml: "yaml", yaml: "yaml", toml: "toml", sh: "bash", bash: "bash", zsh: "bash", py: "python",
  rs: "rust", go: "go", java: "java", kt: "kotlin", rb: "ruby", php: "php", sql: "sql", graphql: "graphql", gql: "graphql", lua: "lua", c: "c", h: "c", cpp: "cpp",
};

const [root, path, isUntracked] = process.argv.slice(2);
const name = path.split("/").pop().toLowerCase();
const language = name === "dockerfile" ? "docker" : BY_EXTENSION[name.includes(".") ? name.split(".").pop() : ""];

const text = (promise) => promise.then((value) => (value.length > MAX_BYTES ? null : value), () => "");
const run = promisify(execFile);

if (!language) {
  process.stdout.write("{}");
} else {
  const [oldText, newText] = await Promise.all([
    isUntracked === "1" ? "" : text(run("git", ["show", `HEAD:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).then((result) => result.stdout)),
    text(readFile(`${root}/${path}`, "utf8")),
  ]);

  const hash = createHash("sha1").update(JSON.stringify([language, theme, oldText, newText])).digest("hex");
  const cacheFile = `${CACHE_DIR}/${hash}.json`;
  const cached = await readFile(cacheFile, "utf8").catch(() => null);
  if (cached) {
    process.stdout.write(cached);
    process.exit(0);
  }

  const { bundledLanguages, createHighlighter } = await import("shiki");
  if (!(language in bundledLanguages)) {
    process.stdout.write("{}");
    process.exit(0);
  }

  const highlighter = await createHighlighter({ themes: [theme], langs: [language] });
  const color = (source) => {
    if (!source) return [];

    const lines = highlighter.codeToTokens(source, { lang: language, theme: theme.name }).tokens;

    return lines.map((tokens) => {
      const line = [];
      for (const token of tokens) {
        // Neighbours of one color join, so a row is few elements.
        if (line.length && line[line.length - 2] === token.color) line[line.length - 1] += token.content;
        else line.push(token.color, token.content);
      }

      return line.reduce((total, part, index) => total + (index % 2 ? part.length : 0), 0) > MAX_LINE ? [] : line;
    });
  };

  const output = JSON.stringify({ old: color(oldText), new: color(newText) });
  await mkdir(CACHE_DIR, { recursive: true }).then(() => writeFile(cacheFile, output)).catch(() => {});
  process.stdout.write(output);
}
