import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv']);
const RESCAN_MS = 60_000;

async function scan(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 8 || found.length >= 10_000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Поиск по видеофайлам в MEDIA_DIR. Сами файлы раздаёт express.static на /media
// (он поддерживает Range-запросы, поэтому перемотка работает без полной загрузки).
export function createLibraryRouter(root) {
  const router = express.Router();
  let listing = null;
  let listedAt = 0;

  function getListing() {
    if (!listing || Date.now() - listedAt > RESCAN_MS) {
      listedAt = Date.now();
      listing = scan(root);
      listing.catch(() => (listing = null));
    }
    return listing;
  }

  router.get('/search/library', async (req, res) => {
    const words = String(req.query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const files = await getListing();
    const results = files
      .filter((file) => {
        const lower = file.toLowerCase();
        return words.every((word) => lower.includes(word));
      })
      .slice(0, 60)
      .map((file) => {
        const folder = path.posix.dirname(file);
        return {
          title: path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim(),
          folder: folder === '.' ? '' : folder,
          url: `/media/${file.split('/').map(encodeURIComponent).join('/')}`,
        };
      });
    res.json({ results });
  });

  return router;
}
