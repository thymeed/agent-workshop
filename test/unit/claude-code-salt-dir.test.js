/**
 * The label salt lives in its own config folder, never the event-log folder: the resolver per
 * platform, a fresh install, the migration from the old folder (and its failure paths), and the
 * POSIX modes. Real fs, inside the worktree's .scratch/ (never the real config folder).
 */
"use strict";

const assert = require("node:assert/strict");
const nodeFs = require("fs");
const nodePath = require("path");
const crypto = require("crypto");
const { test } = require("node:test");
const S = require("../../lib/claude-code-sources.js");

const BASE = nodePath.join(__dirname, "..", "..", ".scratch", "tmp");
const FILE = "label-salt.bin";
const OLD = Buffer.alloc(16, 5);
const LABELS_UNSTABLE = { code: "labels-unstable", text: "Labels change after restart" };

function scratch(fn) {
  return (t) => {
    nodeFs.mkdirSync(BASE, { recursive: true });
    const root = nodeFs.mkdtempSync(nodePath.join(BASE, "salt-dir-"));
    const dirs = { root, cfg: nodePath.join(root, "config"), log: nodePath.join(root, "log") };
    nodeFs.mkdirSync(dirs.log);
    try {
      return fn(dirs, t);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  };
}
const read = (dir, name = FILE) => nodeFs.readFileSync(nodePath.join(dir, name));
const listing = (dir) => nodeFs.readdirSync(dir).sort();
const hmac6 = (salt, text) =>
  crypto.createHmac("sha256", salt).update(text).digest("hex").slice(0, 6);
const pathFree = (note, ...dirs) => {
  const text = JSON.stringify(note);
  for (const d of dirs) assert.ok(!text.includes(d) && !text.includes(nodePath.basename(d)), text);
};

test("resolveSaltDir: per platform, never the log folder, ignores CURSOR_EVENT_LOG_DIR", () => {
  const NAME = "cursor-agents-model-routing-config";
  const logEnv = { CURSOR_EVENT_LOG_DIR: "/data/log" };
  const w = (env, homedir) => S.resolveSaltDir({ platform: "win32", env, homedir });
  const BS = String.fromCharCode(92);
  const winHome = "C:" + BS + "Users" + BS + "user";
  assert.equal(
    w({ ...logEnv, LOCALAPPDATA: "D:" + BS + "Local" }, winHome),
    "D:" + BS + "Local" + BS + NAME
  );
  assert.equal(w(logEnv, winHome), winHome + BS + "AppData" + BS + "Local" + BS + NAME);
  assert.equal(
    w({ LOCALAPPDATA: "relative" }, winHome),
    winHome + BS + "AppData" + BS + "Local" + BS + NAME,
    "a relative LOCALAPPDATA is not trusted"
  );
  assert.equal(
    S.resolveSaltDir({ platform: "darwin", env: logEnv, homedir: "/Users/user" }),
    "/Users/user/Library/Application Support/" + NAME
  );
  const lin = (env) => S.resolveSaltDir({ platform: "linux", env, homedir: "/home/user" });
  assert.equal(lin({ ...logEnv, XDG_CONFIG_HOME: "/xdg/cfg" }), "/xdg/cfg/" + NAME);
  assert.equal(lin(logEnv), "/home/user/.config/" + NAME);
  assert.equal(lin({ XDG_CONFIG_HOME: "rel" }), "/home/user/.config/" + NAME);
  assert.equal(S.resolveSaltDir({ platform: "linux", env: {}, homedir: "" }), "");
  for (const dir of [w(logEnv, winHome), lin(logEnv), lin({ XDG_DATA_HOME: "/data/log" })]) {
    assert.ok(!dir.startsWith("/data/log"), dir);
    assert.ok(dir.endsWith(NAME), dir);
  }
});

test(
  "fresh install: the salt is created in the config folder, nothing in the log folder",
  scratch(({ cfg, log }) => {
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.deepEqual(read(cfg), res.salt);
    assert.deepEqual(listing(cfg), [FILE]);
    assert.deepEqual(listing(log), [], "the log folder is untouched");
  })
);

test(
  "migration: the old salt moves over, ids and labels stay, leftovers go, neighbours stay",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    const tmpName = FILE + ".tmp-0123456789ab";
    const graveName = FILE + ".stale-1700000000000-0123456789abcdef";
    const lockName = FILE + ".lock";
    for (const n of [tmpName, graveName, lockName])
      nodeFs.writeFileSync(nodePath.join(log, n), "x");
    const aged = new Date(Date.now() - 60000);
    nodeFs.utimesSync(nodePath.join(log, lockName), aged, aged);
    const keep = [
      "event-log.jsonl",
      FILE + ".keep",
      FILE + ".tmp-notHex!",
      "label-salt.bin.tmp-",
      // a bad start that a wrong prefix length would cut away to hex
      FILE + ".tmp-zz0123",
      FILE + ".stale-zz0123"
    ];
    for (const n of keep) nodeFs.writeFileSync(nodePath.join(log, n), "keep");
    const before = hmac6(OLD, "/proj/a");
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.deepEqual(res.salt, OLD);
    assert.equal(hmac6(res.salt, "/proj/a"), before, "labels and ids are identical");
    assert.deepEqual(read(cfg), OLD);
    assert.deepEqual(listing(log), keep.slice().sort(), "only our salt files are gone");
    for (const n of keep) assert.equal(read(log, n).toString(), "keep");
    // a second start reads the config folder and finds nothing more to do
    assert.deepEqual(S.loadOrCreateSalt({ dir: cfg, oldDir: log }).salt, OLD);
  })
);

