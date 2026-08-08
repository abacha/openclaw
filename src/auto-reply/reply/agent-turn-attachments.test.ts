// Tests silent-drop handling for current-turn image attachment resolution.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";

const loggerMocks = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

const { resolveAgentTurnAttachments } = await import("./agent-turn-attachments.js");

describe("resolveAgentTurnAttachments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("warns with the real error when a current-turn image attachment fails to read", async () => {
    const readError = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });

    class FakeMediaAttachmentCache {
      async getBuffer(): Promise<{ buffer: Buffer }> {
        throw readError;
      }
    }

    const result = await resolveAgentTurnAttachments({
      ctx: {
        MediaPath: "/tmp/inbound/photo.jpg",
        MediaType: "image/jpeg",
        media: [{ path: "/tmp/inbound/photo.jpg", contentType: "image/jpeg" }],
      } satisfies MsgContext,
      cfg: {} as OpenClawConfig,
      runtime: {
        MediaAttachmentCache: FakeMediaAttachmentCache as never,
        isImageAttachment: (attachment) => Boolean(attachment.mime?.startsWith("image/")),
        isMediaUnderstandingSkipError: () => false,
        normalizeAttachments: (ctx) => [
          { path: ctx.MediaPath as string, mime: ctx.MediaType as string, index: 0 },
        ],
        resolveMediaAttachmentLocalRoots: () => [],
      },
    });

    expect(result.attachments).toEqual([]);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = loggerMocks.warn.mock.calls[0];
    expect(message).toContain("failed to read attachment #1");
    expect(meta).toMatchObject({ error: readError.message });
  });
});
