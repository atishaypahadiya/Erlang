// Things named fetch that are not network calls.
const cache = new Map();
const store = { fetch: (key) => cache.get(key) };

export function cached(key) {
  return store.fetch(key);
}

function fetch(key) {
  return cache.get(key);
}

export function local(key) {
  return fetch(key);
}
