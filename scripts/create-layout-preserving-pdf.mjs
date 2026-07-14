#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [inputPath, outputPath] = process.argv.slice(2);
const fontPath =
  process.env.CJK_FONT ??
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf";

if (!inputPath || !outputPath) {
  console.error(
    "用法：node scripts/create-layout-preserving-pdf.mjs <英文 PDF> <中文 PDF>",
  );
  process.exit(1);
}

const sourceBytes = new Uint8Array(await readFile(inputPath));
const sourceForPdfJs = sourceBytes.slice();
const sourceForPdfLib = sourceBytes.slice();
const fontBytes = new Uint8Array(await readFile(fontPath));

const sourcePdf = await getDocument({
  data: sourceForPdfJs,
  disableWorker: true,
}).promise;
const outputPdf = await PDFDocument.load(sourceForPdfLib);
outputPdf.registerFontkit(fontkit);
const chineseFont = await outputPdf.embedFont(fontBytes, { subset: true });
const latinFont = await outputPdf.embedFont(StandardFonts.Helvetica);
const chineseCharacters = new Set(chineseFont.getCharacterSet());
const latinCharacters = new Set(latinFont.getCharacterSet());

function groupTextItems(items) {
  const rows = [];

  for (const item of items) {
    if (!item.str?.trim() || !item.transform) continue;

    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > 0.1 || Math.abs(c) > 0.1 || a <= 0 || d <= 0) continue;

    let row = rows.find(
      (candidate) =>
        Math.abs(candidate.y - y) <= 0.8 &&
        Math.abs(candidate.height - item.height) <= 1.5,
    );
    if (!row) {
      row = { y, height: item.height, items: [] };
      rows.push(row);
    }
    row.items.push({ ...item, x, y });
  }

  const segments = [];
  for (const row of rows) {
    const sorted = row.items.sort((left, right) => left.x - right.x);
    let current;

    for (const item of sorted) {
      const previousRight = current ? current.x + current.width : 0;
      const gap = item.x - previousRight;
      if (!current || gap > 4) {
        if (current) segments.push(current);
        current = {
          text: item.str,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        };
      } else {
        current.text += item.str;
        current.width = item.x + item.width - current.x;
        current.height = Math.max(current.height, item.height);
      }
    }
    if (current) segments.push(current);
  }

  return segments.sort((left, right) => {
    const rowDifference = right.y - left.y;
    return Math.abs(rowDifference) > 0.8 ? rowDifference : left.x - right.x;
  });
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

async function requestTranslation(text) {
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
      if (!response.ok) throw new Error(`翻译接口返回 HTTP ${response.status}`);
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

async function translateSegments(segments) {
  if (!segments.length) return [];

  const markedText = segments
    .map((segment, index) => `ZXQL${index}QXZ ${segment.text}`)
    .join("\n");
  const translated = await requestTranslation(markedText);
  const matches = [
    ...translated.matchAll(
      /ZXQL\s*(\d+)\s*QXZ\s*([\s\S]*?)(?=ZXQL\s*\d+\s*QXZ|$)/gi,
    ),
  ];

  if (matches.length === segments.length) {
    const result = new Array(segments.length);
    for (const match of matches) {
      result[Number(match[1])] = match[2].trim();
    }
    if (result.every(Boolean)) return result;
  }

  console.warn("页面分段标记发生变化，正在逐段补译");
  return Promise.all(segments.map((segment) => requestTranslation(segment.text)));
}

function makeFontRuns(text) {
  const runs = [];

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const font = chineseCharacters.has(codePoint)
      ? chineseFont
      : latinCharacters.has(codePoint)
        ? latinFont
        : chineseFont;
    const lastRun = runs.at(-1);
    if (lastRun?.font === font) {
      lastRun.text += character;
    } else {
      runs.push({ text: character, font });
    }
  }
  return runs;
}

function widthOfRunsAtSize(runs, size) {
  return runs.reduce(
    (width, run) => width + run.font.widthOfTextAtSize(run.text, size),
    0,
  );
}

function fitFontSize(runs, preferredSize, maxWidth) {
  let size = Math.max(5, preferredSize);
  while (size > 5 && widthOfRunsAtSize(runs, size) > maxWidth) {
    size -= 0.25;
  }
  return size;
}

function normalizeTranslation(text) {
  return text
    .replaceAll("知识产权事实", "IP 概况")
    .replaceAll("重置", "复位")
    .replaceAll("模拟", "仿真")
    .replaceAll("测试台", "测试平台")
    .replaceAll("设备系列", "器件系列");
}

for (let pageIndex = 0; pageIndex < sourcePdf.numPages; pageIndex += 1) {
  const sourcePage = await sourcePdf.getPage(pageIndex + 1);
  const textContent = await sourcePage.getTextContent();
  const segments = groupTextItems(textContent.items);
  const translations = await translateSegments(segments);
  const outputPage = outputPdf.getPage(pageIndex);
  const { width: pageWidth } = outputPage.getSize();

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const text = normalizeTranslation(translations[index] ?? segment.text);
    const runs = makeFontRuns(text);
    const preferredSize = Math.max(5, segment.height * 0.88);
    const availableWidth = Math.max(
      segment.width + 3,
      Math.min(pageWidth - segment.x - 3, segment.width * 1.18),
    );
    const fontSize = fitFontSize(runs, preferredSize, availableWidth);
    const textWidth = Math.min(
      availableWidth,
      widthOfRunsAtSize(runs, fontSize),
    );
    const backgroundWidth = Math.max(segment.width, textWidth) + 2;
    const backgroundHeight = Math.max(segment.height, fontSize) + 3;

    outputPage.drawRectangle({
      x: segment.x - 1,
      y: segment.y - 2,
      width: backgroundWidth,
      height: backgroundHeight,
      color: rgb(1, 1, 1),
    });
    const color =
      segment.height >= 17
        ? rgb(0.08, 0.32, 0.5)
        : rgb(0.05, 0.05, 0.05);
    let textX = segment.x;
    for (const run of runs) {
      outputPage.drawText(run.text, {
        x: textX,
        y: segment.y,
        size: fontSize,
        font: run.font,
        color,
      });
      textX += run.font.widthOfTextAtSize(run.text, fontSize);
    }
  }

  sourcePage.cleanup();
  console.log(
    `已处理第 ${pageIndex + 1}/${sourcePdf.numPages} 页（${segments.length} 个文本区域）`,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
}

outputPdf.setTitle("UltraScale FPGA 收发器向导 v1.7 LogiCORE IP 产品指南（中文）");
outputPdf.setSubject("PG182 (v1.7) 中文参考译本");
outputPdf.setCreator("Cursor Cloud Agent");
outputPdf.setProducer("pdf-lib");

const outputBytes = await outputPdf.save({
  useObjectStreams: true,
  addDefaultPage: false,
});
await writeFile(outputPath, outputBytes);
console.log(`中文版 PDF 已写入 ${outputPath}`);
