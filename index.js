'use strict';


const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const yauzl = require('yauzl');

const cfg = require('./config');

/* ------------------------------------------------------------------ */
/* Paths & constants                                                   */
/* ------------------------------------------------------------------ */

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const IMAGE_DIR = path.join(ROOT, 'image');
// On Vercel the project folder is read-only; only /tmp is writable (and it is temporary).
const DATA_ROOT = cfg.isServerless ? require('os').tmpdir() : ROOT;
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');
const TEMP_DIR = path.join(DATA_ROOT, 'temp');

const MB = 1024 * 1024;
const MAX_FILE_BYTES = cfg.limits.maxFileSizeMB * MB;
const QUOTA_BYTES = cfg.limits.userQuotaMB * MB;
const ID_RE = /^[a-f0-9]{16}$/;

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

class ProviderError extends Error {
  constructor(status, detail) {
    super(`Provider responded with status ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const newId = () => crypto.randomBytes(8).toString('hex');

/* ------------------------------------------------------------------ */
/* File names, types and content sniffing                              */
/* ------------------------------------------------------------------ */

function sanitizeName(raw, fallback = 'file') {
  let n = String(raw ?? '').normalize('NFC');
  // control chars, bidi overrides and characters that are unsafe in file names
  n = n.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]+/g, '_');
  n = n.replace(/^[.\s_]+/, '').replace(/[\s.]+$/, '').trim();
  if (!n) n = fallback;
  if (n.length > 120) {
    const e = path.extname(n);
    n = n.slice(0, 120 - e.length) + e;
  }
  return n;
}

const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

function decodeUploadName(name) {
  // multer/busboy hands over latin1-decoded names; recover UTF-8 when possible.
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  try {
    const d = Buffer.from(name, 'latin1').toString('utf8');
    return d.includes('\ufffd') ? name : d;
  } catch (_) {
    return name;
  }
}

// Allowed upload types: extension -> expected mime, kind and accepted content signatures.
const TYPES = {
  png: { mime: 'image/png', kind: 'image', sniff: ['png'] },
  jpg: { mime: 'image/jpeg', kind: 'image', sniff: ['jpeg'] },
  jpeg: { mime: 'image/jpeg', kind: 'image', sniff: ['jpeg'] },
  webp: { mime: 'image/webp', kind: 'image', sniff: ['webp'] },
  gif: { mime: 'image/gif', kind: 'image', sniff: ['gif'] },
  mp4: { mime: 'video/mp4', kind: 'video', sniff: ['mp4'] },
  mov: { mime: 'video/quicktime', kind: 'video', sniff: ['mp4'] },
  webm: { mime: 'video/webm', kind: 'video', sniff: ['ebml'] },
  mp3: { mime: 'audio/mpeg', kind: 'audio', sniff: ['mp3'] },
  wav: { mime: 'audio/wav', kind: 'audio', sniff: ['wav'] },
  m4a: { mime: 'audio/mp4', kind: 'audio', sniff: ['mp4'] },
  ogg: { mime: 'audio/ogg', kind: 'audio', sniff: ['ogg'] },
  pdf: { mime: 'application/pdf', kind: 'document', sniff: ['pdf'] },
  txt: { mime: 'text/plain', kind: 'text', sniff: ['text'] },
  md: { mime: 'text/plain', kind: 'text', sniff: ['text'] },
  csv: { mime: 'text/plain', kind: 'text', sniff: ['text'] },
  json: { mime: 'text/plain', kind: 'text', sniff: ['text'] },
  doc: { mime: 'application/msword', kind: 'document', sniff: ['ole'] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    sniff: ['zip']
  },
  xls: { mime: 'application/vnd.ms-excel', kind: 'document', sniff: ['ole'] },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
    sniff: ['zip']
  },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'document', sniff: ['ole'] },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
    sniff: ['zip']
  },
  zip: { mime: 'application/zip', kind: 'archive', sniff: ['zip'] }
};

// Extensions treated as readable text (for AI context) - includes source code found inside ZIPs.
const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php',
  'rb', 'swift', 'kt', 'sql', 'sh', 'bat', 'vue', 'svelte', 'tex', 'srt'
]);

// Never stored when found inside a ZIP (still never executed anywhere).
const BLOCKED_EXTS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'ps1', 'vbs', 'vbe', 'wsf', 'apk', 'app', 'dmg',
  'so', 'dylib', 'jar', 'lnk', 'pif', 'cpl', 'msc', 'reg', 'hta'
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function looksLikeText(buf) {
  if (!buf.length || buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
    return true;
  } catch (_) {
    return false;
  }
}

function sniffKinds(b) {
  const k = [];
  const ascii = (s, o = 0) => b.length >= o + s.length && b.toString('latin1', o, o + s.length) === s;
  if (b.length >= 8 && b[0] === 0x89 && ascii('PNG', 1)) k.push('png');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) k.push('jpeg');
  if (ascii('GIF87a') || ascii('GIF89a')) k.push('gif');
  if (ascii('RIFF') && ascii('WEBP', 8)) k.push('webp');
  if (ascii('RIFF') && ascii('WAVE', 8)) k.push('wav');
  if (ascii('OggS')) k.push('ogg');
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) k.push('ebml');
  if (ascii('ftyp', 4) || ['moov', 'mdat', 'free', 'wide', 'skip'].some((s) => ascii(s, 4))) k.push('mp4');
  if (ascii('ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) k.push('mp3');
  if (b.toString('latin1', 0, Math.min(b.length, 1024)).includes('%PDF-')) k.push('pdf');
  if (ascii('PK\x03\x04') || ascii('PK\x05\x06')) k.push('zip');
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) k.push('ole');
  if (looksLikeText(b)) k.push('text');
  return k;
}

async function readHead(file, bytes = 8192) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const safeUnlink = (file) => fsp.unlink(file).catch(() => {});

async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
  await fsp.chmod(dst, 0o600).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Per-owner library storage (real server-side storage)                */
/* ------------------------------------------------------------------ */

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

const ownerDir = (key) => path.join(UPLOAD_DIR, key);
const filesDir = (key) => path.join(ownerDir(key), 'files');

async function loadIndex(key) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(ownerDir(key), 'index.json'), 'utf8'));
    return Array.isArray(j.files) ? j : { files: [] };
  } catch (_) {
    return { files: [] };
  }
}

async function saveIndex(key, idx) {
  const dir = ownerDir(key);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `index.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(idx), { mode: 0o600 });
  await fsp.rename(tmp, path.join(dir, 'index.json'));
}

function storedPath(key, item) {
  const base = filesDir(key);
  const abs = path.join(base, item.storedName);
  if (!abs.startsWith(base + path.sep)) throw new AppError(400, 'invalid_path', 'Invalid file.');
  return abs;
}

const usedBytes = (idx) => idx.files.reduce((n, f) => n + (f.size || 0), 0);

function publicItem(item, idx) {
  const out = {
    id: item.id,
    name: item.name,
    size: item.size,
    mime: item.mime,
    kind: item.kind,
    ext: item.ext,
    createdAt: item.createdAt,
    previewable: isPreviewable(item),
    rawUrl: `/api/files/${item.id}/raw`,
    downloadUrl: `/api/files/${item.id}/download`
  };
  if (item.zipOf) {
    out.zipOf = item.zipOf;
    out.zipPath = item.zipPath;
  }
  if (item.ext === 'zip' && !item.zipOf && idx) {
    out.childCount = idx.files.filter((f) => f.zipOf === item.id).length;
  }
  return out;
}

function isPreviewable(item) {
  if (!TYPES[item.ext]) return false;
  return ['image', 'video', 'audio', 'text'].includes(item.kind) || item.ext === 'pdf';
}

/* ------------------------------------------------------------------ */
/* ZIP handling (safe extraction + Office text extraction)             */
/* ------------------------------------------------------------------ */

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true },
      (err, zip) => (err ? reject(err) : resolve(zip))
    );
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/**
 * Copies a readable stream to a new file while enforcing size limits.
 * `check(length)` returns an Error to abort. Settles reliably on every failure path.
 */
