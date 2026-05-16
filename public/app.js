const dropzone = document.querySelector("#dropzone");
const fileInput = document.querySelector("#file-input");
const filePanel = document.querySelector("#file-panel");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const progressPanel = document.querySelector("#progress-panel");
const progressBar = document.querySelector("#progress-bar");
const progressPercent = document.querySelector("#progress-percent");
const statusText = document.querySelector("#status-text");
const convertButton = document.querySelector("#convert-button");
const resetButton = document.querySelector("#reset-button");
const downloadLink = document.querySelector("#download-link");
const message = document.querySelector("#message");

let selectedFile = null;
let activeRequest = null;
let activeJobId = null;
let pollTimer = null;

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function setProgress(percent, text) {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  progressPanel.hidden = false;
  progressBar.style.width = `${normalized}%`;
  progressPercent.textContent = `${normalized}%`;
  statusText.textContent = text;
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy || !selectedFile;
  resetButton.disabled = !selectedFile && !activeJobId;
  fileInput.disabled = isBusy;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function clearDownload() {
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");
}

async function cleanupJob() {
  if (!activeJobId) return;

  try {
    await fetch(`/cleanup/${activeJobId}`, { method: "POST" });
  } catch {
    // Cleanup is best effort.
  }
}

async function reset() {
  if (activeRequest) {
    activeRequest.abort();
    activeRequest = null;
  }

  stopPolling();
  await cleanupJob();

  selectedFile = null;
  activeJobId = null;
  fileInput.value = "";
  filePanel.hidden = true;
  progressPanel.hidden = true;
  progressBar.style.width = "0%";
  progressPercent.textContent = "0%";
  clearDownload();
  setMessage("");
  setBusy(false);
  resetButton.disabled = true;
}

function rejectFile(text) {
  selectedFile = null;
  fileInput.value = "";
  filePanel.hidden = true;
  progressPanel.hidden = true;
  clearDownload();
  setMessage(text, true);
  convertButton.disabled = true;
  resetButton.disabled = false;
}

function selectFile(file) {
  clearDownload();
  activeJobId = null;
  stopPolling();

  if (!file) return;

  const isMov =
    file.name.toLowerCase().endsWith(".mov") ||
    file.type === "video/quicktime";

  if (!isMov) {
    rejectFile("Please choose a .mov file.");
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  filePanel.hidden = false;
  progressPanel.hidden = true;
  setMessage("Ready to upload and convert on the server.");
  convertButton.disabled = false;
  resetButton.disabled = false;
}

function getOutputName(inputName) {
  return inputName.replace(/\.[^.]+$/, "") + ".mp4";
}

async function pollStatus() {
  if (!activeJobId) return;

  try {
    const response = await fetch(`/status/${activeJobId}`);
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || "Could not read conversion status.");
    }

    if (job.status === "failed") {
      throw new Error(job.message || "Conversion failed.");
    }

    if (job.status === "ready") {
      setProgress(100, "Conversion complete");
      downloadLink.href = job.downloadUrl;
      downloadLink.download = getOutputName(selectedFile.name);
      downloadLink.hidden = false;
      setMessage("Your MP4 is ready to download.");
      activeRequest = null;
      setBusy(false);
      return;
    }

    setProgress(job.progress || 0, job.message || "Converting...");
    pollTimer = setTimeout(pollStatus, 1500);
  } catch (error) {
    activeRequest = null;
    setBusy(false);
    setMessage(error.message || "Conversion failed.", true);
  }
}

function uploadAndConvert() {
  if (!selectedFile) return;

  setBusy(true);
  clearDownload();
  setMessage("Uploading to the server...");
  setProgress(0, "Uploading...");

  const request = new XMLHttpRequest();
  activeRequest = request;

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) {
      setProgress(0, "Uploading...");
      return;
    }

    setProgress((event.loaded / event.total) * 100, "Uploading...");
  });

  request.addEventListener("load", () => {
    try {
      const payload = JSON.parse(request.responseText || "{}");

      if (request.status < 200 || request.status >= 300) {
        throw new Error(payload.error || "Upload failed.");
      }

      activeJobId = payload.id;
      setProgress(0, "Upload complete. Conversion is starting...");
      setMessage("Converting with server FFmpeg. Keep this page open.");
      pollStatus();
    } catch (error) {
      activeRequest = null;
      setBusy(false);
      setMessage(error.message || "Upload failed.", true);
    }
  });

  request.addEventListener("error", () => {
    activeRequest = null;
    setBusy(false);
    setMessage("Upload failed. Check that the server is still running.", true);
  });

  request.addEventListener("abort", () => {
    setMessage("Conversion canceled.");
  });

  request.open("POST", "/convert");
  request.setRequestHeader("Content-Type", "application/octet-stream");
  request.setRequestHeader("X-File-Name", encodeURIComponent(selectedFile.name));
  request.send(selectedFile);
}

fileInput.addEventListener("change", () => {
  selectFile(fileInput.files[0]);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  selectFile(event.dataTransfer.files[0]);
});

convertButton.addEventListener("click", uploadAndConvert);
resetButton.addEventListener("click", reset);
