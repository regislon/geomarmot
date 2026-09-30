// @ts-check
/*
 * Generated transformers kept in this browser (IndexedDB), so they survive a
 * reload and are there for the next graph. A graph that uses one also carries
 * its spec in the file's `custom` field, so the file works elsewhere.
 * If IndexedDB is unavailable, generated transformers last as long as the page.
 */

const DB = "geomarmot";
const STORE = "custom";

function open() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB, 1);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @param {{ id: string, spec: any, level: number }} entry */
export async function saveCustom(entry) {
  await run("readwrite", (store) => store.put(structuredClone(entry))).catch((err) =>
    console.warn("Could not keep the generated transformer", err),
  );
}

/** @returns {Promise<Array<{ id: string, spec: any, level: number }>>} */
export async function loadCustoms() {
  try {
    return (await run("readonly", (store) => store.getAll())) || [];
  } catch (err) {
    console.warn("Could not read generated transformers", err);
    return [];
  }
}

export async function deleteCustom(id) {
  await run("readwrite", (store) => store.delete(id)).catch(() => {});
}
