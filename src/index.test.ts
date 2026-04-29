import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./index";

describe("worker fetch", () => {
  it("returns upload page html on GET /", async () => {
    const request = new Request("https://example.com/");

    const response = await worker.fetch(request, {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("<title>Video Upload</title>");
  });
});
