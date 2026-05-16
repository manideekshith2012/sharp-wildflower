const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const WORK_DIR = path.join(os.tmpdir(), "mov-to-mp4-converter");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);

const jobs = new Map();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function getFilePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const requestedPath = cleanPath === "/" ? "/index.html" : cleanPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  return filePath.startsWith(PUBLIC_DIR) ? filePath : null;
}

function safeOutputName(name) {
  const base = path.basename(name || "converted.mov").replace(/\.[^.]+$/, "");
  return `${base.replace(/[^a-z0-9._-]+/gi, "_") || "converted"}.mp4`;
}

function parseTimeToSeconds(value) {
  const match = value.match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function removeFile(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // Temporary files may already be gone.
  }
}

function startConversion(job) {
  job.status = "converting";
  job.progress = 0;
  job.message = "Converting with FFmpeg...";

  const child = spawn(ffmpegPath, [
    "-y",
    "-i",
    job.inputPath,
    "-map",
    "0:v:0?",
    "-map",
    "0:a?",
    "-dn",
    "-sn",
    "-ignore_unknown",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    job.outputPath,
  ]);

  job.process = child;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    job.lastLog = chunk.trim().split("\n").at(-1) || job.lastLog;

    const durationMatch = chunk.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (durationMatch) {
      job.duration = parseTimeToSeconds(durationMatch[1]);
    }

    const timeMatches = [...chunk.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
    const latestTime = timeMatches.at(-1);
    if (latestTime && job.duration) {
      const seconds = parseTimeToSeconds(latestTime[1]);
      if (seconds !== null) {
        job.progress = Math.min(99, Math.round((seconds / job.duration) * 100));
      }
    }
  });

  child.on("error", async (error) => {
    job.status = "failed";
    job.message = error.message;
    await removeFile(job.inputPath);
  });

  child.on("close", async (code) => {
    job.process = null;
    await removeFile(job.inputPath);

    if (code === 0) {
      job.status = "ready";
      job.progress = 100;
      job.message = "Conversion complete.";
      return;
    }

    job.status = "failed";
    job.message = job.lastLog || `FFmpeg failed with exit code ${code}.`;
    await removeFile(job.outputPath);
  });
}

async function handleUpload(req, res) {
  await fsp.mkdir(WORK_DIR, { recursive: true });

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: "File is larger than the configured upload limit." });
    return;
  }

  const originalName = decodeURIComponent(String(req.headers["x-file-name"] || "input.mov"));
  if (!originalName.toLowerCase().endsWith(".mov")) {
    sendJson(res, 400, { error: "Please upload a .mov file." });
    return;
  }

  const id = randomUUID();
  const inputPath = path.join(WORK_DIR, `${id}.mov`);
  const outputPath = path.join(WORK_DIR, `${id}.mp4`);
  const job = {
    id,
    status: "uploading",
    progress: 0,
    message: "Uploading...",
    inputPath,
    outputPath,
    outputName: safeOutputName(originalName),
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  let received = 0;
  const writeStream = fs.createWriteStream(inputPath);

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      job.status = "failed";
      job.message = "File is larger than the configured upload limit.";
      req.destroy();
      writeStream.destroy();
    }
  });

  writeStream.on("error", async (error) => {
    job.status = "failed";
    job.message = error.message;
    await removeFile(inputPath);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Upload failed." });
    }
  });

  writeStream.on("finish", () => {
    job.status = "queued";
    job.message = "Upload complete. Conversion is starting...";
    sendJson(res, 202, { id });
    startConversion(job);
  });

  req.pipe(writeStream);
}

function handleStatus(res, id) {
  const job = jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found." });
    return;
  }

  sendJson(res, 200, {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    downloadUrl: job.status === "ready" ? `/download/${job.id}` : null,
  });
}

function handleDownload(res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== "ready") {
    send(res, 404, "Converted file not found.");
    return;
  }

  const stream = fs.createReadStream(job.outputPath);
  stream.on("error", () => send(res, 404, "Converted file not found."));
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${job.outputName}"`,
  });
  stream.pipe(res);
}

async function handleCleanup(res, id) {
  const job = jobs.get(id);
  if (job?.process) {
    job.process.kill("SIGTERM");
  }
  if (job) {
    await removeFile(job.inputPath);
    await removeFile(job.outputPath);
    jobs.delete(id);
  }
  sendJson(res, 200, { ok: true });
}

function handleStatic(req, res) {
  const filePath = getFilePath(req.url || "/");

  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    const extension = path.extname(filePath);
    send(res, 200, data, types[extension] || "application/octet-stream");
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const [, route, id] = url.pathname.split("/");

  if (req.method === "POST" && url.pathname === "/convert") {
    handleUpload(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "GET" && route === "status" && id) {
    handleStatus(res, id);
    return;
  }

  if (req.method === "GET" && route === "download" && id) {
    handleDownload(res, id);
    return;
  }

  if (req.method === "POST" && route === "cleanup" && id) {
    handleCleanup(res, id).catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    handleStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed.");
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, () => {
  console.log(`MOV to MP4 converter running at http://localhost:${PORT}`);
});
