const LINE_BREAK_THRESHOLD = 4;
const PARAGRAPH_BREAK_THRESHOLD = 14;
const MIN_TEXT_CHARACTERS = 80;
const MIN_TEXT_PER_PAGE = 20;
const LEADING_PUNCTUATION_PATTERN = /^[,.;:!?%)\]}'"”]/;
const TRAILING_NO_SPACE_PATTERN = /[\s([{-]$/;
const PAGE_MARKER_PATTERN = /\[Page \d+\]\s*/g;
let pdfjsPromise = null;

function installParserShims() {
  if (!globalThis.DOMMatrix) {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(values = [1, 0, 0, 1, 0, 0]) {
        const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = Array.isArray(values)
          ? values
          : [1, 0, 0, 1, 0, 0];
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.e = e;
        this.f = f;
      }

      multiplySelf() {
        return this;
      }

      preMultiplySelf() {
        return this;
      }

      translate() {
        return this;
      }

      scale() {
        return this;
      }

      invertSelf() {
        return this;
      }
    };
  }

  if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {};
  }

  if (!globalThis.Path2D) {
    globalThis.Path2D = class Path2D {
      addPath() {}
    };
  }
}

async function loadPdfJs() {
  if (!pdfjsPromise) {
    installParserShims();
    pdfjsPromise = import('../vendor/pdfjs/pdf.mjs');
  }

  return pdfjsPromise;
}

function normalizeToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldInsertSpace(buffer, nextToken) {
  if (!buffer || !nextToken) {
    return false;
  }

  const previousChar = buffer[buffer.length - 1];
  if (TRAILING_NO_SPACE_PATTERN.test(previousChar)) {
    return false;
  }

  return !LEADING_PUNCTUATION_PATTERN.test(nextToken);
}

function normalizePageText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ ([,.;:!?%])/g, '$1')
    .trim();
}

function isLikelyScannedPdf(content, pageCount) {
  const visibleCharacters = String(content || '')
    .replace(PAGE_MARKER_PATTERN, '')
    .replace(/\s+/g, '')
    .length;

  return visibleCharacters < Math.max(MIN_TEXT_CHARACTERS, pageCount * MIN_TEXT_PER_PAGE);
}

async function extractPageText(page) {
  const textContent = await page.getTextContent();
  let buffer = '';
  let lastY = null;

  for (const item of textContent.items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const token = normalizeToken(item.str);
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : null;
    const deltaY = lastY == null || y == null ? 0 : Math.abs(y - lastY);

    if (buffer && deltaY > PARAGRAPH_BREAK_THRESHOLD && !buffer.endsWith('\n\n')) {
      buffer += '\n\n';
    } else if (buffer && (item.hasEOL || deltaY > LINE_BREAK_THRESHOLD) && !buffer.endsWith('\n')) {
      buffer += '\n';
    }

    if (token) {
      if (shouldInsertSpace(buffer, token)) {
        buffer += ' ';
      }
      buffer += token;
    }

    if (item.hasEOL && buffer && !buffer.endsWith('\n')) {
      buffer += '\n';
    }

    if (y != null) {
      lastY = y;
    }
  }

  return normalizePageText(buffer);
}

function mapPdfError(error) {
  const name = String(error?.name || '');

  if (name === 'PasswordException') {
    return {
      code: 'PDF_PASSWORD_PROTECTED',
      message: 'Could not read this PDF.',
    };
  }

  return {
    code: 'PDF_PARSE_FAILED',
    message: 'Could not read this PDF.',
  };
}

export async function extractPdfText(pdfBytes) {
  let loadingTask = null;
  let pdfDocument = null;

  try {
    const pdfjsLib = await loadPdfJs();
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
    const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    loadingTask = pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0,
    });
    pdfDocument = await loadingTask.promise;

    const sections = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const pageText = await extractPageText(page);
      page.cleanup();

      sections.push(pageText ? `[Page ${pageNumber}]\n${pageText}` : `[Page ${pageNumber}]`);
    }

    const content = sections.join('\n\n').trim();
    if (isLikelyScannedPdf(content, pdfDocument.numPages)) {
      return {
        ok: false,
        error: {
          code: 'PDF_TEXT_UNAVAILABLE',
          message: 'This PDF appears to be scanned/image-only, so text extraction is limited.',
        },
        metadata: {
          pageCount: pdfDocument.numPages,
        },
      };
    }

    return {
      ok: true,
      content,
      metadata: {
        pageCount: pdfDocument.numPages,
      },
    };
  } catch (error) {
    const mapped = mapPdfError(error);
    return {
      ok: false,
      error: {
        ...mapped,
        details: error?.message || '',
      },
      metadata: {
        pageCount: pdfDocument?.numPages,
      },
    };
  } finally {
    try {
      await pdfDocument?.destroy();
    } catch {
      // Ignore cleanup failures.
    }

    try {
      await loadingTask?.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  }
}
