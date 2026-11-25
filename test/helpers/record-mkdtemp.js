/**
 * Preload for child test runs (node --require): appends every folder made by fs.mkdtempSync or
 * fs.promises.mkdtemp to the file named by RECORD_MKDTEMP_LOG, one path per line.
 */
"use strict";

const fs = require("fs");

const logFile = process.env.RECORD_MKDTEMP_LOG;
if (logFile) {
  const sync = fs.mkdtempSync;
  fs.mkdtempSync = function (...args) {
    const dir = sync.apply(this, args);
    fs.appendFileSync(logFile, dir + "\n");
    return dir;
  };
  const async_ = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function (...args) {
    const dir = await async_.apply(this, args);
    fs.appendFileSync(logFile, dir + "\n");
    return dir;
  };
}
