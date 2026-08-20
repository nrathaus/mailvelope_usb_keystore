/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * IndexedDB persistence for the FileSystemDirectoryHandle of the USB keystore.
 *
 * Why IndexedDB rather than passing the handle over a port: runtime messages are
 * JSON-serialized, so a FileSystemHandle cannot survive chrome.runtime messaging.
 * IndexedDB stores it by structured clone, and the app page and the service worker
 * share one chrome-extension:// origin, so the page writes the handle and the
 * background reads it back. The port message only carries the signal, not the handle.
 */

import {HANDLE_DB_NAME, HANDLE_STORE_NAME, HANDLE_KEY} from './constants';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, mode);
      const request = fn(tx.objectStore(HANDLE_STORE_NAME));
      tx.onabort = () => reject(tx.error);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Persist the directory handle. Called from the app page, which is the only
 * context that can run showDirectoryPicker().
 * @param {FileSystemDirectoryHandle} handle
 */
export async function put(handle) {
  await transact('readwrite', store => store.put(handle, HANDLE_KEY));
}

/**
 * Retrieve the stored directory handle.
 * @return {Promise<FileSystemDirectoryHandle|undefined>}
 */
export function get() {
  return transact('readonly', store => store.get(HANDLE_KEY));
}

/**
 * Forget the stored handle. Note this only drops our reference; it does not
 * revoke the browser's permission grant.
 */
export async function remove() {
  await transact('readwrite', store => store.delete(HANDLE_KEY));
}