test(
  "migration: a lock younger than the stale limit is left alone",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    nodeFs.writeFileSync(nodePath.join(log, FILE + ".lock"), "live");
    S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.deepEqual(listing(log), [FILE + ".lock"]);
  })
);

test(
  "migration failure: the new folder cannot be written, so the old file stays",
  scratch(({ root, cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    // a plain file stands where the config folder should be
    const blocked = nodePath.join(root, "blocked");
    nodeFs.writeFileSync(blocked, "x");
    const res = S.loadOrCreateSalt({ dir: blocked, oldDir: log });
    assert.deepEqual(res.note, LABELS_UNSTABLE);
    assert.equal(res.salt.length, 16);
    assert.deepEqual(read(log), OLD, "old salt kept");
    assert.deepEqual(listing(log), [FILE], "nothing written into the log folder");
    pathFree(res.note, root, log, blocked);
    // a temp file that cannot be created
    const fsStub = {
      ...nodeFs,
      openSync: (p, ...a) => {
        if (String(p).includes(FILE + ".tmp-"))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return nodeFs.openSync(p, ...a);
      }
    };
    const res2 = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.deepEqual(res2.note, LABELS_UNSTABLE);
    assert.notDeepEqual(res2.salt, OLD, "a per-process salt, not the old one");
    assert.deepEqual(read(log), OLD);
    assert.deepEqual(listing(log), [FILE]);
    assert.ok(!nodeFs.existsSync(nodePath.join(cfg, FILE)));
    pathFree(res2.note, root, cfg);
  })
);

test(
  "migration failure: the read-back differs, so the old file stays",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    let published = false;
    const other = Buffer.alloc(16, 3);
    const fsStub = {
      ...nodeFs,
      linkSync: (...a) => {
        nodeFs.linkSync(...a);
        published = true;
      },
      readFileSync: (p, ...a) =>
        published && nodePath.dirname(String(p)) === cfg ? other : nodeFs.readFileSync(p, ...a)
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.equal(published, true, "the copy was published");
    assert.deepEqual(res.note, LABELS_UNSTABLE);
    assert.notDeepEqual(res.salt, OLD);
    assert.notDeepEqual(res.salt, other);
    assert.deepEqual(read(log), OLD, "old salt kept");
    assert.deepEqual(listing(log), [FILE]);
    pathFree(res.note, cfg, log);
  })
);

test(
  "migration: an old file that cannot be deleted is left behind, the new salt is used",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    // a leftover of ours: it stays too while the salt file itself stays
    const leftover = FILE + ".tmp-abc";
    nodeFs.writeFileSync(nodePath.join(log, leftover), "x");
    const fsStub = {
      ...nodeFs,
      unlinkSync: (p) => {
        if (String(p) === nodePath.join(log, FILE)) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return nodeFs.unlinkSync(p);
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.equal(res.note, undefined);
    assert.deepEqual(res.salt, OLD);
    assert.deepEqual(listing(log), [FILE, leftover]);
  })
);

