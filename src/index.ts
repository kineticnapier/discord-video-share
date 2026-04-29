import { getViewPageHtml, uploadPageHtml } from "./html";

export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_PASSWORD: string;
}

const EXPIRE_MS = 3 * 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 16 * 1024 * 1024;
const CONCURRENCY = 6;
const VIDEO_PREFIX = "videos/";

type UploadedPartJson = {
  partNumber: number;
  etag: string;
};

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function getOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function getExtFromType(type: string): string {
  if (type === "video/webm") return "webm";
  if (type === "video/quicktime") return "mov";
  return "mp4";
}

function getContentTypeFromId(id: string): string {
  if (id.endsWith(".webm")) return "video/webm";
  if (id.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function isValidId(id: string): boolean {
  return /^[0-9]+-[0-9a-fA-F-]+\.(mp4|webm|mov)$/.test(id);
}

function isAuthedPassword(password: unknown, env: Env): boolean {
  return typeof password === "string" && password === env.UPLOAD_PASSWORD;
}

function getVideoKey(id: string): string {
  return `${VIDEO_PREFIX}${id}`;
}

function getPublicVideoUrls(request: Request, id: string): { viewUrl: string; fileUrl: string } {
  const origin = getOrigin(request);
  const encodedId = encodeURIComponent(id);

  return {
    viewUrl: `${origin}/v/${encodedId}`,
    fileUrl: `${origin}/file/${encodedId}`,
  };
}

function getPathId(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length));
}

function getUploadPage(): Response {
  return html(uploadPageHtml);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    password?: string;
    contentType?: string;
    size?: number;
  }>();

  if (!isAuthedPassword(body.password, env)) {
    return text("Unauthorized", 401);
  }

  const contentType = body.contentType || "video/mp4";

  if (!contentType.startsWith("video/")) {
    return text("File must be video", 400);
  }

  const expiresAt = Date.now() + EXPIRE_MS;
  const ext = getExtFromType(contentType);
  const id = `${expiresAt}-${crypto.randomUUID()}.${ext}`;
  const key = getVideoKey(id);

  const upload = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
    },
  });

  return json({
    ok: true,
    id,
    key,
    uploadId: upload.uploadId,
    chunkSize: CHUNK_SIZE,
  });
}

async function handleMultipartPart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const password = request.headers.get("X-Upload-Password");
  if (!isAuthedPassword(password, env)) {
    return text("Unauthorized", 401);
  }

  const id = url.searchParams.get("id");
  const uploadId = url.searchParams.get("uploadId");
  const partNumberText = url.searchParams.get("partNumber");

  if (!id || !uploadId || !partNumberText) {
    return text("Missing id, uploadId, or partNumber", 400);
  }

  if (!isValidId(id)) {
    return text("Invalid id", 400);
  }

  const partNumber = Number(partNumberText);

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return text("Invalid partNumber", 400);
  }

  if (!request.body) {
    return text("No body", 400);
  }

  const key = getVideoKey(id);
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);

  const uploadedPart = await upload.uploadPart(partNumber, request.body);

  return json({
    ok: true,
    partNumber: uploadedPart.partNumber,
    etag: uploadedPart.etag,
  });
}

async function handleMultipartFinish(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    password?: string;
    id?: string;
    uploadId?: string;
    parts?: UploadedPartJson[];
  }>();

  if (!isAuthedPassword(body.password, env)) {
    return text("Unauthorized", 401);
  }

  if (!body.id || !body.uploadId || !Array.isArray(body.parts)) {
    return text("Missing id, uploadId, or parts", 400);
  }

  if (!isValidId(body.id)) {
    return text("Invalid id", 400);
  }

  const parts = body.parts
    .map(p => ({
      partNumber: Number(p.partNumber),
      etag: String(p.etag),
    }))
    .sort((a, b) => a.partNumber - b.partNumber);

  const key = getVideoKey(body.id);
  const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);

  await upload.complete(parts);

  const { viewUrl, fileUrl } = getPublicVideoUrls(request, body.id);

  return json({
    ok: true,
    id: body.id,
    viewUrl,
    fileUrl,
  });
}

async function handleView(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidId(id)) {
    return text("Invalid id", 400);
  }

  const key = getVideoKey(id);
  const obj = await env.BUCKET.head(key);

  if (!obj) {
    return text("Not found", 404);
  }

  const { fileUrl } = getPublicVideoUrls(request, id);
  const contentType = obj.httpMetadata?.contentType ?? getContentTypeFromId(id);

  return html(getViewPageHtml(fileUrl, contentType));
}

async function handleFile(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidId(id)) {
    return text("Invalid id", 400);
  }

  const key = getVideoKey(id);
  const rangeHeader = request.headers.get("range");
  const getOptions = rangeHeader ? { range: request.headers } : undefined;
  const obj = await env.BUCKET.get(key, getOptions);

  if (!obj) {
    return text("Not found", 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", obj.httpMetadata?.contentType ?? getContentTypeFromId(id));
  headers.set("Cache-Control", "public, max-age=3600");

  if (
    rangeHeader &&
    obj.range &&
    obj.size != null &&
    "offset" in obj.range &&
    "length" in obj.range
  ) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? 0;
    const end = start + length - 1;
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
    return new Response(obj.body, { headers, status: 206 });
  }

  headers.set("Accept-Ranges", "bytes");
  return new Response(obj.body, { headers });
}

async function cleanupExpired(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined = undefined;

  do {
    const listed = await env.BUCKET.list({
      prefix: VIDEO_PREFIX,
      cursor,
      limit: 1000,
    });

    for (const obj of listed.objects) {
      const filename = obj.key.slice(VIDEO_PREFIX.length);
      const expiresAtText = filename.split("-")[0];
      const expiresAt = Number(expiresAtText);

      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        await env.BUCKET.delete(obj.key);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return getUploadPage();
    }

    if (request.method === "POST" && url.pathname === "/multipart/create") {
      return handleMultipartCreate(request, env);
    }

    if (request.method === "PUT" && url.pathname === "/multipart/part") {
      return handleMultipartPart(request, env);
    }

    if (request.method === "POST" && url.pathname === "/multipart/finish") {
      return handleMultipartFinish(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/v/")) {
      const id = getPathId(url.pathname, "/v/");
      return handleView(request, env, id);
    }

    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      const id = getPathId(url.pathname, "/file/");
      return handleFile(request, env, id);
    }

    return text("Not found", 404);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupExpired(env);
  },
} satisfies ExportedHandler<Env>;
