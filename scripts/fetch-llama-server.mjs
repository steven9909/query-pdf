// Downloads a pinned llama.cpp release and installs llama-server plus its shared libraries as the Tauri sidecar in src-tauri/binaries (usage: node scripts/fetch-llama-server.mjs [--target <triple>]).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "b12237";
const ASSETS = {
  "aarch64-apple-darwin": ["macos-arm64.tar.gz", "40f261953a79ef6cf33bab2fa7746017294eef08816c80a2622cff4afb3ea627"],
  "x86_64-apple-darwin": ["macos-x64.tar.gz", "ea40b6ed5fc05b31e9a7ccf9c016089be0d5f109f736d3f1ebb76bab9755b293"],
  "x86_64-unknown-linux-gnu": ["ubuntu-x64.tar.gz", "ffd7ccfe4ca5f176f730988e049630ab0b943c5f1a1b005f1619a7048a745f68"],
  "aarch64-unknown-linux-gnu": ["ubuntu-arm64.tar.gz", "59a1a4fbd6de10b8b7b33548aed07ceb041da73f82a3334aff21ce598a39d1d4"],
  "x86_64-pc-windows-msvc": ["win-cpu-x64.zip", "1472bc5767155a77811395c7a5504283e3eb7c0aedff113e42d485d3ae00f8c7"],
  "aarch64-pc-windows-msvc": ["win-cpu-arm64.zip", "413b87196bbadaf232d699c0a3bf47ecaddd6c646721b25fe75decd9e3e6be7d"],
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = path.join(ROOT, "src-tauri", "binaries");
const SHARED_LIB = /\.(dylib|dll)$|\.so(\.\d+)*$/;

// Returns the target triple from --target or the host platform.
function resolveTarget() {
  const i = process.argv.indexOf("--target");
  if (i !== -1) {
    const t = process.argv[i + 1];
    if (!t) throw new Error("--target requires a value");
    return t;
  }
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const sys = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[process.platform];
  if (!arch || !sys) throw new Error(`unsupported host ${process.platform}/${process.arch}`);
  return `${arch}-${sys}`;
}

// Downloads a URL into a file, following redirects, and returns its SHA-256 hex digest.
async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url} failed: ${res.status}`);
  const hash = createHash("sha256");
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return hash.digest("hex");
}

// Extracts a .tar.gz or .zip archive with the system tar/unzip.
function extract(archive, dir) {
  if (archive.endsWith(".zip") && process.platform !== "win32") {
    execFileSync("unzip", ["-q", "-o", archive, "-d", dir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  }
}

// Recursively lists every file and symlink below a directory.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Decides whether a shared library from the archive is needed at runtime by llama-server.
function isRuntimeLib(file) {
  const name = path.basename(file);
  if (!SHARED_LIB.test(name)) return false;
  if (/-impl\./.test(name) && !/server-impl\./.test(name)) return false;
  if (fs.lstatSync(file).isSymbolicLink()) return /\.0\.dylib$|\.so\.0$/.test(name);
  return !/\.\d+\.\d+\.\d+\.dylib$|\.so\.\d+\.\d+\.\d+$/.test(name);
}

// Removes shared libraries and llama-server binaries left by a previous run.
function cleanBinDir() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const name of fs.readdirSync(BIN_DIR)) {
    if (SHARED_LIB.test(name) || name.startsWith("llama-server-")) fs.rmSync(path.join(BIN_DIR, name), { force: true });
  }
}

// Fetches, verifies, extracts and installs the sidecar for the selected target.
async function main() {
  const target = resolveTarget();
  const asset = ASSETS[target];
  if (!asset) throw new Error(`no llama.cpp ${RELEASE} asset for ${target}; supported: ${Object.keys(ASSETS).join(", ")}`);
  const [suffix, sha256] = asset;
  const fileName = `llama-${RELEASE}-bin-${suffix}`;
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${fileName}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llama-fetch-"));
  try {
    const archive = path.join(work, fileName);
    console.log(`Downloading ${url}`);
    const digest = await download(url, archive);
    if (digest !== sha256) throw new Error(`SHA-256 mismatch for ${fileName}: expected ${sha256}, got ${digest}`);
    const extracted = path.join(work, "x");
    fs.mkdirSync(extracted);
    extract(archive, extracted);
    const files = walk(extracted);
    const exeName = target.includes("windows") ? "llama-server.exe" : "llama-server";
    const server = files.find((f) => path.basename(f) === exeName);
    if (!server) throw new Error(`${exeName} not found in ${fileName}`);
    cleanBinDir();
    const ext = target.includes("windows") ? ".exe" : "";
    const dest = path.join(BIN_DIR, `llama-server-${target}${ext}`);
    fs.copyFileSync(server, dest);
    fs.chmodSync(dest, 0o755);
    const libs = files.filter(isRuntimeLib);
    for (const lib of libs) {
      const libDest = path.join(BIN_DIR, path.basename(lib));
      fs.copyFileSync(lib, libDest);
      fs.chmodSync(libDest, 0o755);
    }
    console.log(`Installed ${path.relative(ROOT, dest)} with ${libs.length} shared libraries:`);
    for (const lib of libs.map((l) => path.basename(l)).sort()) console.log(`  ${lib}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
