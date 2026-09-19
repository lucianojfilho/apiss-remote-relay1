'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILES = 50;
const MAX_PDF_BYTES = 300 * 1024 * 1024;

function assertNotAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Conversão cancelada.'), { code: 'CANCELLED' });
}

function normalizeSpaces(value) {
  return String(value || '').replace(/[\t\u00a0]+/g, ' ').replace(/ +/g, ' ').trim();
}

function fontSize(item) {
  const transform = item && item.transform || [];
  return Math.max(Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0), Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0));
}

function isBoldFont(item, styles) {
  const style = styles && styles[item.fontName] || {};
  return /bold|black|heavy|semibold|demi/i.test(`${item.fontName || ''} ${style.fontFamily || ''} ${style.loadedName || ''}`);
}

function extractLines(content) {
  const lines = [];
  let current = null;
  function flush() {
    if (!current) return;
    current.text = normalizeSpaces(current.parts.join(' '));
    if (current.text) lines.push(current);
    current = null;
  }
  for (const item of content.items || []) {
    const text = normalizeSpaces(item.str);
    if (!text) { if (item.hasEOL) flush(); continue; }
    const size = fontSize(item) || 10;
    const y = Number(item.transform && item.transform[5]) || 0;
    if (current && Math.abs(current.y - y) > Math.max(size, current.size) * 0.55) flush();
    if (!current) current = { parts: [], size, y, bold: false };
    current.parts.push(text);
    current.size = Math.max(current.size, size);
    current.bold = current.bold || isBoldFont(item, content.styles);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

function bodyFontSize(pages) {
  const weights = new Map();
  pages.slice(0, 20).forEach((page) => page.lines.forEach((line) => {
    const bucket = Math.round(line.size * 2) / 2;
    weights.set(bucket, (weights.get(bucket) || 0) + line.text.length);
  }));
  let result = 0;
  let maximum = 0;
  weights.forEach((weight, size) => { if (weight > maximum) { maximum = weight; result = size; } });
  return result || 10;
}

function formatLine(line, bodySize) {
  const text = line.text;
  if (text.length <= 140) {
    const ratio = line.size / bodySize;
    const level = ratio >= 1.5 ? 1 : ratio >= 1.3 ? 2 : ratio >= 1.15 ? 3 : 0;
    if (level) return `${'#'.repeat(level)} ${text}`;
  }
  const bullet = text.match(/^[•●◦⁃]\s*(.+)$/);
  if (bullet) return `- ${bullet[1].trim()}`;
  const numbered = text.match(/^(\d{1,3})[.)]\s+(.+)$/);
  if (numbered) return `${numbered[1]}. ${numbered[2].trim()}`;
  if (line.bold && text.length < 120) return `**${text}**`;
  return text;
}

function mergeLines(lines, bodySize) {
  const output = [];
  const buffer = [];
  function flush() {
    if (!buffer.length) return;
    output.push(buffer.join(' '));
    buffer.length = 0;
  }
  lines.map((line) => formatLine(line, bodySize)).forEach((line) => {
    if (/^#{1,3} |^- |^\d+\.\s/.test(line)) { flush(); output.push(line); }
    else buffer.push(line);
  });
  flush();
  return output.join('\n\n');
}

function frontmatter(fileName, pages) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const convertedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `---\nfonte: ${JSON.stringify(fileName)}\npaginas: ${pages}\nconvertido_em: ${JSON.stringify(convertedAt)}\n---\n\n`;
}

async function uniqueOutputPath(outputDirectory, sourcePath) {
  const parsed = path.parse(sourcePath);
  let candidate = path.join(outputDirectory, `${parsed.name}.md`);
  let counter = 2;
  while (true) {
    try { await fs.access(candidate); candidate = path.join(outputDirectory, `${parsed.name} (${counter}).md`); counter += 1; }
    catch (_error) { return candidate; }
  }
}

async function createOcrWorker(logger) {
  const { createWorker } = require('tesseract.js');
  const language = require('@tesseract.js-data/por');
  return createWorker(language.code, 1, { langPath: language.langPath, gzip: language.gzip, logger });
}

async function loadPdf(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Arquivo não encontrado: ${path.basename(filePath)}`);
  if (stat.size > MAX_PDF_BYTES) throw new Error(`${path.basename(filePath)} excede o limite de 300 MB.`);
  const bytes = await fs.readFile(filePath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`${path.basename(filePath)} não é um PDF válido.`);
  const pdfjsDirectory = path.dirname(require.resolve('pdfjs-dist/package.json'));
  let canvas;
  try { canvas = require(path.join(pdfjsDirectory, 'node_modules', '@napi-rs', 'canvas')); }
  catch (_error) { canvas = require('@napi-rs/canvas'); }
  if (!global.DOMMatrix) global.DOMMatrix = canvas.DOMMatrix;
  if (!global.ImageData) global.ImageData = canvas.ImageData;
  if (!global.Path2D) global.Path2D = canvas.Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  return { document, canvas };
}

async function pdfToMarkdown(filePath, options = {}) {
  const signal = options.signal;
  const onProgress = options.onProgress || (() => {});
  const enableOcr = Boolean(options.enableOcr);
  const { document, canvas } = await loadPdf(filePath);
  const pages = [];
  const warnings = [];
  let worker = null;
  let activeOcrPage = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      assertNotAborted(signal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const lines = extractLines(content);
        pages.push({ lines, characters: lines.reduce((sum, line) => sum + line.text.length, 0) });
      } finally { page.cleanup(); }
      onProgress({ stage: 'text', page: pageNumber, pages: document.numPages, message: `Lendo página ${pageNumber} de ${document.numPages}` });
    }
    const bodySize = bodyFontSize(pages);
    if (enableOcr) {
      const ocrTargets = pages.map((page, index) => page.characters < 60 ? index + 1 : 0).filter(Boolean);
      if (ocrTargets.length) {
        worker = await createOcrWorker((event) => {
          if (event && event.progress) onProgress({ stage: 'ocr', page: activeOcrPage, pages: document.numPages, percent: event.progress, message: `OCR da página ${activeOcrPage}: ${Math.round(event.progress * 100)}%` });
        });
        for (const pageNumber of ocrTargets) {
          assertNotAborted(signal);
          activeOcrPage = pageNumber;
          const page = await document.getPage(pageNumber);
          try {
            const viewport = page.getViewport({ scale: 1.5 });
            const output = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const context = output.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, output.width, output.height);
            await page.render({ canvasContext: context, viewport }).promise;
            const recognized = await worker.recognize(output.toBuffer('image/png'));
            assertNotAborted(signal);
            const text = String(recognized && recognized.data && recognized.data.text || '').trim();
            if (text.length > pages[pageNumber - 1].characters) pages[pageNumber - 1].ocrText = text;
          } catch (error) {
            warnings.push(`OCR não aplicado à página ${pageNumber} de ${path.basename(filePath)}: ${error.message}`);
          } finally { page.cleanup(); }
        }
      }
    }
    const parts = pages.map((page, index) => {
      const content = page.ocrText || mergeLines(page.lines, bodySize);
      return `<!-- p. ${index + 1} - ${path.basename(filePath)} -->\n\n${content}`;
    });
    return { markdown: `${frontmatter(path.basename(filePath), document.numPages)}${parts.join('\n\n').trim()}\n`, warnings, pages: document.numPages };
  } finally {
    if (worker) await worker.terminate();
    await document.destroy();
  }
}

async function convertPdfsToMarkdownFiles(pdfPaths, outputDirectory, options = {}) {
  const paths = Array.isArray(pdfPaths) ? pdfPaths : [];
  if (!paths.length) throw new Error('Selecione ao menos um PDF.');
  if (paths.length > MAX_FILES) throw new Error(`Selecione no máximo ${MAX_FILES} PDFs por vez.`);
  await fs.mkdir(outputDirectory, { recursive: true });
  const written = [];
  const warnings = [];
  for (let index = 0; index < paths.length; index += 1) {
    assertNotAborted(options.signal);
    const filePath = paths[index];
    const result = await pdfToMarkdown(filePath, {
      enableOcr: options.enableOcr,
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.({ ...progress, file: index + 1, files: paths.length, fileName: path.basename(filePath) }),
    });
    const outputPath = await uniqueOutputPath(outputDirectory, filePath);
    await fs.writeFile(outputPath, result.markdown, 'utf8');
    written.push(outputPath);
    warnings.push(...result.warnings);
    options.onProgress?.({ stage: 'file-complete', file: index + 1, files: paths.length, fileName: path.basename(filePath), message: `${path.basename(filePath)} convertido.` });
  }
  return { written, warnings, outputDirectory };
}

module.exports = {
  MAX_FILES,
  convertPdfsToMarkdownFiles,
  pdfToMarkdown,
};
