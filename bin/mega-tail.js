#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const DEFAULT_GLOBS = ["*.log", "*.log.*"];
const DEFAULT_POLL_INTERVAL = 0.2;
const DEFAULT_SCAN_INTERVAL = 1.0;

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
    "  mega-tail <directory> [options]",
    "",
    "Options:",
    "  --glob <pattern>           Add include glob (repeatable).",
    `  --poll-interval <seconds>  Read loop interval (default: ${DEFAULT_POLL_INTERVAL}).`,
    `  --scan-interval <seconds>  New-file scan interval (default: ${DEFAULT_SCAN_INTERVAL}).`,
    "  -n, --initial-lines <N>    Show last N lines on startup (default: 0).",
    "  --color auto|always|never  Color mode (default: auto).",
    "  -h, --help                 Show help.",
  ].join("\n");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    directory: null,
    globs: [],
    pollInterval: DEFAULT_POLL_INTERVAL,
    scanInterval: DEFAULT_SCAN_INTERVAL,
    initialLines: 0,
    color: "auto",
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

    if (token === "--scan-interval") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) {
        throw new Error("Error: --scan-interval requires a numeric value");
      }
      args.scanInterval = value;
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

    if (args.directory !== null) {
      throw new Error("Error: only one directory argument is allowed");
    }
    args.directory = token;
  }

  if (!args.help && args.directory === null) {
    throw new Error("Error: directory is required");
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

function discoverLogFiles(root, globRegexes) {
  const matches = new Set();
  const stack = [root];

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

      const lower = entry.name.toLowerCase();
      if (globRegexes.some((regex) => regex.test(lower))) {
        matches.add(full);
      }
    }
  }

  return matches;
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

function relativeDisplay(root, filePath) {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return filePath;
  }
  return rel.split(path.sep).join("/");
}

function formatOutput(relPath, line, useColor) {
  const fileBlock = paint(`[${relPath}]`, C_FILE, useColor);
  const tsBlock = paint(`[${detectionTimestamp()}]`, C_TIMESTAMP, useColor);
  const content = paint(line, C_CONTENT, useColor);
  return `${fileBlock} ${tsBlock} ${content}`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const root = path.resolve(expandHome(args.directory));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`Error: not a directory: ${root}`);
    return 1;
  }

  if (args.pollInterval <= 0 || args.scanInterval <= 0) {
    fail("Error: poll and scan intervals must be positive");
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

  const useColor = colorEnabled(args.color);
  const globs = args.globs.length > 0 ? args.globs : DEFAULT_GLOBS;
  const globRegexes = globs.map((glob) => globToRegex(glob.toLowerCase()));
  const tracked = new Map();

  const existingFiles = Array.from(discoverLogFiles(root, globRegexes)).sort();
  for (const filePath of existingFiles) {
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }

    tracked.set(filePath, {
      position: stats.size,
      inode: stats.ino ?? null,
      partial: "",
    });

    if (args.initialLines > 0) {
      const rel = relativeDisplay(root, filePath);
      for (const line of readLastLines(filePath, args.initialLines)) {
        process.stdout.write(`${formatOutput(rel, line, useColor)}\n`);
      }
    }
  }

  const info =
    `Monitoring ${tracked.size} files under ${root} ` +
    `(globs: ${globs.join(", ")} | poll=${args.pollInterval}s | scan=${args.scanInterval}s). ` +
    "Press Ctrl+C to stop.";
  process.stdout.write(`${paint(info, C_INFO, useColor)}\n`);

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastScan = performance.now() / 1000;

  try {
    while (!stopped) {
      const now = performance.now() / 1000;
      if (now - lastScan >= args.scanInterval) {
        const currentFiles = discoverLogFiles(root, globRegexes);
        const trackedFiles = new Set(tracked.keys());

        const newFiles = Array.from(currentFiles)
          .filter((filePath) => !trackedFiles.has(filePath))
          .sort();

        for (const newPath of newFiles) {
          let stats;
          try {
            stats = fs.statSync(newPath);
          } catch {
            continue;
          }

          tracked.set(newPath, {
            position: 0,
            inode: stats.ino ?? null,
            partial: "",
          });

          const rel = relativeDisplay(root, newPath);
          process.stdout.write(`${paint(`[watch] ${rel}`, C_INFO, useColor)}\n`);
        }

        for (const filePath of trackedFiles) {
          if (!currentFiles.has(filePath)) {
            tracked.delete(filePath);
          }
        }

        lastScan = now;
      }

      const trackedPaths = Array.from(tracked.keys()).sort();
      for (const filePath of trackedPaths) {
        const state = tracked.get(filePath);
        if (!state) {
          continue;
        }

        const lines = drainNewLines(filePath, state);
        if (lines.length === 0) {
          continue;
        }

        const rel = relativeDisplay(root, filePath);
        for (const line of lines) {
          process.stdout.write(`${formatOutput(rel, line, useColor)}\n`);
        }
      }

      if (stopped) {
        break;
      }
      await sleep(args.pollInterval * 1000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  process.stdout.write(`${paint("Stopping mega-tail.", C_INFO, useColor)}\n`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