function writeStreamLimited(src, abs, check) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(abs, { flags: 'wx', mode: 0o600 });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      src.unpipe();
      try {
        src.destroy();
      } catch (_) {
        /* already closed */
      }
      ws.destroy();
      reject(err);
    };
    src.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    src.on('data', (chunk) => {
      const err = check(chunk.length);
      if (err) fail(err);
    });
    src.pipe(ws);
  });
}

/** Returns a reason string if the entry must be skipped, otherwise ''. */
function unsafeEntryReason(name, entry) {
  if (name.includes('\0')) return 'invalid name';
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return 'absolute path';
  if (name.split('/').some((seg) => seg === '..')) return 'path traversal';
  if (typeof entry.isEncrypted === 'function' && entry.isEncrypted()) return 'encrypted';
  if (entry.versionMadeBy >>> 8 === 3) {
    const mode = entry.externalFileAttributes >>> 16;
    if ((mode & 0xf000) === 0xa000) return 'symbolic link';
  }
  if (BLOCKED_EXTS.has(extOf(name))) return 'blocked file type';
  return '';
}

function logicalZipPath(name) {
  const segs = name.split('/').filter(Boolean).map((s) => sanitizeName(s, '_'));
  return segs.join('/').slice(0, 200);
}

/**
 * Extracts a ZIP into the owner's file store. Files are written under random ids,
 * never under the paths found in the archive, so path traversal on disk is impossible.
 * Entries with unsafe paths are skipped and reported.
 */
async function extractZip({ key, zipPath, zipId, maxTotal, totalLimitError }) {
  const zip = await openZip(zipPath).catch(() => {
    throw new AppError(400, 'bad_zip', 'The ZIP file is invalid or corrupted.');
  });
  const out = { files: [], skipped: [] };
  const written = [];
  let entries = 0;
  let total = 0;
  const dest = filesDir(key);

  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const raw = entry.fileName.replace(/\\/g, '/');
          if (raw.endsWith('/')) return zip.readEntry();
          if (raw.startsWith('__MACOSX/') || raw.endsWith('.DS_Store')) return zip.readEntry();

          entries += 1;
          if (entries > cfg.limits.zipMaxEntries) {
            throw new AppError(413, 'zip_too_many', 'The ZIP contains too many files.');
          }

          const reason = unsafeEntryReason(raw, entry);
          if (reason) {
            out.skipped.push({ path: logicalZipPath(raw) || '(unnamed)', reason });
            return zip.readEntry();
          }
          if (entry.uncompressedSize > MAX_FILE_BYTES) {
            out.skipped.push({ path: logicalZipPath(raw), reason: 'file too large' });
            return zip.readEntry();
          }

          const logical = logicalZipPath(raw);
          const base = logical.split('/').pop();
          const ext = extOf(base);
          const type = TYPES[ext];
          const id = newId();
          const storedName = `${id}.${type ? ext : 'bin'}`;
          const abs = path.join(dest, storedName);

          const stream = await openEntryStream(zip, entry);
          let bytes = 0;
          written.push(abs);
          await writeStreamLimited(stream, abs, (len) => {
            bytes += len;
            total += len;
            return bytes > MAX_FILE_BYTES || total > maxTotal ? totalLimitError() : null;
          });

          if (type) {
            const head = await readHead(abs, 8192);
            if (!type.sniff.some((s) => sniffKinds(head).includes(s))) {
              await safeUnlink(abs);
              total -= bytes;
              out.skipped.push({ path: logical, reason: 'content does not match file type' });
              return zip.readEntry();
            }
          }

          out.files.push({
            id,
            name: sanitizeName(base),
            storedName,
            size: bytes,
            mime: type ? type.mime : 'application/octet-stream',
            kind: type ? type.kind : TEXT_EXTS.has(ext) ? 'text' : 'file',
            ext,
            createdAt: Date.now(),
            zipOf: zipId,
            zipPath: logical
          });
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } catch (err) {
    await Promise.all(written.map(safeUnlink));
    if (err instanceof AppError) throw err;
    // yauzl itself refuses archives that contain "../" or absolute paths
    if (/relative path|absolute path/i.test(String(err && err.message))) {
      throw new AppError(400, 'unsafe_zip', 'The ZIP contains unsafe file paths and was rejected.');
    }
    throw new AppError(400, 'bad_zip', 'The ZIP file is invalid or corrupted.');
  } finally {
    zip.close();
  }
  return out;
}