test(
  "old-file delete guard: an identity that cannot be proven (inode 0, realpath fails) keeps the old file",
  scratch(({ cfg, log }) => {
    const NEW = Buffer.alloc(16, 8);
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), NEW);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    const fsStub = {
      ...nodeFs,
      statSync: (p, o) => {
        const st = nodeFs.statSync(p, o);
        // Windows-style: salt files report inode 0, so only the real path can tell them apart
        return o && o.bigint && nodePath.basename(String(p)) === FILE ? { ...st, ino: 0n } : st;
      },
      realpathSync: (p, ...a) => {
        if (String(p) === nodePath.join(log, FILE)) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return nodeFs.realpathSync(p, ...a);
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.deepEqual(res.salt, NEW, "the salt in the config folder wins");
    assert.deepEqual(read(log), OLD, "the old file is not deleted on an unproven identity");
    assert.deepEqual(read(cfg), NEW);
  })
);

test(
  "no old folder (empty or missing oldDir): nothing outside the config folder is read, listed or deleted",
  scratch(({ cfg }) => {
    for (const oldDir of ["", undefined]) {
      const touched = [];
      const spy =
        (name) =>
        (p, ...a) => {
          if (typeof p === "string" || p instanceof URL) touched.push(String(p));
          return nodeFs[name](p, ...a);
        };
      const fsStub = { ...nodeFs };
      for (const n of [
        "statSync",
        "readFileSync",
        "unlinkSync",
        "readdirSync",
        "realpathSync",
        "openSync",
        "linkSync",
        "renameSync",
        "mkdirSync",
        "chmodSync"
      ]) {
        fsStub[n] = spy(n);
      }
      nodeFs.rmSync(cfg, { recursive: true, force: true });
      const res = S.loadOrCreateSalt({ dir: cfg, oldDir, fs: fsStub });
      assert.equal(res.note, undefined);
      assert.deepEqual(read(cfg), res.salt, "a fresh salt is created");
      assert.ok(touched.length > 0);
      for (const p of touched) assert.ok(p.startsWith(cfg), "touched outside the config folder");
      assert.ok(
        !touched.some((p) => nodePath.basename(p) === FILE && nodePath.dirname(p) !== cfg),
        "no salt file elsewhere"
      );
    }
  })
);

test(
  "POSIX modes: group and other bits (0750 folder, 0640 file) are tightened to 0700 and 0600",
  scratch(({ cfg, log }, t) => {
    if (process.platform === "win32") {
      t.skip("POSIX modes do not apply on Windows (the profile ACL protects the folder)");
      return;
    }
    const mode = (p) => nodeFs.statSync(p).mode & 0o777;
    nodeFs.mkdirSync(cfg);
    nodeFs.chmodSync(cfg, 0o750);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), Buffer.alloc(16, 8));
    nodeFs.chmodSync(nodePath.join(cfg, FILE), 0o640);
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.deepEqual(res.salt, Buffer.alloc(16, 8));
    assert.equal(mode(cfg), 0o700);
    assert.equal(mode(nodePath.join(cfg, FILE)), 0o600);
  })
);

test(
  "a chmod that throws during a migration gives the permissions note and the migration still completes",
  scratch(({ root, cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    const fsStub = {
      ...nodeFs,
      statSync: (p, ...a) => {
        const st = nodeFs.statSync(p, ...a);
        return a.length && a[0] && a[0].bigint ? st : { ...st, mode: 0o100644 };
      },
      chmodSync: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, posix: true });
    assert.equal(res.note.code, "salt-folder-permissions");
    assert.deepEqual(res.salt, OLD, "ids and labels stay");
    assert.deepEqual(read(cfg), OLD, "published in the config folder");
    assert.deepEqual(listing(log), [], "old copy removed");
    pathFree(res.note, root, cfg, log);
  })
);

test(
  "an old file of the wrong length is not migrated; a fresh salt is made and the stale file removed",
  scratch(({ cfg, log }) => {
    const bad = Buffer.alloc(40, 5);
    nodeFs.writeFileSync(nodePath.join(log, FILE), bad);
    nodeFs.writeFileSync(nodePath.join(log, "event-log.jsonl"), "keep");
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.equal(res.salt.length, 16);
    assert.notDeepEqual(res.salt, bad.subarray(0, 16), "nothing taken from the invalid file");
    assert.deepEqual(read(cfg), res.salt);
    assert.deepEqual(listing(log), ["event-log.jsonl"]);
  })
);

test(
  "a valid salt already in the config folder wins over a different old one, which is deleted",
  scratch(({ cfg, log }) => {
    const NEW = Buffer.alloc(16, 8);
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), NEW);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.deepEqual(res.salt, NEW);
    assert.deepEqual(read(cfg), NEW);
    assert.deepEqual(listing(log), [], "the unused old copy is removed");
  })
);

