#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("用法：node scripts/translate-document.mjs <英文文本> <中文 Markdown>");
  process.exit(1);
}

const MAX_CHARS = 3600;
const source = await readFile(inputPath, "utf8");

function splitLongBlock(block) {
  if (block.length <= MAX_CHARS) return [block];

  const lines = block.split("\n");
  const parts = [];
  let current = "";

  for (const line of lines) {
    if (line.length > MAX_CHARS) {
      if (current) parts.push(current);
      for (let start = 0; start < line.length; start += MAX_CHARS) {
        parts.push(line.slice(start, start + MAX_CHARS));
      }
      current = "";
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_CHARS) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) parts.push(current);
  return parts;
}

function makeChunks(text) {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .flatMap(splitLongBlock);
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > MAX_CHARS) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function protectTechnicalTokens(text) {
  const values = [];
  const protectedText = text.replace(
    /https?:\/\/\S+|www\.\S+|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g,
    (value) => {
      const index = values.push(value) - 1;
      return `ZXQPH${index}QXZ`;
    },
  );
  return { protectedText, values };
}

function restoreTechnicalTokens(text, values) {
  return text.replace(/ZXQPH\s*(\d+)\s*QXZ/gi, (match, index) => {
    return values[Number(index)] ?? match;
  });
}

async function translate(text) {
  const { protectedText, values } = protectTechnicalTokens(text);
  const body = new URLSearchParams({
    client: "gtx",
    sl: "en",
    tl: "zh-CN",
    dt: "t",
    q: protectedText,
  });

  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(
        "https://translate.googleapis.com/translate_a/single",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const translated = data[0].map((part) => part[0]).join("");
      return restoreTechnicalTokens(translated, values);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * 2 ** attempt),
      );
    }
  }

  throw lastError;
}

const chunks = makeChunks(source);
const translated = [];

for (let index = 0; index < chunks.length; index += 1) {
  translated.push(await translate(chunks[index]));
  console.log(`已翻译 ${index + 1}/${chunks.length} 个文本块`);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const notice = `# UltraScale FPGA 收发器向导 v1.7 LogiCORE IP 产品指南

> PG182 (v1.7)，2020 年 12 月 4 日  
> 本文档是英文原文的机器翻译，供中文检索与阅读参考。端口名、信号名、参数名、产品名和 URL 尽量保留原文；若译文与英文原文有歧义或冲突，以英文原文为准。

`;

await writeFile(outputPath, notice + translated.join("\n\n") + "\n", "utf8");
console.log(`译文已写入 ${outputPath}`);