/** Reads selected entries of a ZIP (docx/pptx) into memory with a per-entry size cap. */
async function readZipEntries(file, wanted, maxBytes = 5 * MB) {
  const zip = await openZip(file);
  const results = [];
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          if (!wanted(entry.fileName) || entry.uncompressedSize > maxBytes) return zip.readEntry();
          const stream = await openEntryStream(zip, entry);
          // event-based read: async iteration can stall on "stored" (uncompressed) entries
          const buffer = await new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            stream.on('data', (c) => {
              size += c.length;
              if (size > maxBytes) {
                stream.destroy();
                return reject(new AppError(413, 'entry_too_large', 'The document is too large to read.'));
              }
              chunks.push(c);
            });
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          });
          results.push({ name: entry.fileName, text: buffer.toString('utf8') });
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return results;
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractOfficeText(file, ext) {
  if (ext === 'docx') {
    const [doc] = await readZipEntries(file, (n) => n === 'word/document.xml');
    if (!doc) return '';
    return decodeEntities(
      doc.text
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
    ).trim();
  }
  if (ext === 'pptx') {
    const slides = await readZipEntries(file, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    slides.sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
    return slides
      .map((s, i) => `--- Slide ${i + 1} ---\n` + decodeEntities(s.text.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')).trim())
      .join('\n\n');
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Upload processing                                                   */
/* ------------------------------------------------------------------ */

async function processUploads(owner, files) {
  return withLock(owner.key, async () => {
    await fsp.mkdir(filesDir(owner.key), { recursive: true });
    const idx = await loadIndex(owner.key);
    let used = usedBytes(idx);
    const results = [];
    const errors = [];

    for (const f of files) {
      const display = sanitizeName(decodeUploadName(f.originalname), 'file');
      const ext = extOf(display);
      const type = TYPES[ext];
      let zipId = null;
      let zipChildren = [];
      try {
        if (!type) throw new AppError(415, 'unsupported_type', 'This file type is not supported.');
        if (!f.size) throw new AppError(400, 'empty_file', 'The file is empty.');
        if (f.size > MAX_FILE_BYTES) throw new AppError(413, 'file_too_large', 'File size exceeds the allowed limit.');
        const head = await readHead(f.path, 8192);
        const kinds = sniffKinds(head);
        if (!type.sniff.some((s) => kinds.includes(s))) {
          throw new AppError(415, 'type_mismatch', 'The file content does not match its type.');
        }
        if (used + f.size > QUOTA_BYTES) {
          throw new AppError(413, 'quota_exceeded', 'Storage limit reached. Delete some files and try again.');
        }

        const id = newId();
        const storedName = `${id}.${ext}`;
        const abs = path.join(filesDir(owner.key), storedName);
        await moveFile(f.path, abs);
        const item = {
          id,
          name: display,
          storedName,
          size: f.size,
          mime: type.mime,
          kind: type.kind,
          ext,
          createdAt: Date.now()
        };

        let extra = null;
        if (ext === 'zip') {
          zipId = id;
          const room = QUOTA_BYTES - used - f.size;
          const zipLimit = cfg.limits.zipMaxTotalMB * MB;
          const maxTotal = Math.min(zipLimit, room);
          try {
            const res = await extractZip({
              key: owner.key,
              zipPath: abs,
              zipId: id,
              maxTotal,
              totalLimitError: () =>
                room < zipLimit
                  ? new AppError(413, 'quota_exceeded', 'Storage limit reached. Delete some files and try again.')
                  : new AppError(413, 'zip_too_large', 'The ZIP is too large when extracted.')
            });
            zipChildren = res.files;
            extra = { skipped: res.skipped };
          } catch (err) {
            await safeUnlink(abs);
            throw err;
          }
        }

        idx.files.push(item, ...zipChildren);
        used += f.size + zipChildren.reduce((n, c) => n + c.size, 0);

        const pub = publicItem(item, { files: [item, ...zipChildren] });
        if (extra) {
          pub.extracted = zipChildren.map((c) => publicItem(c));
          pub.skipped = extra.skipped;
        }
        results.push(pub);
      } catch (err) {
        errors.push({
          name: display,
          message: err.expose ? err.message : 'Upload failed. Please try again.'
        });
        if (!err.expose) console.error('[upload] unexpected error:', err.message);
        if (zipId) await Promise.all(zipChildren.map((c) => safeUnlink(storedPath(owner.key, c))));
      } finally {
        await safeUnlink(f.path);
      }
    }

    await saveIndex(owner.key, idx);
    return { files: results, errors };
  });
}

async function cleanupExpired() {
  const maxAge = cfg.limits.fileRetentionDays * 24 * 3600 * 1000;
  const now = Date.now();
  try {
    const owners = await fsp.readdir(UPLOAD_DIR);
    for (const key of owners) {
      if (!/^[a-f0-9]{40}$/.test(key)) continue;
      await withLock(key, async () => {
        const idx = await loadIndex(key);
        const keep = [];
        let changed = false;
        for (const item of idx.files) {
          if (now - item.createdAt > maxAge) {
            await safeUnlink(storedPath(key, item));
            changed = true;
          } else keep.push(item);
        }
        if (changed) await saveIndex(key, { files: keep });
      });
    }
  } catch (_) {
    /* uploads dir not created yet */
  }
  try {
    for (const f of await fsp.readdir(TEMP_DIR)) {
      const p = path.join(TEMP_DIR, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > 3600 * 1000) await safeUnlink(p);
    }
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* AI: attachments -> provider-neutral messages                        */
/* ------------------------------------------------------------------ */

async function addAttachment(key, idx, item, entry, state) {
  const abs = storedPath(key, item);
  const label = item.name;

  const addText = (txt, title = label) => {
    if (!txt || !txt.trim()) {
      state.notices.add(`"${label}" has no readable text.`);
      return;
    }
    if (state.chars <= 0) {
      state.notices.add(`"${label}" was skipped because the attachments are too large.`);
      return;
    }
    let t = txt;
    if (t.length > state.chars) {
      t = t.slice(0, state.chars);
      state.notices.add(`"${label}" was truncated because it is very large.`);
    }
    state.chars -= t.length;
    entry.text += `\n\n[Attached file: ${title}]\n\`\`\`\n${t}\n\`\`\``;
  };

  const addBinary = async (type, maxBytes) => {
    if (item.size > maxBytes || state.bytes < item.size) {
      state.notices.add(`"${label}" is too large to be analyzed.`);
      return;
    }
    const data = (await fsp.readFile(abs)).toString('base64');
    state.bytes -= item.size;
    entry.media.push({ type, mime: item.mime, data, name: label });
  };

  try {
    if (IMAGE_EXTS.has(item.ext)) return await addBinary('image', 8 * MB);
    if (item.kind === 'text' || TEXT_EXTS.has(item.ext)) {
      return addText((await readHead(abs, 300 * 1024)).toString('utf8'));
    }
    if (item.ext === 'docx' || item.ext === 'pptx') return addText(await extractOfficeText(abs, item.ext));
    if (item.ext === 'pdf' || item.kind === 'audio' || item.kind === 'video') {
      return await addBinary('file', 15 * MB);
    }
    if (item.ext === 'zip') {
      const children = idx.files.filter((f) => f.zipOf === item.id);
      const manifest = children.map((c) => `- ${c.zipPath} (${c.size} bytes)`).join('\n') || '(empty)';
      entry.text += `\n\n[Attached ZIP: ${label}] contains ${children.length} file(s):\n${manifest}`;
      let zipChars = 60000;
      for (const c of children) {
        if (zipChars <= 0) break;
        if ((c.kind === 'text' || TEXT_EXTS.has(c.ext)) && c.size <= 100 * 1024) {
          const t = (await readHead(storedPath(key, c), 100 * 1024)).toString('utf8').slice(0, zipChars);
          zipChars -= t.length;
          addText(t, `${label}/${c.zipPath}`);
        }
      }
      return;
    }
    state.notices.add(`"${label}" can't be analyzed by the AI (unsupported file type).`);
  } catch (err) {
    console.error('[attachment] could not read file:', err.message);
    state.notices.add(`"${label}" could not be read.`);
  }
}

async function prepareConversation(key, messages) {
  const idx = await loadIndex(key);
  const state = { bytes: 18 * MB, chars: 120000, notices: new Set() };
  const out = new Array(messages.length);
  // newest first, so the latest attachments get the budget
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const entry = { role: m.role, text: m.content, media: [] };
    for (const id of m.attachments) {
      const item = idx.files.find((f) => f.id === id);
      if (!item) {
        state.notices.add('An attachment is no longer available.');
        continue;
      }
      await addAttachment(key, idx, item, entry, state);
    }
    out[i] = entry;
  }
  // After a stopped/failed answer two user turns can follow each other; merge them because some
  // providers (e.g. Gemini) require alternating roles.
  const convo = [];
  for (const m of out) {
    const prev = convo[convo.length - 1];
    if (prev && prev.role === m.role) {
      prev.text = [prev.text, m.text].filter(Boolean).join('\n\n');
      prev.media.push(...m.media);
    } else convo.push({ role: m.role, text: m.text, media: [...m.media] });
  }
  return { convo, notices: [...state.notices] };
}

/* ------------------------------------------------------------------ */
/* AI providers (streaming)                                            */
/* ------------------------------------------------------------------ */

const withTimeout = (signal, ms = 120000) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch (_) {
    return '';
  }
}

/** Parses a Server-Sent-Events response body and yields each event's data payload. */
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const dataOf = (block) =>
    block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = dataOf(block);
        if (data) yield data;
      }
    }
    const tail = dataOf(buf);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

const isModelError = (status, detail) =>
  (status === 404 || status === 400) && /model|not found|decommission|deprecat|no longer/i.test(detail || '');

/** Calls makeRequest(model) for each candidate model; moves on when a model has been retired/renamed. */
async function fetchWithModelFallback(models, makeRequest) {
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    const res = await makeRequest(models[i]);
    if (res.ok) return res;
    const detail = await safeText(res);
    lastErr = new ProviderError(res.status, detail);
    if (i < models.length - 1 && isModelError(res.status, detail)) {
      console.error(`[chat] model "${models[i]}" is unavailable (${res.status}), trying "${models[i + 1]}"`);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

function toOpenAIMessage(m, allowImages, notices) {
  if (m.role === 'assistant') return { role: 'assistant', content: m.text || ' ' };
  let text = m.text || '';
  const images = [];
  for (const media of m.media) {
    if (media.type === 'image' && allowImages) images.push(media);
    else {
      text += `\n\n[Attachment "${media.name}" could not be read by the current AI model.]`;
      notices.add(`"${media.name}" can't be analyzed by the current AI model.`);
    }
  }
  if (!images.length) return { role: 'user', content: text || ' ' };
  return {
    role: 'user',
    content: [
      { type: 'text', text: text.trim() || 'Please describe this image.' },
      ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))
    ]
  };
}

function openAICompatible({ label, baseUrl, key, models, allowImages, headers = {} }) {
  return async function* stream({ system, messages, signal }) {
    const notices = new Set();
    const payload = {
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages.map((m) => toOpenAIMessage(m, allowImages(), notices))]
    };
    for (const n of notices) yield { type: 'notice', message: n };

    const res = await fetchWithModelFallback(models(), (model) =>
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: withTimeout(signal),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}`, ...headers },
        body: JSON.stringify({ ...payload, model })
      })
    );

    for await (const data of sseData(res)) {
      if (data === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(data);
      } catch (_) {
        continue;
      }
      const text = json.choices?.[0]?.delta?.content;
      if (text) yield { type: 'delta', text };
    }
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

const isHttpUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch (_) {
    return false;
  }
};

async function* geminiStream({ system, messages, signal, grounded = false }) {
  const notices = new Set();
  const contents = messages.map((m) => {
    if (m.role === 'assistant') return { role: 'model', parts: [{ text: m.text || ' ' }] };
    const parts = [{ text: m.text.trim() || (m.media.length ? 'Please analyze the attached file(s).' : ' ') }];
    for (const media of m.media) parts.push({ inlineData: { mimeType: media.mime, data: media.data } });
    return { role: 'user', parts };
  });
  for (const n of notices) yield { type: 'notice', message: n };

  const body = { systemInstruction: { parts: [{ text: system }] }, contents };
  if (grounded) body.tools = [{ google_search: {} }];

  const res = await fetchWithModelFallback(cfg.models.gemini, (model) =>
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        signal: withTimeout(signal),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiApiKey },
        body: JSON.stringify(body)
      }
    )
  );

  const sources = new Map();
  for await (const data of sseData(res)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      continue;
    }
    if (json.promptFeedback?.blockReason) {
      throw new AppError(400, 'blocked', 'This request was blocked by the AI safety filters.');
    }
    const cand = json.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.text && !part.thought) yield { type: 'delta', text: part.text };
    }
    for (const chunk of cand?.groundingMetadata?.groundingChunks || []) {
      const uri = chunk.web?.uri;
      if (uri && isHttpUrl(uri) && !sources.has(uri)) {
        const title = chunk.web.title || '';
        const host = hostOf(uri);
        const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title) ? title : host.includes('vertexaisearch') ? title : host;
        sources.set(uri, { title: title || domain || uri, url: uri, domain });
      }
    }
  }
  if (grounded) yield { type: 'sources', sources: [...sources.values()] };
}

const PROVIDERS = {
  gemini: { enabled: () => !!cfg.geminiApiKey, stream: geminiStream },
  groq: {
    enabled: () => !!cfg.groqApiKey,
    stream: openAICompatible({
      label: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      key: () => cfg.groqApiKey,
      models: () => cfg.models.groq,
      allowImages: () => /vision|-vl-/i.test(cfg.models.groq.join(' '))
    })
  },
  openai: {
    enabled: () => !!cfg.openaiApiKey,
    stream: openAICompatible({
      label: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      key: () => cfg.openaiApiKey,
      models: () => cfg.models.openai,
      allowImages: () => true
    })
  },
  openRouter: {
    enabled: () => !!cfg.openRouterApiKey,
    stream: openAICompatible({
      label: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      key: () => cfg.openRouterApiKey,
      models: () => cfg.models.openRouter,
      allowImages: () => true,
      headers: { 'X-Title': 'MOSTAKIM AI' }
    })
  }
};

const chatProviderNames = () => cfg.chatProviders.filter((n) => PROVIDERS[n] && PROVIDERS[n].enabled());

/** Tries configured providers in order; falls back to the next one if a provider fails before output starts. */
async function* chatCompletion({ system, messages, signal }) {
  const names = chatProviderNames();
  if (!names.length) throw new AppError(503, 'not_configured', 'AI service is not configured yet.');
  let lastErr;
  for (const name of names) {
    let started = false;
    try {
      for await (const ev of PROVIDERS[name].stream({ system, messages, signal })) {
        if (ev.type === 'delta') started = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      console.error(`[chat] provider "${name}" failed:`, err.status || '', (err.detail || err.message || '').toString().slice(0, 200));
      if (started) throw err;
    }
  }
  throw lastErr;
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const buildSystemPrompt = () => `${cfg.systemPrompt}\nToday's date: ${todayStr()}.`;

/* ------------------------------------------------------------------ */
/* Web search                                                          */
/* ------------------------------------------------------------------ */

function pickSearchMode() {
  const want = cfg.searchProvider;
  const available = {
    tavily: !!cfg.searchApiKey,
    gemini: !!cfg.geminiApiKey,
    openai: !!cfg.openaiApiKey
  };
  if (want !== 'auto') return available[want] ? want : null;
  return ['tavily', 'gemini', 'openai'].find((m) => available[m]) || null;
}

async function tavilySearch(query, signal, includeAnswer) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: withTimeout(signal, 30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.searchApiKey}` },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 6, include_answer: includeAnswer })
  });
  if (!res.ok) throw new ProviderError(res.status, await safeText(res));
  return res.json();
}

async function* searchFlow(query, signal) {
  const mode = pickSearchMode();
  if (!mode) throw new AppError(503, 'search_not_configured', 'Search is not configured yet.');

  const system =
    `You are the web search assistant of MOSTAKIM AI. Give accurate, up-to-date, well-structured answers in Markdown. ` +
    `Reply in the same language as the question. Never invent facts or sources. Today's date: ${todayStr()}.`;

  if (mode === 'gemini') {
    yield* geminiStream({ system, messages: [{ role: 'user', text: query, media: [] }], signal, grounded: true });
    return;
  }

  if (mode === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: withTimeout(signal, 60000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiApiKey}` },
      body: JSON.stringify({
        model: cfg.models.openaiSearch,
        web_search_options: {},
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: query }
        ]
      })
    });
    if (!res.ok) throw new ProviderError(res.status, await safeText(res));
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    const sources = new Map();
    for (const a of msg.annotations || []) {
      const u = a.url_citation?.url;
      if (u && isHttpUrl(u) && !sources.has(u)) {
        sources.set(u, { title: a.url_citation.title || hostOf(u), url: u, domain: hostOf(u) });
      }
    }
    yield { type: 'sources', sources: [...sources.values()] };
    if (msg.content) yield { type: 'delta', text: msg.content };
    return;
  }

  // mode === 'tavily': real search results, then an answer written from those results
  const hasChat = chatProviderNames().length > 0;
  const data = await tavilySearch(query, signal, !hasChat);
  const results = (data.results || []).filter((r) => r && isHttpUrl(r.url)).slice(0, 6);
  const sources = results.map((r) => ({
    title: r.title || hostOf(r.url),
    url: r.url,
    domain: hostOf(r.url),
    snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 220)
  }));
  yield { type: 'sources', sources };
  if (!sources.length) {
    yield { type: 'delta', text: 'No results were found for this search.' };
    return;
  }
  if (!hasChat) {
    if (data.answer) yield { type: 'delta', text: String(data.answer) };
    return;
  }
  const context = results
    .map((r, i) => `[${i + 1}] ${r.title || hostOf(r.url)}\nURL: ${r.url}\n${String(r.content || '').slice(0, 1200)}`)
    .join('\n\n');
  const prompt =
    `Question: ${query}\n\nSearch results:\n${context}\n\n` +
    `Write a clear, accurate answer using only these search results. Cite sources inline like [1], [2]. ` +
    `If the results do not contain the answer, say so plainly. Reply in the same language as the question.`;
  yield* chatCompletion({ system, messages: [{ role: 'user', text: prompt, media: [] }], signal });
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function toAppError(err, kind) {
  if (err instanceof AppError) return err;
  if (err instanceof ProviderError) {
    if (err.status === 429) {
      return new AppError(429, 'busy', 'The AI service is busy right now. Please try again in a moment.');
    }
    if (err.status === 401 || err.status === 403) {
      return kind === 'search'
        ? new AppError(503, 'search_unavailable', 'Search is temporarily unavailable.')
        : new AppError(503, 'ai_auth', 'AI service is not configured correctly.');
    }
  }
  return kind === 'search'
    ? new AppError(502, 'search_unavailable', 'Search is temporarily unavailable.')
    : new AppError(502, 'ai_unavailable', 'The AI service is temporarily unavailable. Please try again.');
}

function startSSE(res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));
  return {
    send(obj) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  };
}

/** Runs an AI generator and answers either as an SSE stream or as one JSON document. */
async function respondAI(req, res, stream, makeIterator, kind) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });

  if (stream) {
    const sse = startSSE(res);
    try {
      for await (const ev of makeIterator(ac.signal)) sse.send(ev);
      sse.send({ type: 'done' });
    } catch (err) {
      if (!ac.signal.aborted) {
        const e = toAppError(err, kind);
        if (!(err instanceof AppError)) console.error(`[${kind}] request failed:`, err.message);
        sse.send({ type: 'error', code: e.code, message: e.message });
      }
    } finally {
      sse.end();
    }
    return;
  }

  let reply = '';
  let sources = [];
  const notices = [];
  try {
    for await (const ev of makeIterator(ac.signal)) {
      if (ev.type === 'delta') reply += ev.text;
      else if (ev.type === 'sources') sources = ev.sources;
      else if (ev.type === 'notice') notices.push(ev.message);
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    if (!(err instanceof AppError)) console.error(`[${kind}] request failed:`, err.message);
    throw toAppError(err, kind);
  }
  const body = { reply };
  if (kind === 'search') body.sources = sources;
  if (notices.length) body.notices = notices;
  res.json(body);
}

function validateChatBody(body) {
  const invalid = () => new AppError(400, 'invalid_request', 'Please enter a message.');
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) throw invalid();

  let total = 0;
  const cleaned = body.messages.slice(-40).map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw invalid();
    if (m.content !== undefined && typeof m.content !== 'string') throw invalid();
    const content = (m.content || '').trim();
    total += content.length;
    let attachments = [];
    if (m.role === 'user' && Array.isArray(m.attachments)) {
      attachments = [...new Set(m.attachments.filter((a) => typeof a === 'string' && ID_RE.test(a)))].slice(0, 10);
    }
    return { role: m.role, content, attachments };
  });
  if (total > 60000) throw new AppError(413, 'too_long', 'Your message is too long.');

  const messages = cleaned.filter((m) => m.content || m.attachments.length);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') throw invalid();
  return { messages, stream: body.stream !== false };
}

/* ------------------------------------------------------------------ */
/* Route handlers                                                      */
/* ------------------------------------------------------------------ */

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** Gives every browser / API client its own private library (cookie or x-client-id header). */
function identify(req, res, next) {
  const headerId = req.get('x-client-id');
  const cookieId = getCookie(req, 'mai_uid');
  let id = null;
  if (headerId && /^[A-Za-z0-9_-]{16,64}$/.test(headerId)) id = headerId;
  else if (cookieId && /^[a-f0-9]{32}$/.test(cookieId)) id = cookieId;

  if (!id) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `mai_uid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
    res.set('x-client-id', id);
  }
  req.owner = { id, key: crypto.createHash('sha256').update(id).digest('hex').slice(0, 40) };
  next();
}

function sameOrigin(req) {
  if (req.get('sec-fetch-site') === 'same-origin') return true;
  const origin = req.get('origin') || req.get('referer') || '';
  const host = req.get('x-forwarded-host') || req.get('host');
  try {
    return !!origin && new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

/** Optional API authentication: set apiAuthKey to require a key from external callers. */
function apiAuth(req, res, next) {
  if (!cfg.apiAuthKey) return next();
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const given = req.get('x-api-key') || bearer;
  if (given) {
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(cfg.apiAuthKey).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  if (sameOrigin(req)) return next();
  next(new AppError(401, 'unauthorized', 'A valid API key is required.'));
}

function statusHandler(_req, res) {
  res.json({
    ok: true,
    chat: chatProviderNames().length > 0,
    search: pickSearchMode() !== null,
    upload: true,
    storage: cfg.isServerless ? 'temporary' : 'persistent',
    authRequired: !!cfg.apiAuthKey,
    limits: { maxFileSizeMB: cfg.limits.maxFileSizeMB, maxFilesPerUpload: cfg.limits.maxFilesPerUpload }
  });
}

async function chatHandler(req, res, next) {
  try {
    const { messages, stream } = validateChatBody(req.body);
    if (!chatProviderNames().length) throw new AppError(503, 'not_configured', 'AI service is not configured yet.');
    const { convo, notices } = await prepareConversation(req.owner.key, messages);
    const system = buildSystemPrompt();
    await respondAI(
      req,
      res,
      stream,
      async function* (signal) {
        for (const n of notices) yield { type: 'notice', message: n };
        yield* chatCompletion({ system, messages: convo, signal });
      },
      'chat'
    );
  } catch (err) {
    next(err);
  }
}

async function searchHandler(req, res, next) {
  try {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 2) throw new AppError(400, 'invalid_request', 'Please enter something to search for.');
    if (query.length > 500) throw new AppError(400, 'invalid_request', 'Your search is too long (max 500 characters).');
    if (!pickSearchMode()) throw new AppError(503, 'search_not_configured', 'Search is not configured yet.');
    await respondAI(req, res, body.stream !== false, (signal) => searchFlow(query, signal), 'search');
  } catch (err) {
    next(err);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 }, (err) => cb(err, TEMP_DIR));
    },
    filename(_req, _file, cb) {
      cb(null, crypto.randomBytes(12).toString('hex'));
    }
  }),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: cfg.limits.maxFilesPerUpload,
    fields: 5,
    parts: cfg.limits.maxFilesPerUpload + 10
  }
}).any();