test(
  "the same folder for both is never migrated or deleted",
  scratch(({ cfg }) => {
    const a = S.loadOrCreateSalt({ dir: cfg, oldDir: cfg });
    assert.deepEqual(read(cfg), a.salt);
    assert.deepEqual(S.loadOrCreateSalt({ dir: cfg, oldDir: cfg }).salt, a.salt);
    assert.deepEqual(read(cfg), a.salt, "the salt file is still there");
  })
);

test(
  "POSIX modes: folder 0700 and file 0600, a loose existing folder is tightened",
  scratch(({ cfg, log }, t) => {
    if (process.platform === "win32") {
      t.skip("POSIX modes do not apply on Windows (the profile ACL protects the folder)");
      return;
    }
    const mode = (p) => nodeFs.statSync(p).mode & 0o777;
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.equal(mode(cfg), 0o700);
    assert.equal(mode(nodePath.join(cfg, FILE)), 0o600);
    // loose folder and file
    nodeFs.chmodSync(cfg, 0o755);
    nodeFs.chmodSync(nodePath.join(cfg, FILE), 0o644);
    assert.equal(S.loadOrCreateSalt({ dir: cfg, oldDir: log }).note, undefined);
    assert.equal(mode(cfg), 0o700);
    assert.equal(mode(nodePath.join(cfg, FILE)), 0o600);
    // a migrated file ends 0600 too
    const cfg2 = nodePath.join(nodePath.dirname(cfg), "config2");
    nodeFs.mkdirSync(cfg2, { mode: 0o755 });
    nodeFs.chmodSync(cfg2, 0o755);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD, { mode: 0o644 });
    S.loadOrCreateSalt({ dir: cfg2, oldDir: log });
    assert.equal(mode(cfg2), 0o700);
    assert.equal(mode(nodePath.join(cfg2, FILE)), 0o600);
  })
);

test(
  "POSIX: a folder that cannot be tightened gives a path-free note and the salt still works",
  scratch(({ root, cfg, log }, t) => {
    if (process.platform === "win32") {
      t.skip("POSIX modes do not apply on Windows (the profile ACL protects the folder)");
      return;
    }
    nodeFs.mkdirSync(cfg, { mode: 0o755 });
    nodeFs.chmodSync(cfg, 0o755);
    const fsStub = {
      ...nodeFs,
      chmodSync: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.equal(res.salt.length, 16);
    assert.equal(res.note.code, "salt-folder-permissions");
    pathFree(res.note, root, cfg);
  })
);

test(
  "POSIX rules run on any platform through a recording fs: mkdir 0700, loose modes tightened",
  scratch(({ cfg, log }) => {
    const calls = [];
    const fsStub = {
      ...nodeFs,
      mkdirSync: (p, o) => {
        calls.push(["mkdir", o && o.mode]);
        return nodeFs.mkdirSync(p, o);
      },
      statSync: (p, ...a) => {
        const st = nodeFs.statSync(p, ...a);
        return { ...st, mode: 0o100644, mtimeMs: st.mtimeMs };
      },
      chmodSync: (p, mode) => calls.push(["chmod", nodePath.basename(p), mode])
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, posix: true });
    assert.equal(res.note, undefined);
    assert.ok(
      calls.some((c) => c[0] === "mkdir" && c[1] === 0o700),
      JSON.stringify(calls)
    );
    assert.ok(calls.some((c) => c[0] === "chmod" && c[1] === "config" && c[2] === 0o700));
    assert.ok(calls.some((c) => c[0] === "chmod" && c[1] === FILE && c[2] === 0o600));
    // posix:false never chmods
    calls.length = 0;
    S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, posix: false });
    assert.ok(!calls.some((c) => c[0] === "chmod"));
  })
);

test("resolveSaltDir: a relative home never gives a relative folder", () => {
  const NAME = "cursor-agents-model-routing-config";
  const BS = String.fromCharCode(92);
  for (const homedir of ["rel", "./rel", "", ".."]) {
    assert.equal(S.resolveSaltDir({ platform: "win32", env: {}, homedir }), "", homedir);
    assert.equal(S.resolveSaltDir({ platform: "darwin", env: {}, homedir }), "", homedir);
    assert.equal(S.resolveSaltDir({ platform: "linux", env: {}, homedir }), "", homedir);
    assert.equal(
      S.resolveSaltDir({ platform: "linux", env: { XDG_CONFIG_HOME: "rel" }, homedir }),
      "",
      "a relative XDG_CONFIG_HOME does not rescue a relative home"
    );
  }
  // an absolute LOCALAPPDATA / XDG_CONFIG_HOME does not need a home
  assert.equal(
    S.resolveSaltDir({ platform: "win32", env: { LOCALAPPDATA: "D:" + BS + "L" }, homedir: "rel" }),
    "D:" + BS + "L" + BS + NAME
  );
  assert.equal(
    S.resolveSaltDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/x" }, homedir: "rel" }),
    "/x/" + NAME
  );
  // an empty result means no salt folder: a per-process salt and a note, nothing written
  const res = S.loadOrCreateSalt({ dir: "", oldDir: "/somewhere" });
  assert.deepEqual(res.note, LABELS_UNSTABLE);
});

