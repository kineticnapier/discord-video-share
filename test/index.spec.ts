import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Video upload worker", () => {
	it("serves upload page from fetch handler (unit style)", async () => {
		const request = new IncomingRequest("https://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("<h1>Video Upload</h1>");
	});

	it("serves upload page (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("<form id=\"form\">");
	});

	it("returns 404 for unknown route", async () => {
		const response = await SELF.fetch("https://example.com/not-found");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
	});
});
