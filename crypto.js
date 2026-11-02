// Cifrado compartido por la web (app.js) y la herramienta local (tools/admin.mjs).
// Formato de todo bloque cifrado: IV de 12 bytes + AES-256-GCM.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KDF_ITERATIONS = 600000;

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Base64 apto para nombres de archivo.
const toBase64Url = (bytes) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text) =>
  fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function encryptBytes(key, data) {
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const output = new Uint8Array(12 + cipher.byteLength);
  output.set(iv);
  output.set(new Uint8Array(cipher), 12);
  return output;
}

export async function decryptBytes(key, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  );
}

export const encryptText = async (key, text) =>
  toBase64(await encryptBytes(key, encoder.encode(text)));

export const decryptText = async (key, text) =>
  decoder.decode(await decryptBytes(key, fromBase64(text)));

export const encryptName = async (key, name) =>
  toBase64Url(await encryptBytes(key, encoder.encode(name)));

export const decryptName = async (key, name) =>
  decoder.decode(await decryptBytes(key, fromBase64Url(name)));

export const nameByteLength = (name) => encoder.encode(name).length;

const importAesKey = (raw, extractable = false) =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]);

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// El usuario se guarda como hash para no publicar la lista de nombres.
export async function userId(username) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(username.trim().toLowerCase()),
  );
  return toBase64(digest);
}

export async function wrapMasterKey(masterBytes, password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  return {
    salt: toBase64(salt),
    iterations: KDF_ITERATIONS,
    wrapped: toBase64(await encryptBytes(key, masterBytes)),
  };
}

export async function unwrapMasterBytes(entry, password) {
  const key = await deriveKey(password, fromBase64(entry.salt), entry.iterations);
  return new Uint8Array(await decryptBytes(key, fromBase64(entry.wrapped)));
}

export const importMasterKey = (masterBytes) => importAesKey(masterBytes);