const TRY_ERR = new Set(["EPERM", "EACCES", "ENOSYS", "UNKNOWN", "EEXIST"]);
function tryLink(target, linkPath, type) {
  try {
    nodeFs.symlinkSync(target, linkPath, type);
    return true;
  } catch (e) {
    if (e && TRY_ERR.has(e.code)) return false;
    throw e;
  }
}
/** Run the same call three times: the salt must not change and the file must stay. */
function threeStarts(cfg, oldDir) {
  const first = S.loadOrCreateSalt({ dir: cfg, oldDir });
  assert.equal(first.note, undefined);
  for (let i = 0; i < 2; i++) {
    const again = S.loadOrCreateSalt({ dir: cfg, oldDir });
    assert.equal(again.note, undefined);
    assert.deepEqual(again.salt, first.salt, "same salt on start " + (i + 2));
    assert.ok(nodeFs.existsSync(nodePath.join(cfg, FILE)), "salt file still there");
    assert.deepEqual(read(cfg), first.salt);
  }
}

test(
  "same folder under another spelling is never migrated or deleted: case variant (win32 only)",
  scratch(({ cfg }, t) => {
    if (process.platform !== "win32") {
      t.skip("case-insensitive folders are a Windows case");
      return;
    }
    threeStarts(cfg, cfg.toUpperCase());
  })
);

test(
  "same folder through a symlink is never migrated or deleted",
  scratch(({ root, cfg }, t) => {
    nodeFs.mkdirSync(cfg);
    const link = nodePath.join(root, "cfg-link");
    if (!tryLink(cfg, link, "dir")) {
      t.skip("symlinks are not permitted here");
      return;
    }
    threeStarts(cfg, link);
    // and the other way round: the link is the salt folder, the real folder the old one
    threeStarts(link, cfg);
  })
);

test(
  "same folder through a directory junction (Windows) or symlink (POSIX) is never migrated or deleted",
  scratch(({ root, cfg }, t) => {
    nodeFs.mkdirSync(cfg);
    const link = nodePath.join(root, "cfg-junction");
    if (!tryLink(cfg, link, process.platform === "win32" ? "junction" : "dir")) {
      t.skip("junctions or symlinks are not permitted here");
      return;
    }
    threeStarts(cfg, link);
  })
);

test(
  "an old salt file that is the same file as the new one (hard link) is never deleted",
  scratch(({ cfg, log }, t) => {
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), OLD);
    try {
      nodeFs.linkSync(nodePath.join(cfg, FILE), nodePath.join(log, FILE));
    } catch {
      t.skip("hard links are not available here");
      return;
    }
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.deepEqual(res.salt, OLD);
    assert.deepEqual(read(log), OLD, "the old name is kept: it is the same file");
    assert.deepEqual(read(cfg), OLD);
  })
);

test(
  "an old salt file that is a symlink to the new one is never deleted",
  scratch(({ cfg, log }, t) => {
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), OLD);
    if (!tryLink(nodePath.join(cfg, FILE), nodePath.join(log, FILE), "file")) {
      t.skip("file symlinks are not permitted here");
      return;
    }
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.deepEqual(res.salt, OLD);
    assert.ok(nodeFs.lstatSync(nodePath.join(log, FILE)).isSymbolicLink(), "link kept");
    assert.deepEqual(read(cfg), OLD);
  })
);

