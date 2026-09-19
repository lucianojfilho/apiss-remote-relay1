'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { pdfToMarkdown } = require('../pdf-markdown');

// Confirma que a conversão de verdade (pdfjs-dist + @napi-rs/canvas, sem tesseract.js) funciona
// neste ambiente — é a mesma checagem real que o endpoint /api/sapiens/convert-md executa,
// só que direto na função, sem precisar subir o servidor HTTP.
test('converte um PDF com texto para Markdown, sem OCR e sem precisar do tesseract.js', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'apiss-relay-mdk-'));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const pdfPath = path.join(temporaryDirectory, 'processo.pdf');

  const document = await PDFDocument.create();
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText('PETICAO INICIAL', { x: 50, y: 780, size: 22, font: bold });
  page.drawText('Texto principal do processo de teste.', { x: 50, y: 735, size: 12, font: regular });
  await fs.writeFile(pdfPath, await document.save());

  const result = await pdfToMarkdown(pdfPath, { enableOcr: false });

  assert.match(result.markdown, /# PETICAO INICIAL/);
  assert.match(result.markdown, /Texto principal do processo de teste\./);
  assert.equal(result.pages, 1);
  assert.deepEqual(result.warnings, []);
});
