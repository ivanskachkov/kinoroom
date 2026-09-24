import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Комнаты на диске: по JSON-файлу на комнату в <dir>/rooms. Запись атомарная (временный файл
 * + переименование), чтобы отключение питания посреди записи не оставило битый файл.
 * Срок жизни считается от последнего сохранения — то есть от последней активности в комнате.
 */
export function createRoomStore({ dir, ttlDays }) {
  const roomsDir = path.join(dir, 'rooms');
  fs.mkdirSync(roomsDir, { recursive: true });
  const ttlMs = ttlDays * DAY_MS;
  const fileOf = (id) => path.join(roomsDir, `${id}.json`);
  const expired = (file) => Date.now() - fs.statSync(file).mtimeMs > ttlMs;

  function load(id) {
    const file = fileOf(id);
    try {
      if (expired(file)) {
        fs.rmSync(file, { force: true });
        return null;
      }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null; // нет файла или он повреждён — комната начнётся заново
    }
  }

  function save(id, data) {
    const file = fileOf(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  function prune() {
    let removed = 0;
    for (const name of fs.readdirSync(roomsDir)) {
      const file = path.join(roomsDir, name);
      try {
        if (expired(file)) {
          fs.rmSync(file);
          removed += 1;
        }
      } catch {}
    }
    return removed;
  }

  return { load, save, prune };
}