const fastRetry = () => {
  let clock = 0;
  return { mono: () => (clock += 10), sleep: () => {}, lockWaitMs: 50 };
};
const err = (code) => Object.assign(new Error("x"), { code });
/** Stub fs: statSync(bigint) of the old folder fails; or inode 0 everywhere; or realpath fails. */
const unknownCases = {
  "a stat of the old folder throws EACCES": (log) => ({
    statSync: (p, ...a) => {
      if (String(p) === log) throw err("EACCES");
      return nodeFs.statSync(p, ...a);
    }
  }),
  "a stat of the old folder throws EIO": (log) => ({
    statSync: (p, ...a) => {
      if (String(p) === log) throw err("EIO");
      return nodeFs.statSync(p, ...a);
    }
  }),
  "realpath throws (inode 0 forces the fallback)": () => ({
    statSync: (p, o, ...a) => (o && o.bigint ? { ino: 0n, dev: 0n } : nodeFs.statSync(p, o, ...a)),
    realpathSync: () => {
      throw err("EPERM");
    }
  }),
  "the old read throws EBUSY for good": (log) => ({
    readFileSync: (p, ...a) => {
      if (String(p) === nodePath.join(log, FILE)) throw err("EBUSY");
      return nodeFs.readFileSync(p, ...a);
    }
  })
};
for (const [name, make] of Object.entries(unknownCases)) {
  test(
    "cannot tell about the old folder (" +
      name +
      "): per-process salt, nothing published, old file kept, next start migrates",
    scratch(({ cfg, log }) => {
      nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
      const ids = hmac6(OLD, "/proj/a");
      const fsStub = { ...nodeFs, ...make(log) };
      const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, ...fastRetry() });
      assert.deepEqual(res.note, LABELS_UNSTABLE);
      assert.equal(res.salt.length, 16);
      assert.notDeepEqual(res.salt, OLD);
      assert.ok(!nodeFs.existsSync(nodePath.join(cfg, FILE)), "nothing published");
      assert.deepEqual(listing(cfg), []);
      assert.deepEqual(read(log), OLD, "old file byte-identical");
      assert.deepEqual(listing(log), [FILE]);
      pathFree(res.note, cfg, log);
      // the next start, with the real fs, gets the original salt and migrates it
      const next = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
      assert.equal(next.note, undefined);
      assert.deepEqual(next.salt, OLD);
      assert.equal(hmac6(next.salt, "/proj/a"), ids, "same ids as before");
      assert.deepEqual(read(cfg), OLD);
      assert.deepEqual(listing(log), []);
    })
  );
}

test(
  "the first mkdir of the config folder fails (EBUSY) so it is missing: per-process salt, nothing published, next start migrates",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    let failed = false;
    const fsStub = {
      ...nodeFs,
      mkdirSync: (p, ...a) => {
        if (!failed && String(p) === cfg) {
          failed = true;
          throw err("EBUSY");
        }
        return nodeFs.mkdirSync(p, ...a);
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, ...fastRetry() });
    assert.ok(failed, "the stub failed the first mkdir");
    assert.deepEqual(res.note, LABELS_UNSTABLE);
    assert.notDeepEqual(res.salt, OLD);
    assert.ok(
      !nodeFs.existsSync(nodePath.join(cfg, FILE)),
      "nothing published in the config folder"
    );
    assert.deepEqual(read(log), OLD, "old file byte-identical");
    pathFree(res.note, cfg, log);
    const next = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(next.note, undefined);
    assert.deepEqual(next.salt, OLD, "the original ids come back");
    assert.deepEqual(read(cfg), OLD);
    assert.deepEqual(listing(log), []);
  })
);

test(
  "cannot tell about the old folder, but the config folder holds a valid salt: that salt, no note, old kept",
  scratch(({ cfg, log }) => {
    const NEW = Buffer.alloc(16, 8);
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), NEW);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    for (const make of Object.values(unknownCases)) {
      const fsStub = { ...nodeFs, ...make(log) };
      const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, ...fastRetry() });
      assert.equal(res.note, undefined);
      assert.deepEqual(res.salt, NEW);
      assert.deepEqual(read(cfg), NEW);
      assert.deepEqual(read(log), OLD, "old file untouched");
      assert.deepEqual(listing(log), [FILE]);
    }
  })
);

test(
  "the old folder is gone (ENOENT): a normal new salt, no note",
  scratch(({ root, cfg, log }) => {
    nodeFs.rmSync(log, { recursive: true });
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(res.note, undefined);
    assert.equal(res.salt.length, 16);
    assert.deepEqual(read(cfg), res.salt);
    // an old folder with no salt file in it is the same
    nodeFs.mkdirSync(log);
    const cfg2 = nodePath.join(root, "config2");
    const res2 = S.loadOrCreateSalt({ dir: cfg2, oldDir: log });
    assert.equal(res2.note, undefined);
    assert.deepEqual(read(cfg2), res2.salt);
  })
);

