/**
 * StorageBackend — abstract interface for key-value persistence.
 *
 * All keys are strings (slash-separated paths like "storage/transport_identity").
 * All values are Uint8Array.
 *
 * Implementations:
 * - NodeFileBackend: maps keys to filesystem paths under a base directory
 * - IndexedDBBackend: maps keys to IndexedDB object store entries (browser)
 */

/**
 * Abstract storage backend. Subclasses must implement all methods.
 */
export class StorageBackend {
  /**
   * Initialize the backend (create directories, open databases, etc.)
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error('StorageBackend.init() must be implemented');
  }

  /**
   * Read a value by key.
   * @param {string} key - Slash-separated path (e.g. "storage/transport_identity")
   * @returns {Promise<Uint8Array|null>} Value, or null if not found
   */
  async get(key) {
    throw new Error('StorageBackend.get() must be implemented');
  }

  /**
   * Write a value by key. Creates intermediate "directories" if needed.
   * @param {string} key
   * @param {Uint8Array} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    throw new Error('StorageBackend.set() must be implemented');
  }

  /**
   * Delete a key.
   * @param {string} key
   * @returns {Promise<boolean>} true if the key existed
   */
  async delete(key) {
    throw new Error('StorageBackend.delete() must be implemented');
  }

  /**
   * List keys matching a prefix.
   * @param {string} prefix - e.g. "storage/cache/announces/"
   * @returns {Promise<string[]>} Matching keys
   */
  async list(prefix) {
    throw new Error('StorageBackend.list() must be implemented');
  }

  /**
   * Close the backend and release resources.
   * @returns {Promise<void>}
   */
  async close() {
    // Default: no-op
  }
}

/**
 * Node.js filesystem backend.
 * Keys are mapped to file paths under a base directory.
 * "storage/transport_identity" → "{baseDir}/storage/transport_identity"
 */
export class NodeFileBackend extends StorageBackend {
  /**
   * @param {string} baseDir - Base directory for all storage
   */
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
    this._fs = null;
    this._path = null;
  }

  async init() {
    this._fs = await import('fs/promises');
    this._path = await import('path');
    await this._fs.mkdir(this.baseDir, { recursive: true });
  }

  async get(key) {
    try {
      const data = await this._fs.readFile(this._resolve(key));
      return new Uint8Array(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(key, value) {
    const filePath = this._resolve(key);
    // Ensure parent directory exists
    const dir = this._path.dirname(filePath);
    await this._fs.mkdir(dir, { recursive: true });
    await this._fs.writeFile(filePath, Buffer.from(value));
  }

  async delete(key) {
    try {
      await this._fs.unlink(this._resolve(key));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async list(prefix) {
    const dir = this._resolve(prefix);
    try {
      const entries = await this._fs.readdir(dir);
      return entries.map(e => prefix + (prefix.endsWith('/') ? '' : '/') + e);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  _resolve(key) {
    return this._path.join(this.baseDir, ...key.split('/'));
  }
}

/**
 * IndexedDB backend for browsers.
 *
 * All keys are stored in a single object store. Keys are the
 * slash-separated path strings. Values are Uint8Array stored as ArrayBuffer.
 *
 * Requires globalThis.indexedDB (available in all modern browsers).
 */
export class IndexedDBBackend extends StorageBackend {
  /**
   * @param {string} [dbName='reticulum'] - IndexedDB database name
   * @param {string} [storeName='storage'] - Object store name
   */
  constructor(dbName = 'reticulum', storeName = 'storage') {
    super();
    this.dbName = dbName;
    this.storeName = storeName;
    this._db = null;
  }

  async init() {
    if (!globalThis.indexedDB) {
      throw new Error('IndexedDB is not available in this environment');
    }

    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = () => {
        this._db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };
    });
  }

  async get(key) {
    return this._tx('readonly', (store) => store.get(key)).then(result =>
      result ? new Uint8Array(result) : null
    );
  }

  async set(key, value) {
    // Store as ArrayBuffer for efficient IndexedDB storage
    const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    await this._tx('readwrite', (store) => store.put(buffer, key));
  }

  async delete(key) {
    const existing = await this.get(key);
    if (existing === null) return false;
    await this._tx('readwrite', (store) => store.delete(key));
    return true;
  }

  async list(prefix) {
    // IDBKeyRange for prefix matching: all keys >= prefix and < prefix + highest char
    const range = IDBKeyRange.bound(prefix, prefix + '\uFFFF', false, true);
    return this._tx('readonly', (store) => {
      return new Promise((resolve, reject) => {
        const request = store.getAllKeys(range);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  /**
   * Execute a transaction.
   * @param {'readonly'|'readwrite'} mode
   * @param {function(IDBObjectStore): IDBRequest|Promise} fn
   * @returns {Promise<any>}
   */
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      const result = fn(store);

      // If fn returned a Promise (for list), handle it separately
      if (result instanceof Promise) {
        result.then(resolve, reject);
        return;
      }

      // Otherwise it's an IDBRequest
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    });
  }
}

/**
 * In-memory backend for testing. No persistence.
 */
export class MemoryBackend extends StorageBackend {
  constructor() {
    super();
    this._data = new Map();
  }

  async init() {}

  async get(key) {
    const val = this._data.get(key);
    return val ? new Uint8Array(val) : null;
  }

  async set(key, value) {
    // Store a copy
    this._data.set(key, new Uint8Array(value));
  }

  async delete(key) {
    return this._data.delete(key);
  }

  async list(prefix) {
    const results = [];
    for (const key of this._data.keys()) {
      if (key.startsWith(prefix)) results.push(key);
    }
    return results;
  }

  async close() {
    this._data.clear();
  }
}
