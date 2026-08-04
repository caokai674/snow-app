import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parentPort } from "node:worker_threads";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "sessions"]);
const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 20;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 2_000;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map();

const canonicalPath = (path) => {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

const limitError = (message) => new Error(`Import scan limit reached: ${message}`);

const scan = (root, maxDepth) => {
  const startedAt = Date.now();
  let fileCount = 0;
  let byteCount = 0;
  const files = [];
  const fingerprints = [];
  const fingerprint = (path, metadata) => ({
    path,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    isDirectory: metadata.isDirectory(),
  });
  const checkTime = () => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw limitError(`more than ${TIMEOUT_MS} ms`);
    }
  };
  const addFile = (filePath, metadata) => {
    fileCount += 1;
    if (fileCount > MAX_FILES) {
      throw limitError(`more than ${MAX_FILES} files`);
    }
    byteCount += metadata.size;
    if (byteCount > MAX_BYTES) {
      throw limitError(`more than ${MAX_BYTES} bytes`);
    }
    files.push(filePath);
    fingerprints.push(fingerprint(filePath, metadata));
  };
  const visit = (current, depth) => {
    checkTime();
    if (depth > maxDepth) {
      throw limitError(`more than ${maxDepth} directory levels`);
    }
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      return;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      addFile(current, metadata);
      return;
    }
    if (!metadata.isDirectory()) return;
    fingerprints.push(fingerprint(current, metadata));
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      visit(join(current, entry.name), depth + 1);
    }
  };
  if (existsSync(root)) visit(root, 0);
  return { files, fingerprints };
};

const cacheEntryIsCurrent = (entry) => entry.fingerprints.every((expected) => {
  try {
    const current = lstatSync(expected.path);
    return current.mtimeMs === expected.mtimeMs &&
      current.size === expected.size &&
      current.isDirectory() === expected.isDirectory;
  } catch {
    return false;
  }
});

const cached = (key, operation) => {
  const existing = cache.get(key);
  if (existing && existing.fingerprints.length > 0 &&
      Date.now() - existing.createdAt < CACHE_TTL_MS && cacheEntryIsCurrent(existing)) {
    return existing.value;
  }
  const { value, fingerprints } = operation();
  cache.set(key, { createdAt: Date.now(), value, fingerprints });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
};

const hashPath = (path) => {
  const root = canonicalPath(path);
  if (!existsSync(root)) {
    return {
      value: createHash("sha256").update(JSON.stringify({ missing: root })).digest("hex"),
      fingerprints: [],
    };
  }
  const hasher = createHash("sha256");
  const result = scan(root, MAX_DEPTH);
  for (const filePath of result.files) {
    hasher.update(relative(root, filePath));
    hasher.update(readFileSync(filePath));
  }
  return { value: hasher.digest("hex"), fingerprints: result.fingerprints };
};

const topLevelDirectories = (root) => {
  if (!existsSync(root)) return { value: [], fingerprints: [] };
  const rootMetadata = lstatSync(root);
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_FILES) throw limitError(`more than ${MAX_FILES} entries`);
  return {
    value: entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(root, entry.name)),
    fingerprints: [{
      path: root,
      mtimeMs: rootMetadata.mtimeMs,
      size: rootMetadata.size,
      isDirectory: true,
    }],
  };
};

parentPort?.on("message", (request) => {
  try {
    if (request.operation === "clear") {
      cache.clear();
      parentPort?.postMessage({ id: request.id, value: "cleared" });
      return;
    }
    if (typeof request.path !== "string" || !request.path) {
      throw new Error("Import discovery worker requires a path");
    }
    const root = canonicalPath(request.path);
    const maxDepth = Math.min(Math.max(Number(request.maxDepth) || MAX_DEPTH, 0), MAX_DEPTH);
    const key = `${request.operation}:${root}:${maxDepth}`;
    const value = request.operation === "hash"
      ? cached(key, () => hashPath(root))
      : request.operation === "directories"
        ? cached(key, () => topLevelDirectories(root))
        : cached(key, () => {
          const result = scan(root, maxDepth);
          return { value: result.files, fingerprints: result.fingerprints };
        });
    parentPort?.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
