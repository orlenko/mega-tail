#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_GLOBS = ["*.log", "*.log.*"];
const DEFAULT_POLL_INTERVAL = 5.0;

const C_RESET = "\u001b[0m";
const C_TIMESTAMP = "\u001b[38;5;81m";
const C_FILE = "\u001b[38;5;245m";
const C_CONTENT = "\u001b[38;5;252m";
const C_INFO = "\u001b[38;5;244m";

function usage() {
  return [
    "mega-tail - Tail dynamic log files in a directory tree.",
    "",
    "Usage:",
    "  mega-tail <directory> [<directory> ...] [options]",
    "",
    "Options:",
    "  --glob <pattern>           Add include glob (repeatable).",
    `  --poll-interval <seconds>  Fallback poll interval (default: ${DEFAULT_POLL_INTERVAL}).`,
    "  -n, --initial-lines <N>    Show last N lines on startup (default: 0).",
    "  --color auto|always|never  Color mode (default: auto).",
    "  --json                     Output structured NDJSON instead of colored text.",
    "  -h, --help                 Show help.",
    "",
    "When multiple directories are passed, each is watched recursively in parallel.",
    "Output paths are rendered relative to whichever supplied root contains the",
    "file (longest match wins when roots overlap).",
  ].join("\n");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    directories: [],
    globs: [],
    pollInterval: DEFAULT_POLL_INTERVAL,
    initialLines: 0,
    color: "auto",
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    if (token === "--glob") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Error: --glob requires a value");
      }
      args.globs.push(value);
      i += 1;
      continue;
    }

    if (token === "--poll-interval") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) {
        throw new Error("Error: --poll-interval requires a numeric value");
      }
      args.pollInterval = value;
      i += 1;
      continue;
    }

    if (token === "-n" || token === "--initial-lines") {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value)) {
        throw new Error("Error: --initial-lines requires an integer value");
      }
      args.initialLines = value;
      i += 1;
      continue;
    }

    if (token === "--json") {
      args.json = true;
      continue;
    }

    if (token === "--color") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Error: --color requires a value");
      }
      args.color = value;
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Error: unknown option: ${token}`);
    }

    args.directories.push(token);
  }

  if (!args.help && args.directories.length === 0) {
    throw new Error("Error: at least one directory is required");
  }

  return args;
}

function colorEnabled(mode) {
  if (mode === "always") {
    return true;
  }
  if (mode === "never") {
    return false;
  }
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
}

function paint(text, color, enabled) {
  if (!enabled) {
    return text;
  }
  return `${color}${text}${C_RESET}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

function detectionTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const min = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());
  const ms = pad3(now.getMilliseconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}.${ms}`;
}

function escapeRegexChar(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegex(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      out += ".*";
      continue;
    }
    if (ch === "?") {
      out += ".";
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (j < glob.length && glob[j] === "!") {
        j += 1;
      }
      if (j < glob.length && glob[j] === "]") {
        j += 1;
      }
      while (j < glob.length && glob[j] !== "]") {
        j += 1;
      }
      if (j >= glob.length) {
        out += "\\[";
      } else {
        let classContent = glob.slice(i + 1, j);
        if (classContent.startsWith("!")) {
          classContent = `^${classContent.slice(1)}`;
        }
        classContent = classContent.replace(/\\/g, "\\\\");
        out += `[${classContent}]`;
        i = j;
      }
      continue;
    }
    out += escapeRegexChar(ch);
  }
  out += "$";
  return new RegExp(out);
}

function matchesGlob(fileName, globRegexes) {
  const lower = fileName.toLowerCase();
  return globRegexes.some((regex) => regex.test(lower));
}

// Async directory walk that yields to the event loop every BATCH_SIZE
// directories, so watchers and signals remain responsive during startup.
async function discoverLogFilesAsync(root, globRegexes, onFound) {
  const BATCH_SIZE = 50;
  const stack = [root];
  let processed = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      if (matchesGlob(entry.name, globRegexes)) {
        onFound(full);
      }
    }

    processed += 1;
    if (processed % BATCH_SIZE === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

function readLastLines(filePath, count) {
  if (count <= 0) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-count);
}

// `roots` must be pre-sorted longest-first so nested overlapping roots
// resolve to the most specific prefix in display paths.
function relativeDisplay(roots, filePath) {
  for (const root of roots) {
    const rel = path.relative(root, filePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  }
  return filePath;
}

function formatOutput(relPath, line, useColor) {
  const fileBlock = paint(`[${relPath}]`, C_FILE, useColor);
  const tsBlock = paint(`[${detectionTimestamp()}]`, C_TIMESTAMP, useColor);
  const content = paint(line, C_CONTENT, useColor);
  return `${fileBlock} ${tsBlock} ${content}`;
}

function jsonLine(relPath, line) {
  return JSON.stringify({ file: relPath, timestamp: detectionTimestamp(), content: line });
}

function jsonInfo(message) {
  return JSON.stringify({ type: "info", message });
}

function jsonStatus(obj) {
  return JSON.stringify({ type: "status", ...obj });
}

function drainNewLines(filePath, state) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return [];
  }

  const inode = stats.ino ?? null;
  const size = stats.size;

  if (state.inode === null) {
    state.inode = inode;
  }

  const rotated = state.inode !== inode;
  const truncated = size < state.position;
  if (rotated || truncated) {
    state.inode = inode;
    state.position = 0;
    state.partial = "";
  }

  if (size <= state.position) {
    return [];
  }

  const toRead = size - state.position;
  let payload = Buffer.alloc(0);
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    payload = Buffer.allocUnsafe(toRead);
    const bytesRead = fs.readSync(fd, payload, 0, toRead, state.position);
    state.position += bytesRead;
    payload = payload.subarray(0, bytesRead);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }

  if (payload.length === 0) {
    return [];
  }

  const chunk = state.partial + payload.toString("utf8");
  const parts = chunk.split(/(\r\n|\n|\r)/);
  const lines = [];

  for (let i = 0; i + 1 < parts.length; i += 2) {
    lines.push(parts[i]);
  }

  state.partial = parts.length % 2 === 1 ? parts[parts.length - 1] : "";
  return lines;
}

function expandHome(inputPath) {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function emitLines(filePath, state, displayRoots, useColor, jsonMode) {
  const lines = drainNewLines(filePath, state);
  if (lines.length === 0) {
    return;
  }
  const rel = relativeDisplay(displayRoots, filePath);
  for (const line of lines) {
    process.stdout.write(
      jsonMode
        ? `${jsonLine(rel, line)}\n`
        : `${formatOutput(rel, line, useColor)}\n`
    );
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    fail(String(error.message || error));
    process.stderr.write("\n");
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  // Resolve and validate every supplied directory; dedupe while preserving
  // first-seen order for display lines.
  const seenRoots = new Set();
  const roots = [];
  for (const raw of args.directories) {
    const resolved = path.resolve(expandHome(raw));
    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      fail(`Error: not a directory: ${resolved}`);
      return 1;
    }
    if (!stats.isDirectory()) {
      fail(`Error: not a directory: ${resolved}`);
      return 1;
    }
    if (!seenRoots.has(resolved)) {
      seenRoots.add(resolved);
      roots.push(resolved);
    }
  }
  // Longest-first lookup table for relative-path rendering.
  const displayRoots = [...roots].sort((a, b) => b.length - a.length);

  if (args.pollInterval <= 0) {
    fail("Error: poll interval must be positive");
    return 1;
  }

  if (args.initialLines < 0) {
    fail("Error: --initial-lines must be >= 0");
    return 1;
  }

  if (!["auto", "always", "never"].includes(args.color)) {
    fail("Error: --color must be one of: auto, always, never");
    return 1;
  }

  const jsonMode = args.json;
  const useColor = jsonMode ? false : colorEnabled(args.color);
  const globs = args.globs.length > 0 ? args.globs : DEFAULT_GLOBS;
  const globRegexes = globs.map((glob) => globToRegex(glob.toLowerCase()));

  const rootsLabel = roots.length === 1 ? roots[0] : roots.join(", ");

  // tracked: filePath -> { position, inode, partial }
  const tracked = new Map();
  // dirWatchers: dirPath -> FSWatcher (one per directory containing log files)
  const dirWatchers = new Map();

  // --- Debounced drain mechanism ---
  const changedFiles = new Set();
  let drainScheduled = false;
  const DRAIN_DELAY_MS = 50;

  function scheduleDrain() {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    setTimeout(flushChanges, DRAIN_DELAY_MS);
  }

  function flushChanges() {
    drainScheduled = false;
    const paths = Array.from(changedFiles);
    changedFiles.clear();

    for (const filePath of paths) {
      const state = tracked.get(filePath);
      if (!state) {
        continue;
      }
      emitLines(filePath, state, displayRoots, useColor, jsonMode);
    }
  }

  // --- Per-directory watcher (for directories containing log files) ---
  function watchDirectory(dirPath) {
    if (dirWatchers.has(dirPath)) {
      return;
    }

    let watcher;
    try {
      watcher = fs.watch(dirPath, (_eventType, filename) => {
        if (!filename) {
          return;
        }

        const fullPath = path.join(dirPath, filename);

        if (tracked.has(fullPath)) {
          changedFiles.add(fullPath);
          scheduleDrain();
          return;
        }

        if (matchesGlob(filename, globRegexes)) {
          let stats;
          try {
            stats = fs.statSync(fullPath);
          } catch {
            return;
          }
          if (!stats.isFile()) {
            return;
          }

          tracked.set(fullPath, {
            position: 0,
            inode: stats.ino ?? null,
            partial: "",
          });

          const rel = relativeDisplay(displayRoots, fullPath);
          process.stdout.write(
            jsonMode
              ? `${jsonInfo(`[watch] ${rel}`)}\n`
              : `${paint(`[watch] ${rel}`, C_INFO, useColor)}\n`
          );

          changedFiles.add(fullPath);
          scheduleDrain();
        }
      });

      watcher.on("error", () => {
        dirWatchers.delete(dirPath);
        try {
          watcher.close();
        } catch {
          // ignore
        }
      });

      dirWatchers.set(dirPath, watcher);
    } catch {
      // Can't watch this directory; will rely on fallback poll
    }
  }

  function trackFile(filePath, position) {
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return false;
    }

    tracked.set(filePath, {
      position: position ?? stats.size,
      inode: stats.ino ?? null,
      partial: "",
    });

    watchDirectory(path.dirname(filePath));
    return true;
  }

  // --- Recursive watcher(s): one per supplied root. On macOS each call is
  // a single FSEvents subscription, efficient even for large trees. Overlapping
  // roots can fire events twice; `tracked.has()` and `dirWatchers.has()` make
  // the second fire a no-op.
  const rootWatchers = [];
  for (const root of roots) {
    let watcher = null;
    try {
      watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          return;
        }

        const basename = path.basename(filename);
        const fullPath = path.join(root, filename);

        if (tracked.has(fullPath)) {
          changedFiles.add(fullPath);
          scheduleDrain();
          return;
        }

        if (!matchesGlob(basename, globRegexes)) {
          return;
        }

        let stats;
        try {
          stats = fs.statSync(fullPath);
        } catch {
          return;
        }
        if (!stats.isFile()) {
          return;
        }

        tracked.set(fullPath, {
          position: 0,
          inode: stats.ino ?? null,
          partial: "",
        });
        watchDirectory(path.dirname(fullPath));

        const rel = relativeDisplay(displayRoots, fullPath);
        process.stdout.write(
          jsonMode
            ? `${jsonInfo(`[watch] ${rel}`)}\n`
            : `${paint(`[watch] ${rel}`, C_INFO, useColor)}\n`
        );

        changedFiles.add(fullPath);
        scheduleDrain();
      });

      const captured = watcher;
      watcher.on("error", () => {
        const idx = rootWatchers.indexOf(captured);
        if (idx >= 0) {
          rootWatchers.splice(idx, 1);
        }
        try {
          captured.close();
        } catch {
          // ignore
        }
      });

      rootWatchers.push(watcher);
    } catch {
      // Recursive watch not supported for this root; rely on fallback poll.
    }
  }

  // --- Initial file discovery (async to avoid blocking event loop) ---
  process.stdout.write(
    jsonMode
      ? `${jsonInfo(`Scanning ${rootsLabel} ...`)}\n`
      : `${paint(`Scanning ${rootsLabel} ...`, C_INFO, useColor)}\n`
  );

  for (const root of roots) {
    await discoverLogFilesAsync(root, globRegexes, (filePath) => {
      if (tracked.has(filePath)) {
        // Already discovered via an overlapping root walk.
        return;
      }
      trackFile(filePath, undefined);

      if (args.initialLines > 0) {
        const rel = relativeDisplay(displayRoots, filePath);
        for (const line of readLastLines(filePath, args.initialLines)) {
          process.stdout.write(
            jsonMode
              ? `${jsonLine(rel, line)}\n`
              : `${formatOutput(rel, line, useColor)}\n`
          );
        }
      }
    });
  }

  if (jsonMode) {
    // Single-root status keeps the original {root: "..."} shape byte-for-byte;
    // multi-root emits {roots: [...]}. Consumers that only ever pass one path
    // see no schema change.
    const statusBody =
      roots.length === 1
        ? { files: tracked.size, directories: dirWatchers.size, root: roots[0], globs }
        : { files: tracked.size, directories: dirWatchers.size, roots, globs };
    process.stdout.write(`${jsonStatus(statusBody)}\n`);
  } else {
    const info =
      `Monitoring ${tracked.size} files in ${dirWatchers.size} directories under ${rootsLabel} ` +
      `(globs: ${globs.join(", ")}). ` +
      "Press Ctrl+C to stop.";
    process.stdout.write(`${paint(info, C_INFO, useColor)}\n`);
  }

  // --- Fallback poll: stat only the tracked files (no full tree walk) ---
  const pollIntervalMs = args.pollInterval * 1000;

  function pollTrackedFiles() {
    for (const [filePath, state] of tracked) {
      emitLines(filePath, state, displayRoots, useColor, jsonMode);
    }
  }

  const pollTimer = setInterval(pollTrackedFiles, pollIntervalMs);

  // --- Wait for shutdown signal ---
  await new Promise((resolve) => {
    const stop = () => {
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  // --- Cleanup ---
  clearInterval(pollTimer);
  for (const w of rootWatchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  rootWatchers.length = 0;
  for (const watcher of dirWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  dirWatchers.clear();

  process.stdout.write(
    jsonMode
      ? `${jsonInfo("Stopping mega-tail.")}\n`
      : `${paint("Stopping mega-tail.", C_INFO, useColor)}\n`
  );
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
