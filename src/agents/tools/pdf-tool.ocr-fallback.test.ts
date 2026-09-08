// Local OCR fallback: scanned PDF (near-empty text layer) + every vision model failing
// or unconfigured should still return text, via local pdftoppm/tesseract rather than a
// model call. A normal textual PDF must be unaffected by this path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as pdfOcrLocalModule from "../../media/pdf-ocr-local.js";
import { PdfOcrUnavailableError } from "../../media/pdf-ocr-local.js";
import { createPdfToolInfraStub, withTempPdfAgentDir } from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());
useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

type PdfToolModule = typeof import("./pdf-tool.js");
let createPdfTool: PdfToolModule["createPdfTool"];
async function loadCreatePdfTool() {
  if (!createPdfTool) {
    ({ createPdfTool } = await import("./pdf-tool.js"));
  }
  return createPdfTool;
}

const OPENAI_PDF_MODEL = "openai/gpt-5.4-mini";

function withPdfModel(primary: string): OpenClawConfig {
  return { agents: { defaults: { pdfModel: { primary } } } } as OpenClawConfig;
}

function requirePdfTool(tool: unknown) {
  if (!tool || typeof (tool as { execute?: unknown }).execute !== "function") {
    throw new Error("expected pdf tool");
  }
  return tool as {
    execute: (
      id: string,
      args: unknown,
    ) => Promise<{ content: unknown; details: Record<string, unknown> }>;
  };
}

const SCAN_EXTRACTION = {
  text: "  ",
  images: [{ type: "image" as const, data: "base64img", mimeType: "image/png" }],
};

describe("pdf tool local OCR fallback", () => {
  it("falls back to local OCR when a scanned PDF has no text and every vision model fails", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue(SCAN_EXTRACTION);
      completeMock.mockRejectedValue(new Error("401 Incorrect API key"));
      const ocrSpy = vi
        .spyOn(pdfOcrLocalModule, "runLocalPdfOcr")
        .mockResolvedValue({
          text: "Prestação de serviço — Soluções Agrícolas Ltda.",
          pagesProcessed: 1,
        });

      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );
      const result = await tool.execute("t1", { prompt: "summarize", pdf: "/tmp/scan.pdf" });

      expect(ocrSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual([
        { type: "text", text: "Prestação de serviço — Soluções Agrícolas Ltda." },
      ]);
      expect(result.details).toMatchObject({
        model: "local/tesseract-ocr",
        ocrFallback: true,
        native: false,
      });
    });
  });

  it("does not use OCR fallback for a normal textual PDF when the model fails", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "This PDF has a perfectly normal text layer with plenty of characters in it.".repeat(
          4,
        ),
        images: [],
      });
      completeMock.mockRejectedValue(new Error("401 Incorrect API key"));
      const ocrSpy = vi.spyOn(pdfOcrLocalModule, "runLocalPdfOcr");

      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("t1", { prompt: "summarize", pdf: "/tmp/text.pdf" }),
      ).rejects.toThrow(/401 Incorrect API key/);
      expect(ocrSpy).not.toHaveBeenCalled();
    });
  });

  it("surfaces a clear error when local OCR binaries are unavailable", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue(SCAN_EXTRACTION);
      completeMock.mockRejectedValue(new Error("401 Incorrect API key"));
      vi.spyOn(pdfOcrLocalModule, "runLocalPdfOcr").mockRejectedValue(
        new PdfOcrUnavailableError(new Error("ENOENT")),
      );

      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("t1", { prompt: "summarize", pdf: "/tmp/scan.pdf" }),
      ).rejects.toThrow(/Local OCR fallback unavailable/);
    });
  });

  it("surfaces a distinct error when OCR runs but finds no text (chart/handwriting territory)", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue(SCAN_EXTRACTION);
      completeMock.mockRejectedValue(new Error("401 Incorrect API key"));
      vi.spyOn(pdfOcrLocalModule, "runLocalPdfOcr").mockResolvedValue({
        text: "",
        pagesProcessed: 1,
      });

      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("t1", { prompt: "summarize", pdf: "/tmp/scan.pdf" }),
      ).rejects.toThrow(/found no readable text either/);
    });
  });
});
