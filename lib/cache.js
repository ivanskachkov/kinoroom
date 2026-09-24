// Небольшой кэш в памяти: экономит квоту YouTube API и ускоряет повторные поиски.
// Хранит промисы, поэтому одинаковые запросы, пришедшие одновременно, склеиваются в один.
export function createCache({ ttl = 60 * 60 * 1000, max = 500 } = {}) {
  const store = new Map();

  return function cached(key, load) {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;

    const promise = load();
    const entry = { promise, expires: Date.now() + ttl };
    store.delete(key);
    store.set(key, entry);
    promise.catch(() => {
      if (store.get(key) === entry) store.delete(key);
    });
    if (store.size > max) store.delete(store.keys().next().value);
    return promise;
  };
}
