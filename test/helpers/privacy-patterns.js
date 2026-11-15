/**
 * Shared path/secret patterns used by the fixture privacy gate and by tests that must prove
 * a public value carries no path, username, email or token. Pure, no fs.
 */
"use strict";

const GENERIC = [
  "[A-Za-z]:[\\\\/]+Users", // any drive: C:\Users, C:\\Users, D:/Users
  "[A-Za-z]--Users-", // Claude Code's own Windows project-folder naming
  "/mnt/[a-z]/", // WSL view of a drive
  "-mnt-[a-z]-",
  "(^|[^\\w])/Users(?!\\w)", // macOS home, with or without a trailing slash
  "(^|[^\\w])/(cygdrive/[A-Za-z]|[A-Za-z])/Users(?!\\w)", // Git Bash /c/Users, Cygwin /cygdrive/c/Users
  "(^|[^\\w:])\\\\{1,2}Users\\\\", // drive-less \Users\x, also JSON-escaped \\Users\\x
  "-Users-",
  "/home/(?!user(?![\\w.-]))", // only the neutral /home/user (not user-bob, user.bob)
  "-home-(?!user-demo\\b)", // only the neutral -home-user-demo project folder
  "\\\\wsl", // \\wsl$ and \\wsl.localhost: one backslash then wsl, so linear (was \\+wsl)
  "[\\\\/]{2}wsl(\\$|\\.localhost)", // //wsl$/Ubuntu and //wsl.localhost/Ubuntu, any slash mix
  "(^|[^\\w:\\\\])(\\\\{2}|\\\\{4})[\\w.-]{2,}\\\\{1,2}[\\w$][\\w$.-]", // UNC \\server\share, \\localhost\C$ (raw or escaped)
  "(^|[^\\w])/root(?!\\w)", // root's home, with or without a trailing slash
  "(^|[^\\w])/Volumes/", // macOS mounted volumes
  "/private/var/folders(?!\\w)", // macOS per-user temp
  "(^|[^\\w])/var/folders(?!\\w)", // macOS per-user temp without the /private prefix
  "[A-Za-z]:[\\\\/]+Documents and Settings", // old Windows profile folder
  "%(2F|5C)(Users|home)%(2F|5C)", // URL-encoded home paths
  "[A-Za-z]%3A(%5C|%2F)+Users", // URL-encoded drive paths such as C%3A%5CUsers
  // The email pattern below also flags git@github.com and pkg@1.2.3, harmless on sanitized fixtures.
  "(?<![\\w.+-])[\\w.+-]+(?:@|%40)[\\w-]+\\.[\\w.-]+", // email addresses, @ or %40 (linear: the lookbehind stops rescans)
  "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", // GitHub tokens
  "(^|[^\\w])~([A-Za-z_][\\w.-]*)?[/\\\\]" // tilde home paths: ~/x, ~bob/x and ~\x
];

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildForbidden = (words) => new RegExp([...words.map(escapeRe), ...GENERIC].join("|"), "i");

module.exports = { GENERIC, escapeRe, buildForbidden };