function receiveUploads(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    (req.files || []).forEach((f) => safeUnlink(f.path));
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(413, 'file_too_large', 'File size exceeds the allowed limit.'));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new AppError(400, 'too_many_files', `You can upload up to ${cfg.limits.maxFilesPerUpload} files at once.`));
    }
    next(new AppError(400, 'upload_failed', 'Upload failed. Please try again.'));
  });
}

async function uploadHandler(req, res, next) {
  const files = (req.files || []).filter((f) => f && f.path);
  try {
    if (!files.length) throw new AppError(400, 'no_file', 'Please choose a file to upload.');
    const { files: ok, errors } = await processUploads(req.owner, files);
    if (!ok.length) {
      const message = errors[0]?.message || 'Upload failed. Please try again.';
      return res.status(/limit|too large/i.test(message) ? 413 : 400).json({
        error: { code: 'upload_failed', message },
        files: [],
        errors
      });
    }
    res.status(201).json({ files: ok, errors });
  } catch (err) {
    await Promise.all(files.map((f) => safeUnlink(f.path)));
    next(err);
  }
}

async function findOwned(req) {
  const id = req.params.id;
  if (!ID_RE.test(id)) throw new AppError(404, 'not_found', 'File not found.');
  const idx = await loadIndex(req.owner.key);
  const item = idx.files.find((f) => f.id === id);
  if (!item) throw new AppError(404, 'not_found', 'File not found.');
  return { idx, item };
}

