# Verifying a release download

Release assets are built by `.github/workflows/release.yml` when a `v*` tag is pushed. Every uploaded
asset is listed in `SHA256SUMS.txt` with its SHA-256 hash, so you can confirm the bytes you downloaded
are the bytes the pipeline produced.

## 1. Get the manifest

Open the release page for the tag, download the artifact(s) you want **and** `SHA256SUMS.txt`
into one folder. The file is plain text, one line per asset:

```
<64-hex-lowercase>  <filename>
```

`SHA256SUMS-<platform>.txt` files are also published if you only care about one platform.

Artifact filenames contain no spaces. That is deliberate: GitHub replaces spaces in an uploaded
asset's name with dots, so a manifest entry containing a space would no longer match the file you
downloaded and `sha256sum -c` would report it missing. If a filename in the manifest ever contains a
space, GitHub has rewritten the asset name and you should compare the hashes by hand.

## 2. Compare the hash

### Windows (PowerShell)

```powershell
# in the folder holding the downloads, with SHA256SUMS.txt in the same folder
$expected = (Select-String -Path .\SHA256SUMS.txt -Pattern "AgentWorkshop\.exe$").Line.Split(" ")[0]
(Get-FileHash -Algorithm SHA256 .\AgentWorkshop.exe).Hash.ToLower() -eq $expected
```

`True` means the file matches the manifest. To check a single file without the manifest:

```powershell
Get-FileHash -Algorithm SHA256 .\AgentWorkshop.exe
```

### macOS

```sh
# in the folder holding the downloads and SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt

# or a single file
shasum -a 256 Cursor-Agents-Model-Routing-*.dmg
```

`-c` prints `OK` per file and `FAILED` for any mismatch (missing files are reported too — download all
assets if you want a clean run).

### Linux

```sh
# in the folder holding the downloads and SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt

# or a single file (the filename carries the version)
sha256sum Cursor-Agents-Model-Routing-*.AppImage
```

Both tools exit non-zero on any mismatch. Compare the printed hash to the line in `SHA256SUMS.txt`
yourself when checking a single file.

## 3. About the "unidentified developer" warning

The builds are **not code signed**. There is no Apple Developer ID and no Windows Authenticode
certificate, so on first launch macOS Gatekeeper will refuse to open the `.app`/`.dmg` and Windows
SmartScreen will show "Windows protected your PC". Workarounds: macOS — right-click the app, choose
Open, then confirm; Windows — "More info" → "Run anyway". Linux AppImage: `chmod +x` then run.

That warning is expected, and it is also the reason the checksum matters. Without a signature there is
no vendor identity the OS can verify, so the SHA-256 manifest is the only end-to-end integrity control
available today: it proves the artifact you downloaded is bit-for-bit the one this pipeline built and
uploaded, and it is fetched from the same TLS-protected release page. It detects corruption and
tampering in transit or on a mirror; it does not make the binary trusted the way a signature would.
Until signing is affordable, verify the hash before you run the installer.
