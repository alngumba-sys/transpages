// pp4-figure-extractor.js
// Renders PDF pages and crops figure regions to PNG using Puppeteer.
// Runs in same environment as pp4-render-pdf-background.js (full puppeteer locally,
// puppeteer-core + @sparticuz/chromium in Lambda).

const IS_LAMBDA = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

let puppeteer, chromium;
async function initPuppeteer() {
  if (puppeteer) return;
  if (IS_LAMBDA) {
    puppeteer = (await import('puppeteer-core')).default;
    chromium = (await import('@sparticuz/chromium')).default;
  } else {
    puppeteer = (await import('puppeteer')).default;
    chromium = null;
  }
}

/**
 * Extract figure images from a source PDF.
 * @param {Uint8Array} pdfBytes - The source PDF
 * @param {Array} figures - Azure figures[] (each with boundingRegions[0].polygon and .pageNumber)
 * @param {Object} pages - Azure pages[] (for page width/height in inches)
 * @returns {Array} - [{ index, pngBytes, pageNumber, polygon }]
 */
export async function extractFigureImages(pdfBytes, figures, pages) {
  if (!figures || figures.length === 0) return [];
  await initPuppeteer();

  const launchOpts = chromium
    ? {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: true,
      }
    : {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };

  const browser = await puppeteer.launch(launchOpts);
  const results = [];

  try {
    // Group figures by page so we render each page at most once
    const figuresByPage = {};
    figures.forEach((fig, i) => {
      const pageNum = fig.boundingRegions?.[0]?.pageNumber || 1;
      if (!figuresByPage[pageNum]) figuresByPage[pageNum] = [];
      figuresByPage[pageNum].push({ figure: fig, index: i });
    });

    // Convert PDF to a data URL for Chromium's PDF viewer
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
    const dataUrl = `data:application/pdf;base64,${pdfBase64}`;

    for (const [pageNumStr, pageFigs] of Object.entries(figuresByPage)) {
      const pageNum = parseInt(pageNumStr, 10);
      const pageInfo = pages.find((p) => p.pageNumber === pageNum);
      if (!pageInfo) {
        console.warn(`No page info for page ${pageNum}, skipping figures`);
        continue;
      }
      const pageWidthIn  = pageInfo.width;
      const pageHeightIn = pageInfo.height;

      // Render the page using PDF.js in a Chromium tab. We use a small inline HTML
      // that loads PDF.js and renders the requested page to a canvas at high DPI.
      const RENDER_DPI = 150;
      const pxWidth  = Math.round(pageWidthIn  * RENDER_DPI);
      const pxHeight = Math.round(pageHeightIn * RENDER_DPI);

      const pageRendererHtml = `<!DOCTYPE html><html><head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs" type="module"></script>
</head><body><canvas id="c" width="${pxWidth}" height="${pxHeight}"></canvas>
<script type="module">
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
const pdfData = atob('${pdfBase64}');
const pdfArr = Uint8Array.from(pdfData, c => c.charCodeAt(0));
const doc = await pdfjsLib.getDocument({ data: pdfArr }).promise;
const page = await doc.getPage(${pageNum});
const viewport = page.getViewport({ scale: ${RENDER_DPI} / 72 });
const canvas = document.getElementById('c');
canvas.width = viewport.width; canvas.height = viewport.height;
const ctx = canvas.getContext('2d');
await page.render({ canvasContext: ctx, viewport }).promise;
window.__rendered = true;
</script></body></html>`;

      const tab = await browser.newPage();
      try {
        await tab.setContent(pageRendererHtml, { waitUntil: 'networkidle0' });
        await tab.waitForFunction('window.__rendered === true', { timeout: 30000 });

        // For each figure on this page, screenshot the cropped region from the canvas
        for (const { figure, index } of pageFigs) {
          const polygon = figure.boundingRegions[0].polygon; // 8 numbers, in inches
          // Bounding box in inches
          const xs = [polygon[0], polygon[2], polygon[4], polygon[6]];
          const ys = [polygon[1], polygon[3], polygon[5], polygon[7]];
          const xMin = Math.min(...xs);
          const xMax = Math.max(...xs);
          const yMin = Math.min(...ys);
          const yMax = Math.max(...ys);

          // Convert to pixels
          const px = Math.round(xMin * RENDER_DPI);
          const py = Math.round(yMin * RENDER_DPI);
          const pw = Math.round((xMax - xMin) * RENDER_DPI);
          const ph = Math.round((yMax - yMin) * RENDER_DPI);

          // Use canvas.getImageData via JS to extract the cropped region as PNG dataURL
          const dataUrl = await tab.evaluate(({ x, y, w, h }) => {
            const c = document.getElementById('c');
            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = w; cropCanvas.height = h;
            const cctx = cropCanvas.getContext('2d');
            cctx.drawImage(c, x, y, w, h, 0, 0, w, h);
            return cropCanvas.toDataURL('image/png');
          }, { x: px, y: py, w: pw, h: ph });

          const pngBytes = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');

          results.push({
            index,
            pngBytes,
            pageNumber: pageNum,
            polygon,
          });
        }
      } finally {
        await tab.close();
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