test(
  "a sharing error on the read-back after publishing is waited out, and the migration completes",
  scratch(({ cfg, log }) => {
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    const newFile = nodePath.join(cfg, FILE);
    let published = false;
    let reads = 0;
    const fsStub = {
      ...nodeFs,
      linkSync: (...a) => {
        nodeFs.linkSync(...a);
        published = true;
      },
      readFileSync: (p, ...a) => {
        // read 1 after publishing is the core's own; read 2 is the migration's read-back
        if (published && String(p) === newFile && ++reads === 2) throw err("EBUSY");
        return nodeFs.readFileSync(p, ...a);
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, ...fastRetry() });
    assert.equal(reads >= 2, true, "the read-back ran");
    assert.equal(res.note, undefined);
    assert.deepEqual(res.salt, OLD);
    assert.deepEqual(listing(log), []);
  })
);

/** inode 0 everywhere, so only the real-path rule can say "same"; the old folder maps to `target`. */
function aliasFs(log, target) {
  return {
    ...nodeFs,
    statSync: (p, o, ...a) => (o && o.bigint ? { ino: 0n, dev: 0n } : nodeFs.statSync(p, o, ...a)),
    realpathSync: (p) => (String(p).startsWith(log) ? target : String(p))
  };
}

test(
  "an inode of 0 falls back to the real path: the same folder is never migrated or deleted",
  scratch(({ cfg, log }) => {
    const NEW = Buffer.alloc(16, 8);
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), NEW);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    // pretend `log` is another name for `cfg`
    const fsStub = aliasFs(log, cfg);
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub });
    assert.deepEqual(res.salt, NEW);
    assert.equal(res.note, undefined);
    assert.deepEqual(read(log), OLD, "not deleted: the real path says it is the same folder");
  })
);

test(
  "the real-path compare folds case on win32 only",
  scratch(({ cfg, log }) => {
    const NEW = Buffer.alloc(16, 8);
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), NEW);
    const upper = cfg.toUpperCase();
    const mk = () => aliasFs(log, upper);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    // win32: cfg and its upper-case spelling are the same folder
    const w = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: mk(), platform: "win32" });
    assert.deepEqual(w.salt, NEW);
    assert.deepEqual(read(log), OLD, "same folder on win32: nothing deleted");
    // elsewhere they are two folders, so the unused old copy is deleted
    const l = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: mk(), platform: "linux" });
    assert.deepEqual(l.salt, NEW);
    assert.deepEqual(listing(log), [], "a different folder on linux: old copy removed");
  })
);

test(
  "an unreadable old salt: a per-process salt, nothing published, old file untouched, next start migrates",
  scratch(({ cfg, log }) => {
    const oldFile = nodePath.join(log, FILE);
    nodeFs.writeFileSync(oldFile, OLD);
    const ids = hmac6(OLD, "/proj/a");
    for (const code of ["EBUSY", "EIO"]) {
      let n = 0;
      const fsStub = {
        ...nodeFs,
        readFileSync: (p, ...a) => {
          if (String(p) === oldFile) {
            // one sharing error, then the same error for good
            n++;
            throw Object.assign(new Error("x"), { code: n === 1 ? "EBUSY" : code });
          }
          return nodeFs.readFileSync(p, ...a);
        }
      };
      let clock = 0;
      const res = S.loadOrCreateSalt({
        dir: cfg,
        oldDir: log,
        fs: fsStub,
        mono: () => (clock += 10),
        sleep: () => {},
        lockWaitMs: 50
      });
      assert.deepEqual(res.note, LABELS_UNSTABLE, code);
      assert.equal(res.salt.length, 16);
      assert.notEqual(hmac6(res.salt, "/proj/a"), ids, "ids differ for this run");
      assert.deepEqual(read(log), OLD, "old file bytes unchanged");
      assert.deepEqual(listing(log), [FILE]);
      assert.ok(!nodeFs.existsSync(nodePath.join(cfg, FILE)), "nothing published");
      assert.deepEqual(listing(cfg), []);
      pathFree(res.note, cfg, log);
    }
    // the next normal start gets the original salt, migrates it and deletes the old file
    const next = S.loadOrCreateSalt({ dir: cfg, oldDir: log });
    assert.equal(next.note, undefined);
    assert.deepEqual(next.salt, OLD);
    assert.equal(hmac6(next.salt, "/proj/a"), ids, "same ids as before");
    assert.deepEqual(read(cfg), OLD);
    assert.deepEqual(listing(log), []);
  })
);

