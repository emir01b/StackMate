# Web IDE

Tarayıcı tabanlı, Monaco Editor kullanan, tam işlevsel bir geliştirme ortamı (IDE). Electron'a dönüştürülmeye hazır.

---

## Özellikler

| Bileşen | Açıklama |
|---|---|
| **File Explorer** | File System Access API ile gerçek dosya sistemi erişimi, lazy-loading klasör açma |
| **Monaco Editor** | VS Code ile aynı editör motoru — sözdizimi renklendirme, 20+ dil |
| **Tab Yönetimi** | Çoklu dosya sekmeleri, sekmeler arası geçiş, sekme kapatma |
| **Kaydetme** | Ctrl+S / Cmd+S ile yerel dosyaya kayıt (File System Access API) |
| **Terminal** | WebSocket tabanlı gerçek terminal — komut geçmişi, ok tuşları, tab tamamlama |
| **AI Panel** | Yerleşik asistan alanı |
| **Resize** | Tüm paneller sürükleyerek boyutlandırılabilir |
| **State Kalıcılığı** | Son açılan klasör, dosyalar, terminal durumu ve panel boyutları kaydedilir |

---

## Kurulum

```bash
# Projeyi klon'la veya klasöre gir
cd web-ide

# Bağımlılıkları yükle
npm install
```

---

## Çalıştırma

```bash
# Hem frontend (Vite) hem terminal backend'i birlikte başlatır
npm run dev:all
```

Uygulama: `http://localhost:5173`  
Terminal backend: `http://localhost:3001`

> **Not:** Terminal özelliği için her iki servisin çalışması gerekir.

---

## Proje Yapısı

```
web-ide/
├── src/
│   ├── App.jsx              # Ana uygulama — state, layout, panel resize
│   ├── App.css              # Genel layout stilleri
│   ├── main.jsx             # React giriş noktası
│   ├── index.css            # Global sıfırlama
│   ├── components/
│   │   ├── Navbar.jsx/css       # Üst menü çubuğu (File, Edit, View, Terminal)
│   │   ├── FileExplorer.jsx/css # Sol dosya gezgini
│   │   ├── TabBar.jsx/css       # Sekme çubuğu
│   │   ├── CodeEditor.jsx/css   # Monaco Editor sarmalayıcı
│   │   ├── Terminal.jsx/css     # XTerm.js terminal bileşeni
│   │   ├── AIPanel.jsx/css      # AI asistan paneli
│   │   ├── ResizeHandle.jsx/css # Sürükleyerek boyutlandırma
│   │   └── ErrorBoundary.jsx    # Hata yakalama (sayfa boşalmasını önler)
│   └── utils/
│       └── storage.js       # IndexedDB + localStorage yardımcıları
├── terminal-server.cjs      # Node.js WebSocket terminal backend
├── package.json
└── vite.config.js
```

---

## Klavye Kısayolları

| Kısayol | İşlem |
|---|---|
| `Ctrl+S` / `Cmd+S` | Dosyayı kaydet |
| `Ctrl+K Ctrl+O` | Klasör aç |
| `Ctrl+O` | Dosya aç |
| `Ctrl+\`` | Terminal aç/kapat |
| `Ctrl+Shift+E` | Explorer aç/kapat |
| `F11` | Tam ekran |

**Terminal kısayolları:**

| Tuş | İşlem |
|---|---|
| `↑ ↓` | Komut geçmişinde gezin |
| `← →` | Satır içinde cursor hareketi |
| `Tab` | Dosya/klasör adı tamamlama |
| `Ctrl+C` | Komutu iptal et |
| `Ctrl+U` | Satırı temizle |
| `Ctrl+K` | Cursor'dan sağı sil |
| `Home` / `Ctrl+A` | Satır başı |
| `End` / `Ctrl+E` | Satır sonu |

---

## State Kalıcılığı

Sayfa yenilendiğinde otomatik geri yüklenenler:

- ✅ Son açılan klasör (IndexedDB — FileSystemDirectoryHandle)
- ✅ Açık sekmeler ve dosyalar (IndexedDB — FileSystemFileHandle)
- ✅ Aktif sekme
- ✅ Terminal açık/kapalı durumu (localStorage)
- ✅ Panel boyutları (localStorage)

> **Tarayıcı izin isteyebilir** — "Dosyalara erişime izin ver" sorusu güvenlik gereğidir, izin verilmezse klasör manuel olarak yeniden açılır.

---

## Platform Desteği

| Platform | Frontend | Terminal | Notlar |
|---|---|---|---|
| **macOS** | ✅ | ✅ | `/bin/zsh` varsayılan shell |
| **Linux** | ✅ | ✅ | `/bin/bash` varsayılan shell, `$SHELL` değişkeni öncelikli |
| **Windows** | ✅ | ✅ | `cmd.exe` varsayılan shell (`COMSPEC` değişkeni) |

### Tarayıcı Desteği

| Özellik | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Temel IDE | ✅ | ✅ | ✅ |
| Dosya Sistemi (File System Access API) | ✅ | ❌ | ❌ |
| Terminal | ✅ | ✅ | ✅ |

> **Önerilen:** Chrome veya Edge — File System Access API desteği için gereklidir.

---

## Terminal Mimarisi

```
Tarayıcı (XTerm.js)
      │ WebSocket (ws://localhost:3001)
      ▼
Node.js terminal-server.cjs
      │
      ├── Readline emülatörü (↑↓ history, ←→ cursor, Tab completion)
      ├── cd / clear — yerleşik komutlar
      └── spawn(SHELL, ['-c', cmd]) — tüm diğer komutlar
```

**Not:** `node-pty` kuruluysa tam PTY moduna geçer (interaktif uygulamalar daha iyi çalışır). Yoksa yerleşik readline emülatörü devreye girer.

---

## Electron'a Dönüştürme

```bash
npm install --save-dev electron electron-builder

# main.js oluştur
# package.json'a "main": "electron/main.js" ekle
# npm run electron:build
```

---

## Bağımlılıklar

```json
{
  "@monaco-editor/react": "^4.7.0",   // Kod editörü
  "concurrently": "^9.x",             // Frontend + backend birlikte çalıştırma
  "express": "^5.x",                  // HTTP sunucu (terminal backend)
  "lucide-react": "^0.x",             // İkonlar
  "node-pty": "^1.1.0",               // PTY desteği (opsiyonel)
  "react": "^19.x",                   // UI kütüphanesi
  "ws": "^8.x",                       // WebSocket (terminal)
  "xterm": "^5.3.0",                  // Terminal emülatörü
  "xterm-addon-fit": "^0.8.0"         // Terminal boyutlandırma
}
```
