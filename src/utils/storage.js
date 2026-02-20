const DB_NAME = 'WebIDEStorage';
const DB_VERSION = 2;

const openDB = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
  request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('fileHandles')) {
      db.createObjectStore('fileHandles');
    }
    if (!db.objectStoreNames.contains('appState')) {
      db.createObjectStore('appState');
    }
  };
});

const set = async (storeName, key, value) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readwrite');
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const get = async (storeName, key) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
};

// Klasör handle
export const saveDirectoryHandle = (handle) => set('fileHandles', 'lastDirectory', handle);
export const loadDirectoryHandle = () => get('fileHandles', 'lastDirectory');

// Son açık dosya handle'ları (tab sistemi için)
export const saveOpenFileHandles = (handles) => set('appState', 'openFileHandles', handles);
export const loadOpenFileHandles = () => get('appState', 'openFileHandles');

// Aktif tab
export const saveActiveTab = (filename) => set('appState', 'activeTab', filename);
export const loadActiveTab = () => get('appState', 'activeTab');

// Terminal açık mı
export const saveTerminalState = (isOpen) => localStorage.setItem('terminalOpen', String(isOpen));
export const loadTerminalState = () => localStorage.getItem('terminalOpen') === 'true';

// Panel boyutları (localStorage - basit sayılar)
export const savePanelSizes = (sizes) => {
  localStorage.setItem('panelSizes', JSON.stringify(sizes));
};

export const loadPanelSizes = () => {
  const saved = localStorage.getItem('panelSizes');
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
};
