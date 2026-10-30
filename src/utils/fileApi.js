// Backend dosya sistemi API'leri: tüm proje işlemleri yerel backend üzerinden yapılır.
const API_BASE = 'http://localhost:3001/api';

const post = async (route, body, fallbackError) => {
  let response;
  try {
    response = await fetch(`${API_BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new Error('Backend\'e ulaşılamadı. "npm run dev:all" ile sunucuyu başlatın.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || fallbackError), { status: response.status, data });
  return data;
};

/** Klasörü proje kökü olarak doğrular; gerçek (realpath) yolu döner. */
export const apiOpenProject = (dirPath) => post('project-root', { path: dirPath }, 'Klasör açılamadı');

/** İşletim sisteminin klasör seçicisini açar: { path } veya { cancelled: true }. */
export const apiPickFolder = (startPath) => post('pick-folder', { startPath }, 'Klasör seçici açılamadı');

export const apiReadDir = (dirPath, deep = false) => post('read-dir', { path: dirPath, deep }, 'Dizin okunamadı');
export const apiReadSubdir = (dirPath) => post('read-subdir', { path: dirPath }, 'Klasör okunamadı');
export const apiReadFile = (filePath) => post('read-file', { path: filePath }, 'Dosya okunamadı');
export const apiSaveFile = (filePath, content) => post('save-file', { path: filePath, content }, 'Kaydetme hatası');

/** Yalnızca yeni dosya oluşturur; aynı adda dosya varsa hata verir (üzerine yazmaz). */
export const apiCreateFile = (filePath, content = '') => post('create-file', { path: filePath, content }, 'Dosya oluşturulamadı');
export const apiMkdir = (dirPath, { exclusive = false } = {}) => post('mkdir', { path: dirPath, exclusive }, 'Klasör oluşturulamadı');
export const apiRename = (oldPath, newPath) => post('rename', { oldPath, newPath }, 'Yeniden adlandırılamadı');

/** Varsayılan olarak çöp kutusuna taşır; permanent: true kalıcı siler. */
export const apiDelete = (targetPath, { permanent = false } = {}) => post('delete', { path: targetPath, permanent }, 'Silinemedi');
export const apiReveal = (targetPath) => post('reveal', { path: targetPath }, 'Dosya yöneticisinde gösterilemedi');
