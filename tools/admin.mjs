#!/usr/bin/env node
// Administra users.json desde tu computadora. Las claves y el token nunca salen de aquí sin cifrar.
//   node tools/admin.mjs add-user    crea el disco la primera vez, o agrega/cambia un usuario
//   node tools/admin.mjs set-token   reemplaza el token de GitHub
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  encryptText,
  importMasterKey,
  randomBytes,
  unwrapMasterBytes,
  userId,
  wrapMasterKey,
} from "../crypto.js";

const USERS_FILE = fileURLToPath(new URL("../users.json", import.meta.url));
const REPO = "pbrodriguezm/file-v1";
const BRANCH = "data";
const MIN_PASSWORD_LENGTH = 12;

async function ask(question, { hidden = false } = {}) {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(question);
  const answer = await rl.question("");
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

async function askNewPassword() {
  const password = await ask(`Clave nueva (mínimo ${MIN_PASSWORD_LENGTH} caracteres): `, { hidden: true });
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error("La clave es demasiado corta.");
  if (password !== (await ask("Repite la clave: ", { hidden: true }))) {
    throw new Error("Las claves no coinciden.");
  }
  return password;
}

async function askToken() {
  const token = await ask("Token de GitHub: ", { hidden: true });
  const response = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub rechazó el token (${response.status}).`);
  const repo = await response.json();
  if (!repo.permissions?.push) throw new Error("El token no tiene permiso de escritura en el repositorio.");
  return token;
}

async function unlock(config) {
  const username = await ask("Usuario administrador actual: ");
  const password = await ask("Su clave: ", { hidden: true });
  const entry = config.users[await userId(username)];
  if (!entry) throw new Error("Usuario o clave incorrectos.");
  return unwrapMasterBytes(entry, password).catch(() => {
    throw new Error("Usuario o clave incorrectos.");
  });
}

function save(config) {
  writeFileSync(USERS_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log("users.json actualizado. Publícalo con: git add users.json && git commit -m 'Actualiza usuarios' && git push");
}

async function addUser() {
  const exists = existsSync(USERS_FILE);
  const config = exists
    ? JSON.parse(readFileSync(USERS_FILE, "utf8"))
    : { repo: REPO, branch: BRANCH, vault: null, users: {} };
  let masterBytes;
  if (exists) {
    masterBytes = await unlock(config);
  } else {
    masterBytes = randomBytes(32);
    config.vault = await encryptText(await importMasterKey(masterBytes), await askToken());
  }
  const username = await ask("Usuario: ");
  if (!username) throw new Error("El usuario no puede estar vacío.");
  config.users[await userId(username)] = await wrapMasterKey(masterBytes, await askNewPassword());
  save(config);
}

async function setToken() {
  const config = JSON.parse(readFileSync(USERS_FILE, "utf8"));
  const masterBytes = await unlock(config);
  config.vault = await encryptText(await importMasterKey(masterBytes), await askToken());
  save(config);
}

const commands = { "add-user": addUser, "set-token": setToken };
const command = commands[process.argv[2]];
if (!command) {
  console.error("Uso: node tools/admin.mjs add-user | set-token");
  process.exit(1);
}
command().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
