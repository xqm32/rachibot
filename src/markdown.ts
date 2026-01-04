import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeStarryNight from "rehype-starry-night";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import markdownStyle from "github-markdown-css/github-markdown.css" with { type: "text" };
import katexStyle from "katex/dist/katex.min.css" with { type: "text" };
import starryNightStyleCore from "@wooorm/starry-night/style/core" with { type: "text" };
import starryNightStyleLight from "@wooorm/starry-night/style/light" with { type: "text" };
import starryNightStyleDark from "@wooorm/starry-night/style/dark" with { type: "text" };

// Initialize oniguruma manually, prevent starry night doing wrong stuff in compiled executable
import oniguruma from "vscode-oniguruma";
import { readFileSync } from "node:fs";
// @ts-expect-error no typings for now
import onigurumaWasmPath from "vscode-oniguruma/release/onig.wasm" with { type: "file" };
oniguruma.loadWASM(readFileSync(onigurumaWasmPath));

export async function markdownToHtml(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(rehypeKatex)
    .use(rehypeStarryNight)
    .use(rehypeStringify)
    .process(markdown);
  return `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title></title>
<style>
body {
  margin: 0;
}
.container {
  width: auto;
  margin: 0 auto;
  padding: 1.25rem;
}
@media (min-width: 640px) {
  .container {
    max-width: 640px;
    padding: 3rem;
  }
}
@media (min-width: 768px) {
  .container {
    max-width: 768px;
  }
}
@media (min-width: 1024px) {
  .container {
    max-width: 1024px;
  }
}
@media (min-width: 1280px) {
  .container {
    max-width: 1280px;
  }
}
@media (min-width: 1536px) {
  .container {
    max-width: 1536px;
  }
}
@layer components {
  ${markdownStyle}
}
${katexStyle.replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.16.27/dist/fonts/')}
${starryNightStyleCore}
@media (prefers-color-scheme: light) {
body {
  background: #ffffff;
}
${starryNightStyleLight}
}
@media (prefers-color-scheme: dark) {
body {
  background: #0d1117;
}
${starryNightStyleDark}
}
</style>
<article class="container markdown-body">${String(file)}</article>`;
}
