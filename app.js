import {
  decryptBytes,
  decryptName,
  decryptText,
  encryptBytes,
  encryptName,
  importMasterKey,
  nameByteLength,
  toBase64,
  unwrapMasterBytes,
  userId,
} from "./crypto.js";

const API = "https://api.github.com";
const ROOT = "files";
const KEEP_FILE = ".keep";
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_NAME_BYTES = 140;
const CIPHER_OVERHEAD = 28;

const $ = (id) => document.getElementById(id);

// Token y clave maestra viven solo en memoria: recargar la página cierra sesión.
let session = null;
let folders = [];
let items = [];
let busy = false;

function apiUrl(path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${API}/repos/${session.config.repo}/contents/${encoded}`;
}

async function github(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (response.ok || (response.status === 404 && options.allow404)) return response;
  if (response.status === 401) throw new Error("GitHub rechazó el token: puede haber vencido.");
  if (response.status === 403) throw new Error("GitHub denegó el acceso: revisa los permisos del token o el límite de uso.");
  if (response.status === 409) throw new Error("El repositorio cambió mientras operabas. Actualiza e inténtalo otra vez.");
  if (response.status === 413 || response.status === 422) throw new Error("GitHub rechazó el archivo: puede ser demasiado grande.");
  throw new Error(`Error de GitHub (${response.status}).`);
}

const currentDir = () => [ROOT, ...folders.map((f) => f.stored)].join("/");

async function listDir(dir) {
  const url = `${apiUrl(dir)}?ref=${encodeURIComponent(session.config.branch)}`;
  const response = await github(url, { allow404: true });
  if (response.status === 404) return [];
  return response.json();
}

async function loadItems() {
  const entries = await listDir(currentDir());
  const decrypted = await Promise.all(
    entries
      .filter((entry) => entry.name !== KEEP_FILE)
      .map(async (entry) => ({
        name: await decryptName(session.key, entry.name).catch(() => null),
        stored: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        isDir: entry.type === "dir",
      })),
  );
  items = decrypted
    .filter((item) => item.name !== null)
    .sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, "es"));
}

async function putFile(path, bytes, sha) {
  await github(apiUrl(path), {
    method: "PUT",
    body: JSON.stringify({
      message: sha ? "Actualiza archivo" : "Agrega archivo",
      content: toBase64(bytes),
      branch: session.config.branch,
      ...(sha && { sha }),
    }),
  });
}

async function deleteFile(path, sha) {
  await github(apiUrl(path), {
    method: "DELETE",
    body: JSON.stringify({
      message: "Elimina archivo",
      sha,
      branch: session.config.branch,
    }),
  });
}

async function deleteTree(dir) {
  for (const entry of await listDir(dir)) {
    if (entry.type === "dir") await deleteTree(entry.path);
    else await deleteFile(entry.path, entry.sha);
  }
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("is-error", isError);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll("#disk-view main button").forEach((button) => {
    button.disabled = value;
  });
}

// Ejecuta una operación a la vez: GitHub responde 409 ante commits simultáneos.
async function run(action) {
  if (busy) return;
  setBusy(true);
  setStatus("");
  try {
    await action();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    await refresh().catch((error) => setStatus(error.message, true));
    setBusy(false);
  }
}

async function refresh() {
  await loadItems();
  render();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function button(label, onClick, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = className;
  element.disabled = busy;
  element.addEventListener("click", onClick);
  return element;
}

function renderBreadcrumbs() {
  const crumbs = [{ name: "Inicio" }, ...folders];
  $("breadcrumbs").replaceChildren(
    ...crumbs.flatMap((crumb, index) => {
      const link = button(crumb.name, () => openFolderAt(index), "link");
      if (index === crumbs.length - 1) link.setAttribute("aria-current", "page");
      if (index === 0) return [link];
      const separator = document.createElement("span");
      separator.className = "muted";
      separator.textContent = "/";
      return [separator, link];
    }),
  );
}

function renderRow(item) {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  if (item.isDir) {
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = "Carpeta";
    name.append(kind, button(item.name, () => openFolder(item), "link"));
  } else {
    name.append(button(item.name, () => download(item), "link"));
  }

  const size = document.createElement("td");
  size.className = "size muted";
  size.textContent = item.isDir ? "" : formatSize(Math.max(item.size - CIPHER_OVERHEAD, 0));

  const actions = document.createElement("td");
  actions.className = "actions";
  if (!item.isDir) actions.append(button("Descargar", () => download(item)));
  actions.append(button("Eliminar", () => remove(item), "danger"));

  row.append(name, size, actions);
  return row;
}

function render() {
  renderBreadcrumbs();
  $("file-list").replaceChildren(...items.map(renderRow));
  $("empty").hidden = items.length > 0;
}

function openFolder(item) {
  folders = [...folders, { name: item.name, stored: item.stored }];
  run(async () => {});
}

function openFolderAt(index) {
  folders = folders.slice(0, index);
  run(async () => {});
}

function validateName(name) {
  if (nameByteLength(name) > MAX_NAME_BYTES) {
    return `El nombre "${name}" es demasiado largo (máximo ${MAX_NAME_BYTES} caracteres).`;
  }
  if (name.includes("/")) return "El nombre no puede contener «/».";
  return null;
}

async function uploadOne(file) {
  const problem = validateName(file.name);
  if (problem) throw new Error(problem);
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`"${file.name}" supera el máximo de ${formatSize(MAX_FILE_BYTES)}.`);
  }
  const existing = items.find((item) => !item.isDir && item.name === file.name);
  if (existing && !confirm(`"${file.name}" ya existe. ¿Reemplazarlo?`)) return false;

  const encrypted = await encryptBytes(session.key, await file.arrayBuffer());
  const stored = existing?.stored ?? (await encryptName(session.key, file.name));
  await putFile(`${currentDir()}/${stored}`, encrypted, existing?.sha);
  return true;
}

function upload(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  run(async () => {
    let done = 0;
    for (const [index, file] of files.entries()) {
      setStatus(`Subiendo ${index + 1} de ${files.length}: ${file.name}`);
      if (await uploadOne(file)) done += 1;
    }
    setStatus(`${done} de ${files.length} archivo(s) subido(s).`);
  });
}

function download(item) {
  run(async () => {
    setStatus(`Descargando ${item.name}`);
    const url = `${apiUrl(item.path)}?ref=${encodeURIComponent(session.config.branch)}`;
    const response = await github(url, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    const plain = await decryptBytes(session.key, await response.arrayBuffer());
    // Tipo genérico: el contenido se descarga y nunca se ejecuta en este sitio.
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([plain], { type: "application/octet-stream" }));
    link.download = item.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    setStatus("");
  });
}

function remove(item) {
  const question = item.isDir
    ? `¿Eliminar la carpeta "${item.name}" y todo su contenido?`
    : `¿Eliminar "${item.name}"?`;
  if (!confirm(question)) return;
  run(async () => {
    if (item.isDir) await deleteTree(item.path);
    else await deleteFile(item.path, item.sha);
    setStatus(`"${item.name}" eliminado.`);
  });
}

function newFolder() {
  const name = prompt("Nombre de la carpeta")?.trim();
  if (!name) return;
  run(async () => {
    const problem = validateName(name);
    if (problem) throw new Error(problem);
    if (items.some((item) => item.name === name)) throw new Error(`"${name}" ya existe.`);
    const stored = await encryptName(session.key, name);
    await putFile(`${currentDir()}/${stored}/${KEEP_FILE}`, new Uint8Array());
  });
}

async function login(username, password) {
  const response = await fetch("users.json", { cache: "no-store" });
  if (!response.ok) throw new Error("El disco aún no está configurado.");
  const config = await response.json();
  const entry = config.users[await userId(username)];
  if (!entry) throw new Error("Usuario o clave incorrectos.");

  let masterBytes;
  try {
    masterBytes = await unwrapMasterBytes(entry, password);
  } catch {
    throw new Error("Usuario o clave incorrectos.");
  }
  const key = await importMasterKey(masterBytes);
  const token = await decryptText(key, config.vault);
  return { config, key, token, username: username.trim() };
}

function logout() {
  session = null;
  folders = [];
  items = [];
  location.reload();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginButton = $("login-button");
  const password = $("login-pass");
  loginButton.disabled = true;
  $("login-error").textContent = "";
  try {
    session = await login($("login-user").value, password.value);
    password.value = "";
    $("current-user").textContent = session.username;
    $("login-view").hidden = true;
    $("disk-view").hidden = false;
    await run(async () => {});
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    loginButton.disabled = false;
  }
});

$("logout").addEventListener("click", logout);
$("new-folder").addEventListener("click", newFolder);
$("upload-button").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  upload(event.target.files);
  event.target.value = "";
});

const dropzone = $("dropzone");
["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-over");
  }),
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, () => dropzone.classList.remove("is-over")),
);
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  upload(event.dataTransfer.files);
});
