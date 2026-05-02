import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./index";

describe("worker fetch", () => {
  it("returns upload page html on GET /", async () => {
    const request = new Request("https://example.com/");

    const response = await worker.fetch(request, {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("<title>Video Upload Studio</title>");
  });

  it("returns 206 with content-range when range header is provided", async () => {
    const id = "9999999999999-123e4567-e89b-12d3-a456-426614174000.mp4";
    const request = new Request(`https://example.com/file/${id}`, {
      headers: { range: "bytes=0-99" },
    });

    const env = {
      BUCKET: {
        get: async () => ({
          body: new ReadableStream(),
          size: 500,
          range: { offset: 0, length: 100 },
          httpMetadata: { contentType: "video/mp4" },
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", "video/mp4");
          },
        }),
      },
    } as unknown as Env;

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(206);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/500");
  });
});
