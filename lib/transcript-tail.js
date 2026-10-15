/** Byte-level transcript reads: capped chunks and CRLF-aware line splitting. */
"use strict";

const fs = require("fs");

/** Max bytes read from a transcript file per scan poll (resume at last newline). */
const TRANSCRIPT_READ_MAX_PER_POLL = 256 * 1024;

function isTransientReadError(err) {
  const code = err && err.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function sleepMsSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* Sync ingest path. Short backoff for Windows shared reads */
  }
}

function readBytesAtSync(filePath, readFrom, len, maxAttempts = 6) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, readFrom);
      fs.closeSync(fd);
      return buf;
    } catch (e) {
      lastErr = e;
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch (_e) {
          /* ignore */
        }
      }
      if (!isTransientReadError(e) || attempt === maxAttempts - 1) throw e;
      sleepMsSync(25 * (attempt + 1));
    }
  }
  throw lastErr;
}

function newlineByteLength(buf, nlIndex) {
  if (buf[nlIndex] === 0x0a) return 1;
  if (buf[nlIndex] === 0x0d && nlIndex + 1 < buf.length && buf[nlIndex + 1] === 0x0a) {
    return 2;
  }
  return 1;
}

function findFirstNewlineByte(buf, fromIndex) {
  const from = fromIndex || 0;
  for (let i = from; i < buf.length; i++) {
    if (buf[i] === 0x0a) return i;
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

/** Exclusive end offset within buf after the last complete line (includes trailing newline). */
function completeLinesEndExclusive(buf) {
  let end = -1;
  let i = 0;
  while (i < buf.length) {
    const nl = findFirstNewlineByte(buf, i);
    if (nl < 0) break;
    end = nl + newlineByteLength(buf, nl);
    i = end;
  }
  return end;
}

function forEachCompleteLine(buf, baseFileOffset, fn) {
  let i = 0;
  while (i < buf.length) {
    const lineStart = i;
    const nl = findFirstNewlineByte(buf, i);
    if (nl < 0) break;
    const lineEnd = nl;
    const adv = newlineByteLength(buf, nl);
    const lineStartByte = baseFileOffset + lineStart;
    const trimmed = buf.subarray(lineStart, lineEnd).toString("utf8").trim();
    fn(lineStartByte, trimmed);
    i = nl + adv;
  }
}

/**
 * Scan forward from startOffset in capped chunks until a newline is found.
 * Does not load a full line into memory. Returns exclusive offset after newline, or -1 at EOF.
 */
function findNextNewlineOffset(filePath, startOffset, fileSize) {
  let pos = startOffset;
  if (pos >= fileSize) return -1;
  let fd;
  const scratch = Buffer.alloc(TRANSCRIPT_READ_MAX_PER_POLL);
  try {
    fd = fs.openSync(filePath, "r");
    while (pos < fileSize) {
      const len = Math.min(fileSize - pos, TRANSCRIPT_READ_MAX_PER_POLL);
      const nread = fs.readSync(fd, scratch, 0, len, pos);
      if (nread <= 0) break;
      const slice = scratch.subarray(0, nread);
      const nl = findFirstNewlineByte(slice, 0);
      if (nl >= 0) {
        return pos + nl + newlineByteLength(slice, nl);
      }
      pos += nread;
    }
    return -1;
  } catch (_) {
    return -1;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  TRANSCRIPT_READ_MAX_PER_POLL,
  isTransientReadError,
  sleepMsSync,
  readBytesAtSync,
  newlineByteLength,
  findFirstNewlineByte,
  completeLinesEndExclusive,
  forEachCompleteLine,
  findNextNewlineOffset
};
