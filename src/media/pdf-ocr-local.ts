/**
 * Local OCR fallback for scanned PDFs.
 *
 * No network, no credentials: rasterizes pages with poppler's `pdftoppm` and reads them
 * with the local `tesseract` binary. Used only when local text extraction comes back
 * empty/near-empty (a scan with no text layer) and every configured vision model has
 * failed or none is configured. This is text EXTRACTION, not comprehension — charts,
 * skewed tables, and handwriting still need a vision model and should keep failing
 * explicitly rather than silently returning garbage.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_RASTER_DPI = 200;
const DEFAULT_OCR_LANG = "por";
const OCR_TIMEOUT_MS = 120_000;

/** Thrown when the local OCR toolchain (pdftoppm/tesseract) is not installed. */
export class PdfOcrUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "Local OCR fallback unavailable: pdftoppm/tesseract not found on this host " +
        "(expects poppler-utils + tesseract-ocr installed by the fleet's 'ocr' ansible role).",
    );
    this.name = "PdfOcrUnavailableError";
    this.cause = cause;
  }
}

async function toolExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["-v"], { timeout: 5_000 });
    return true;
  } catch (error) {
    // Both binaries print version/usage to stderr and exit non-zero on `-v`;
    // any execution error other than "binary not found" still proves it exists.
    const code = (error as NodeJS.ErrnoException)?.code;
    return code !== "ENOENT";
  }
}

async function rasterizePdfPages(params: {
  pdfPath: string;
  outDir: string;
  password?: string;
  pageNumbers: number[];
  dpi?: number;
}): Promise<string[]> {
  const prefix = path.join(params.outDir, "page");
  const files: string[] = [];
  let lastError: unknown;
  for (const page of params.pageNumbers) {
    const args = [
      "-r",
      String(params.dpi ?? DEFAULT_RASTER_DPI),
      "-png",
      "-f",
      String(page),
      "-l",
      String(page),
      ...(params.password ? ["-upw", params.password] : []),
      params.pdfPath,
      `${prefix}-${String(page).padStart(6, "0")}`,
    ];
    try {
      await execFileAsync("pdftoppm", args, { timeout: OCR_TIMEOUT_MS });
    } catch (error) {
      // A requested page past the document's real length (the default range is
      // capped by the tool's maxPages, not the PDF's actual page count) is not
      // a hard failure as long as at least one earlier page rasterized.
      lastError = error;
    }
  }
  const entries = await fs.readdir(params.outDir);
  if (entries.length === 0 && lastError) {
    throw lastError instanceof Error
      ? lastError
      : new Error("pdftoppm failed to rasterize any page", { cause: lastError });
  }
  for (const entry of entries.toSorted()) {
    if (entry.endsWith(".png")) {
      files.push(path.join(params.outDir, entry));
    }
  }
  return files;
}

async function ocrImage(imagePath: string, lang: string): Promise<string> {
  const { stdout } = await execFileAsync("tesseract", [imagePath, "-", "-l", lang], {
    timeout: OCR_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Rasterizes the given PDF pages and OCRs each one locally, returning the concatenated
 * page text. Throws `PdfOcrUnavailableError` when the toolchain is missing; throws a plain
 * `Error` for any other OCR failure (corrupt PDF, wrong password, etc).
 */
export async function runLocalPdfOcr(params: {
  buffer: Buffer;
  pageNumbers: number[];
  password?: string;
  lang?: string;
}): Promise<{ text: string; pagesProcessed: number }> {
  if (params.pageNumbers.length === 0) {
    return { text: "", pagesProcessed: 0 };
  }
  if (!(await toolExists("pdftoppm")) || !(await toolExists("tesseract"))) {
    throw new PdfOcrUnavailableError(new Error("pdftoppm or tesseract binary not found"));
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ocr-"));
  try {
    const pdfPath = path.join(tmpDir, "input.pdf");
    await fs.writeFile(pdfPath, params.buffer);

    const pages = await rasterizePdfPages({
      pdfPath,
      outDir: tmpDir,
      pageNumbers: params.pageNumbers,
      ...(params.password ? { password: params.password } : {}),
    });

    const lang = params.lang?.trim() || DEFAULT_OCR_LANG;
    const pageTexts: string[] = [];
    for (const [i, imagePath] of pages.entries()) {
      const text = await ocrImage(imagePath, lang);
      if (text) {
        pageTexts.push(pages.length > 1 ? `[page ${i + 1}]\n${text}` : text);
      }
    }
    return { text: pageTexts.join("\n\n").trim(), pagesProcessed: pages.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
