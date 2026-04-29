export const uploadPageHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Video Upload Studio</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      color-scheme: dark;
    }
    body {
      font-family: Inter, system-ui, sans-serif;
      max-width: 840px;
      margin: 32px auto;
      padding: 0 16px 48px;
      background: radial-gradient(circle at top, #1f2a44 0%, #0b1020 52%, #060912 100%);
      color: #e8ebf8;
    }
    input, button {
      font-size: 16px;
      padding: 12px;
      margin: 10px 0;
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid #3a4464;
    }
    input { background: #0f1730; color: #eff3ff; }
    button { background: linear-gradient(135deg, #6e8bff, #8a5dff); color: white; border: none; font-weight: 700; cursor: pointer; }
    progress {
      width: 100%;
      height: 24px;
      accent-color: #7d8fff;
    }
    pre {
      background: #101a35;
      padding: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 12px;
    }
    .hidden {
      display: none;
    }
    .panel {
      background: rgba(10, 15, 30, 0.82);
      border: 1px solid #2f3d66;
      border-radius: 18px;
      padding: 20px;
      backdrop-filter: blur(8px);
      box-shadow: 0 18px 46px rgba(0,0,0,0.35);
    }
    .muted { color: #b2bddf; }
  </style>
</head>
<body>
  <h1>Video Upload Studio</h1>
  <p class="muted">高速な分割アップロードでDiscord共有を快適に。</p>

  <form id="form" class="panel">
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
  const CHUNK_SIZE = 16 * 1024 * 1024;
  const CONCURRENCY = 6;

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
</html>`;

export function getViewPageHtml(fileUrl: string, contentType: string): string {
  return `<!doctype html>
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
</html>`;
}
