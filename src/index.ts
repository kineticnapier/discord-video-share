export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_PASSWORD: string;
}

const EXPIRE_MS = 3 * 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 40 * 1024 * 1024;
const CONCURRENCY = 4;

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

function getUploadPage(): Response {
  return html(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Video Upload</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 720px;
      margin: 40px auto;
      padding: 0 16px;
    }
    input, button {
      font-size: 16px;
      padding: 8px;
      margin: 8px 0;
      width: 100%;
      box-sizing: border-box;
    }
    progress {
      width: 100%;
      height: 24px;
    }
    pre {
      background: #f3f3f3;
      padding: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <h1>Video Upload</h1>

  <form id="form">
    <label>
      Upload password
      <input id="password" type="password" required>
    </label>

    <label>
      Video file
      <input id="file" type="file" accept="video/mp4,video/webm,video/quicktime" required>
    </label>

    <button type="submit">Upload</button>
  </form>

  <p id="status"></p>
  <progress id="progress" value="0" max="100"></progress>

  <div id="result" class="hidden">
    <h2>Discordに貼るURL</h2>
    <input id="viewUrl" readonly>
    <button id="copy" type="button">Copy</button>
    <pre id="json"></pre>
  </div>

  <script>
  const CHUNK_SIZE = 40 * 1024 * 1024;
  const CONCURRENCY = 4;

  const form = document.getElementById("form");
  const statusEl = document.getElementById("status");
  const progressEl = document.getElementById("progress");
  const resultEl = document.getElementById("result");
  const viewUrlEl = document.getElementById("viewUrl");
  const jsonEl = document.getElementById("json");
  const copyBtn = document.getElementById("copy");

  async function requestJson(url, options) {
    const res = await fetch(url, options);
    const bodyText = await res.text();

    if (!res.ok) {
      throw new Error(bodyText || "Request failed");
    }

    return JSON.parse(bodyText);
  }

  async function uploadPart({ created, password, file, partNumber, totalParts }) {
    const start = (partNumber - 1) * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    return await requestJson(
      "/multipart/part?id=" + encodeURIComponent(created.id) +
      "&uploadId=" + encodeURIComponent(created.uploadId) +
      "&partNumber=" + encodeURIComponent(String(partNumber)),
      {
        method: "PUT",
        headers: {
          "X-Upload-Password": password,
          "Content-Type": "application/octet-stream",
        },
        body: chunk,
      }
    );
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    resultEl.classList.add("hidden");
    progressEl.value = 0;

    const password = document.getElementById("password").value;
    const file = document.getElementById("file").files[0];

    if (!file) {
      statusEl.textContent = "ファイルを選択してください。";
      return;
    }

    try {
      statusEl.textContent = "Creating multipart upload...";

      const created = await requestJson("/multipart/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          password,
          contentType: file.type || "video/mp4",
          size: file.size,
        }),
      });

      const totalParts = Math.ceil(file.size / CHUNK_SIZE);
      const parts = new Array(totalParts);

      let nextPartNumber = 1;
      let completedParts = 0;

      async function worker() {
        while (true) {
          const partNumber = nextPartNumber;
          nextPartNumber++;

          if (partNumber > totalParts) {
            return;
          }

          statusEl.textContent =
            "Uploading part " + partNumber + " / " + totalParts + "...";

          const uploaded = await uploadPart({
            created,
            password,
            file,
            partNumber,
            totalParts,
          });

          parts[partNumber - 1] = {
            partNumber: uploaded.partNumber,
            etag: uploaded.etag,
          };

          completedParts++;
          progressEl.value = Math.round((completedParts / totalParts) * 100);
        }
      }

      const workers = [];
      const workerCount = Math.min(CONCURRENCY, totalParts);

      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);

      statusEl.textContent = "Finishing upload...";

      const finished = await requestJson("/multipart/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          password,
          id: created.id,
          uploadId: created.uploadId,
          parts,
        }),
      });

      statusEl.textContent = "Upload complete.";
      viewUrlEl.value = finished.viewUrl;
      jsonEl.textContent = JSON.stringify(finished, null, 2);
      resultEl.classList.remove("hidden");
    } catch (err) {
      statusEl.textContent = "Upload failed: " + err.message;
    }
  });

  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(viewUrlEl.value);
    statusEl.textContent = "Copied.";
  });
</script>
</body>
</html>`);
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
  const key = `videos/${id}`;

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

  const key = `videos/${id}`;
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

  const key = `videos/${body.id}`;
  const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);

  await upload.complete(parts);

  const origin = getOrigin(request);

  return json({
    ok: true,
    id: body.id,
    viewUrl: `${origin}/v/${encodeURIComponent(body.id)}`,
    fileUrl: `${origin}/file/${encodeURIComponent(body.id)}`,
  });
}

async function handleView(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidId(id)) {
    return text("Invalid id", 400);
  }

  const key = `videos/${id}`;
  const obj = await env.BUCKET.head(key);

  if (!obj) {
    return text("Not found", 404);
  }

  const origin = getOrigin(request);
  const fileUrl = `${origin}/file/${encodeURIComponent(id)}`;
  const contentType = obj.httpMetadata?.contentType ?? getContentTypeFromId(id);

  return html(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Uploaded video</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <meta property="og:title" content="Uploaded video">
  <meta property="og:description" content="Temporary uploaded video">
  <meta property="og:type" content="video.other">
  <meta property="og:video" content="${fileUrl}">
  <meta property="og:video:secure_url" content="${fileUrl}">
  <meta property="og:video:type" content="${contentType}">

  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="Uploaded video">
  <meta name="twitter:player" content="${fileUrl}">
</head>
<body>
  <video src="${fileUrl}" controls style="max-width:100%;height:auto;"></video>
</body>
</html>`);
}

async function handleFile(env: Env, id: string): Promise<Response> {
  if (!isValidId(id)) {
    return text("Invalid id", 400);
  }

  const key = `videos/${id}`;
  const obj = await env.BUCKET.get(key);

  if (!obj) {
    return text("Not found", 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", obj.httpMetadata?.contentType ?? getContentTypeFromId(id));
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(obj.body, { headers });
}

async function cleanupExpired(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined = undefined;

  do {
    const listed = await env.BUCKET.list({
      prefix: "videos/",
      cursor,
      limit: 1000,
    });

    for (const obj of listed.objects) {
      const filename = obj.key.slice("videos/".length);
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
      const id = decodeURIComponent(url.pathname.slice("/v/".length));
      return handleView(request, env, id);
    }

    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      const id = decodeURIComponent(url.pathname.slice("/file/".length));
      return handleFile(env, id);
    }

    return text("Not found", 404);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupExpired(env);
  },
} satisfies ExportedHandler<Env>;