test(
  "a sharing error on the old salt that clears within the wait is retried and migrates",
  scratch(({ cfg, log }) => {
    const oldFile = nodePath.join(log, FILE);
    nodeFs.writeFileSync(oldFile, OLD);
    let n = 0;
    const fsStub = {
      ...nodeFs,
      readFileSync: (p, ...a) => {
        if (String(p) === oldFile && n++ < 2) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return nodeFs.readFileSync(p, ...a);
      }
    };
    let clock = 0;
    const res = S.loadOrCreateSalt({
      dir: cfg,
      oldDir: log,
      fs: fsStub,
      mono: () => (clock += 1),
      sleep: () => {},
      lockWaitMs: 1000
    });
    assert.equal(res.note, undefined);
    assert.deepEqual(res.salt, OLD);
    assert.deepEqual(listing(log), []);
  })
);

test(
  "a new salt file hit by a sharing error is read again, and never overwritten",
  scratch(({ cfg, log }) => {
    nodeFs.mkdirSync(cfg);
    const NEW = Buffer.alloc(16, 8);
    const newFile = nodePath.join(cfg, FILE);
    nodeFs.writeFileSync(newFile, NEW);
    nodeFs.writeFileSync(nodePath.join(log, FILE), OLD);
    let n = 0;
    const fsStub = {
      ...nodeFs,
      readFileSync: (p, ...a) => {
        if (String(p) === newFile && n++ === 0) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return nodeFs.readFileSync(p, ...a);
      }
    };
    let clock = 0;
    const res = S.loadOrCreateSalt({
      dir: cfg,
      oldDir: log,
      fs: fsStub,
      mono: () => (clock += 1),
      sleep: () => {},
      lockWaitMs: 1000
    });
    assert.deepEqual(res.salt, NEW);
    assert.deepEqual(read(cfg), NEW);
  })
);

test(
  "the temp salt file is opened with mode 0600 (recording fs, every platform)",
  scratch(({ cfg }) => {
    const opens = [];
    const fsStub = {
      ...nodeFs,
      openSync: (p, flags, mode) => {
        opens.push([nodePath.basename(String(p)), flags, mode]);
        return nodeFs.openSync(p, flags, mode);
      }
    };
    const res = S.loadOrCreateSalt({ dir: cfg, fs: fsStub });
    assert.equal(res.note, undefined);
    const tmps = opens.filter((o) => o[0].startsWith(FILE + ".tmp-"));
    assert.equal(tmps.length, 1, JSON.stringify(opens));
    assert.equal(tmps[0][1], "wx");
    assert.equal(tmps[0][2], 0o600);
  })
);

test(
  "the temp salt file is created 0600 on disk (POSIX only, skipped on Windows)",
  scratch(({ cfg }, t) => {
    if (process.platform === "win32") {
      t.skip("POSIX modes do not apply on Windows");
      return;
    }
    // the final file is chmod-ed afterwards, so look at the temp file the moment it exists
    const seen = [];
    const fsStub = {
      ...nodeFs,
      openSync: (p, ...a) => {
        const fd = nodeFs.openSync(p, ...a);
        if (String(p).includes(FILE + ".tmp-")) seen.push(nodeFs.fstatSync(fd).mode & 0o777);
        return fd;
      }
    };
    S.loadOrCreateSalt({ dir: cfg, fs: fsStub });
    assert.deepEqual(seen, [0o600]);
  })
);

test(
  "group and other bits are tightened on any platform (recording fs, 0750 folder, 0640 file)",
  scratch(({ cfg, log }) => {
    nodeFs.mkdirSync(cfg);
    nodeFs.writeFileSync(nodePath.join(cfg, FILE), Buffer.alloc(16, 8));
    const chmods = [];
    const fsStub = {
      ...nodeFs,
      statSync: (p, ...a) => {
        const st = nodeFs.statSync(p, ...a);
        if (a.length && a[0] && a[0].bigint) return st;
        return { ...st, mode: nodePath.basename(String(p)) === FILE ? 0o100640 : 0o040750 };
      },
      chmodSync: (p, mode) => chmods.push([nodePath.basename(String(p)), mode])
    };
    const res = S.loadOrCreateSalt({ dir: cfg, oldDir: log, fs: fsStub, posix: true });
    assert.deepEqual(res.salt, Buffer.alloc(16, 8));
    assert.ok(
      chmods.some((c) => c[0] === "config" && c[1] === 0o700),
      JSON.stringify(chmods)
    );
    assert.ok(
      chmods.some((c) => c[0] === FILE && c[1] === 0o600),
      JSON.stringify(chmods)
    );
  })
);