async function listFilesHandler(req, res, next) {
  try {
    const idx = await loadIndex(req.owner.key);
    const files = idx.files
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((f) => publicItem(f, idx));
    res.json({ files, usedBytes: usedBytes(idx), quotaBytes: QUOTA_BYTES });
  } catch (err) {
    next(err);
  }
}

async function getFileHandler(req, res, next) {
  try {
    const { idx, item } = await findOwned(req);
    res.json({ file: publicItem(item, idx) });
  } catch (err) {
    next(err);
  }
}

async function rawHandler(req, res, next) {
  try {
    const { item } = await findOwned(req);
    if (!isPreviewable(item)) throw new AppError(415, 'not_previewable', 'Preview is not available for this file.');
    res.setHeader('Content-Type', item.mime + (item.kind === 'text' ? '; charset=utf-8' : ''));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (item.ext !== 'pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(item.storedName, { root: filesDir(req.owner.key), dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(new AppError(404, 'not_found', 'File not found.'));
    });
  } catch (err) {
    next(err);
  }
}

async function downloadHandler(req, res, next) {
  try {
    const { item } = await findOwned(req);
    res.setHeader('Content-Type', item.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(storedPath(req.owner.key, item), item.name, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(new AppError(404, 'not_found', 'File not found.'));
    });
  } catch (err) {
    next(err);
  }
}

