// Backend dosya sistemi API'leri (Brave/Firefox için)
const API_BASE = 'http://localhost:3001/api';

/**
 * Backend üzerinden dizin yapısını oku
 * @param {string} dirPath - Sunucudaki dizin yolu
 * @param {boolean} deep - Tüm alt dizinleri de oku
 */
export const apiReadDir = async (dirPath, deep = false) => {
    const res = await fetch(`${API_BASE}/read-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath, deep }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Dizin okunamadı');
    return res.json();
};

/**
 * Backend üzerinden dosya kaydet
 * @param {string} filePath - Dosyanın tam yolu
 * @param {string} content - Dosya içeriği
 */
export const apiSaveFile = async (filePath, content) => {
    const res = await fetch(`${API_BASE}/save-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Kaydetme hatası');
    return res.json();
};

/**
 * Backend üzerinden dosya oku
 * @param {string} filePath - Dosyanın tam yolu
 */
export const apiReadFile = async (filePath) => {
    const res = await fetch(`${API_BASE}/read-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Dosya okunamadı');
    return res.json();
};

/**
 * Backend üzerinden alt dizin oku (lazy load)
 * @param {string} dirPath - Alt dizin yolu
 */
export const apiReadSubdir = async (dirPath) => {
    const res = await fetch(`${API_BASE}/read-subdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Dizin okunamadı');
    return res.json();
};

/**
 * Backend üzerinden dosya/klasör yeniden adlandır
 * @param {string} oldPath - Mevcut tam yol
 * @param {string} newPath - Yeni tam yol
 */
export const apiRename = async (oldPath, newPath) => {
    const res = await fetch(`${API_BASE}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newPath }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Adlandırma hatası');
    return res.json();
};

/**
 * Backend üzerinden dosya/klasör sil
 * @param {string} filePath - Silinecek dosya/klasör yolu
 */
export const apiDelete = async (filePath) => {
    const res = await fetch(`${API_BASE}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Silme hatası');
    return res.json();
};
