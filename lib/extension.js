import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { zipFiles } from './zip.js';

const EXTENSION_DIR = path.join(ROOT, 'extension');
const FOLDER = 'kinoroom-extension';

/**
 * Архив расширения для Netflix. В манифест подставляется адрес сайта, с которого его скачали:
 * так расширение друзей сразу работает с вашим KinoRoom, где бы он ни был.
 * В шаблонах адресов Chrome нет портов — «http://192.168.0.127/*» подходит для любого порта.
 */
export function buildExtensionZip(siteUrl) {
  const site = new URL(siteUrl);
  const files = fs.readdirSync(EXTENSION_DIR).map((name) => {
    let data = fs.readFileSync(path.join(EXTENSION_DIR, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      for (const script of manifest.content_scripts) {
        if (script.js.includes('kinoroom-bridge.js')) script.matches = [`${site.protocol}//${site.hostname}/*`];
      }
      data = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    return { name: `${FOLDER}/${name}`, data };
  });
  return zipFiles(files);
}