async function renameHandler(req, res, next) {
  try {
    const wanted = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!wanted.trim()) throw new AppError(400, 'invalid_request', 'Please enter a file name.');
    const result = await withLock(req.owner.key, async () => {
      const { idx, item } = await findOwned(req);
      // keep the original extension so the file type can never be changed by renaming
      const stem = sanitizeName(wanted, 'file').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'file';
      item.name = sanitizeName(item.ext && item.ext !== 'bin' ? `${stem}.${item.ext}` : stem);
      await saveIndex(req.owner.key, idx);
      return publicItem(item, idx);
    });
    res.json({ file: result });
  } catch (err) {
    next(err);
  }
}

async function deleteHandler(req, res, next) {
  try {
    const removed = await withLock(req.owner.key, async () => {
      const { idx, item } = await findOwned(req);
      const doomed = idx.files.filter((f) => f.id === item.id || f.zipOf === item.id);
      for (const f of doomed) await safeUnlink(storedPath(req.owner.key, f));
      idx.files = idx.files.filter((f) => !doomed.includes(f));
      await saveIndex(req.owner.key, idx);
      return doomed.length;
    });
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* App wiring                                                          */
/* ------------------------------------------------------------------ */

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  // security headers (CSP uses a per-request nonce for the inline app script)
  app.use((_req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"]
        }
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' }
    })
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
    next();
  });

  // defense in depth: private files are never served, even if a static root changes
  app.use((req, res, next) => {
    if (/(^|\/)(\.|config\.json|config\.js|package(-lock)?\.json|index\.js|node_modules|uploads|temp|logs)(\/|$)/i.test(req.path)) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    }
    next();
  });

  if (cfg.corsOrigins.length) {
    const any = cfg.corsOrigins.includes('*');
    app.use(
      '/api',
      cors({
        origin: any ? true : (origin, cb) => cb(null, !origin || cfg.corsOrigins.includes(origin)),
        credentials: !any,
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-client-id'],
        exposedHeaders: ['x-client-id'],
        maxAge: 600
      })
    );
  }

  // frontend
  // The page is read lazily (and cached in production) so a missing file can never crash start-up.
  let cachedIndex = null;
  const readIndex = () => fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  app.get(['/', '/index.html'], (_req, res) => {
    let html;
    try {
      html = cachedIndex || readIndex();
      if (cfg.isProduction) cachedIndex = html;
    } catch (err) {
      console.error('[server] could not read src/index.html:', err.message);
      return res.status(500).type('text/plain').send('The page could not be loaded.');
    }
    res.type('html').set('Cache-Control', 'no-cache').send(html.replace(/__CSP_NONCE__/g, res.locals.cspNonce));
  });
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/image/mostakim.ai.png'));
  app.use('/image', express.static(IMAGE_DIR, { dotfiles: 'ignore', index: false, maxAge: '7d' }));
  app.use(express.static(SRC_DIR, { dotfiles: 'ignore', index: false, maxAge: cfg.isProduction ? '1h' : 0 }));

  // API
  const limiter = (max) =>
    rateLimit({
      windowMs: cfg.rateLimit.windowMs,
      limit: max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' } })
    });
  const aiLimiter = limiter(cfg.rateLimit.ai);
  const uploadLimiter = limiter(cfg.rateLimit.upload);

  const api = express.Router();
  api.use(limiter(cfg.rateLimit.api));
  api.use(express.json({ limit: '256kb' }));
  api.use(identify);
  api.get('/status', statusHandler);
  api.use(apiAuth);
  api.post('/chat', aiLimiter, chatHandler);
  api.post('/search', aiLimiter, searchHandler);
  api.post('/upload', uploadLimiter, receiveUploads, uploadHandler);
  api.get('/files', listFilesHandler);
  api.get('/files/:id', getFileHandler);
  api.get('/files/:id/raw', rawHandler);
  api.get('/files/:id/download', downloadHandler);
  api.patch('/files/:id', renameHandler);
  api.delete('/files/:id', deleteHandler);
  api.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));
  app.use('/api', api);

  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  // errors: never leak stack traces or internals
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    let status = 500;
    let code = 'server_error';
    let message = 'Something went wrong. Please try again.';
    if (err instanceof AppError) {
      ({ status, code, message } = err);
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      code = 'too_large';
      message = 'The request is too large.';
    } else if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      status = 400;
      code = 'invalid_json';
      message = 'The request body is not valid JSON.';
    } else {
      console.error('[server] unexpected error:', err && err.message);
    }
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

const app = createApp();

function start() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
  cleanupExpired();
  setInterval(cleanupExpired, 6 * 3600 * 1000).unref();

  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason && reason.message);
  });

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`MOSTAKIM AI is running on http://localhost:${cfg.port}`);
    console.log(
      `Chat: ${chatProviderNames().length ? 'ready' : 'not configured'} | Search: ${pickSearchMode() ? 'ready' : 'not configured'}`
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = {
  app,
  start,
  // exported for tests
  _internals: {
    sanitizeName,
    sniffKinds,
    extractZip,
    processUploads,
    prepareConversation,
    validateChatBody,
    sseData,
    chatCompletion,
    searchFlow,
    respondAI,
    identify,
    apiAuth,
    handlers: {
      chatHandler,
      searchHandler,
      uploadHandler,
      listFilesHandler,
      rawHandler,
      downloadHandler,
      renameHandler,
      deleteHandler,
      statusHandler
    },
    loadIndex,
    AppError,
    TYPES,
    UPLOAD_DIR,
    TEMP_DIR
  }
};
