# StackMate — Web IDE + AI Agent

Tarayıcı tabanlı, Monaco Editor kullanan, koyu temalı bir geliştirme ortamı (IDE).  
Yerel terminal ve **AI agent** ile birlikte çalışır, Electron paketlemesine hazırdır.

---

## Genel Özellikler

| Bileşen | Açıklama |
|---|---|
| **File Explorer** | File System Access API veya backend üzerinden gerçek dosya sistemi erişimi, lazy-loading klasör açma |
| **Monaco Editor** | VS Code ile aynı editör motoru — sözdizimi renklendirme, 20+ dil |
| **Tab Yönetimi** | Çoklu dosya sekmeleri, sekmeler arası geçiş, sekme kapatma |
| **Kaydetme** | Ctrl+S / Cmd+S ile yerel dosyaya kayıt (FS Access veya backend API) |
| **Terminal** | WebSocket tabanlı gerçek terminal — komut geçmişi, ok tuşları, tab tamamlama |
| **AI Panel (Agent)** | LM Studio entegrasyonu + agent sistemi — dosya/klasör/terminal aksiyon kartları, onay akışı |
| **Resize** | Tüm paneller sürükleyerek boyutlandırılabilir |
| **State Kalıcılığı** | Son açılan klasör, dosyalar, terminal durumu ve panel boyutları kaydedilir |
| **IDE Benzeri Menü** | Üst menü (File/Edit/Selection/View/Go/Terminal/Help) + sağ tarafta hızlı butonlar |

---

## Kurulum

```bash
# Projeyi klon'la veya klasöre gir
cd StackMate

# Bağımlılıkları yükle
npm install
```

---

## Çalıştırma

```bash
# Hem frontend (Vite) hem terminal + dosya API + AI proxy backend'i birlikte başlatır
npm run dev:all
```

- Uygulama (IDE): `http://localhost:5173`  
- Terminal ve dosya backend: `http://localhost:3001`

> **Not:** Terminal ve AI özellikleri için hem Vite hem de `terminal-server.cjs` aynı anda çalışmalıdır.

---

## Proje Yapısı (Özet)

```text
StackMate/
├── src/
│   ├── App.jsx                  # Ana uygulama — state, layout, panel resize, FS/AI entegrasyonu
│   ├── App.css                  # Genel layout stilleri
│   ├── main.jsx                 # React giriş noktası
│   ├── index.css                # Global reset
│   ├── components/
│   │   ├── Navbar.jsx/css       # Üst menü çubuğu + sağ butonlar
│   │   ├── FileExplorer.jsx/css # Sol dosya gezgini
│   │   ├── TabBar.jsx/css       # Sekme çubuğu
│   │   ├── CodeEditor.jsx/css   # Monaco Editor sarmalayıcı
│   │   ├── Terminal.jsx/css     # XTerm.js terminal bileşeni
│   │   ├── AIPanel.jsx/css      # AI agent paneli (dosya/terminal aksiyon kartları)
│   │   ├── ResizeHandle.jsx/css # Sürükleyerek boyutlandırma
│   │   ├── StatusBar.jsx/css    # Alt durum çubuğu
│   │   └── ErrorBoundary.jsx    # Hata yakalama
│   └── utils/
│       ├── storage.js           # IndexedDB + localStorage yardımcıları
│       └── fileApi.js           # Backend dosya sistemi API yardımcıları
├── terminal-server.cjs          # Node.js terminal + dosya API + AI proxy backend
├── package.json
└── vite.config.js
```

---

## AI Agent Sistemi

StackMate’in AI paneli klasik bir sohbet değil, **agent odaklı** bir arayüzdür. Model, özel etiketlerle dosya ve terminal komutları üretir; bu komutlar UI içinde **onay kartları** olarak görünür.

### Mimarisi

```text
Tarayıcı (AIPanel.jsx)
      │ HTTP POST (streaming, SSE)
      ▼
terminal-server.cjs (:3001/api/ai-chat)    ← CORS proxy + ek API'ler
      │ HTTP POST
      ▼
LM Studio (:1234/v1/chat/completions)      ← OpenAI uyumlu API
```

Ek olarak:

- `/api/save-file`, `/api/delete-file`, `/api/mkdir` → dosya işlemleri
- `/api/agent-exec` → AI agent için ayrı terminal komut çalıştırma endpoint’i

### Kullanılan Etiketler (DSL)

Model aşağıdaki özel etiketlerle aksiyon üretir:

- `[FILE: yol/dosya.ext]...içerik...[/FILE]` → Dosya oluştur / güncelle  
- `[DELETE_FILE: yol/dosya.ext]` → Dosya sil  
- `[MKDIR: klasor/alt-klasor]` → Klasör oluştur  
- `[CMD: komut]` → Terminal komutu çalıştır

IDE bu etiketleri parse eder ve:

- **FileAction** kartına (kod önizlemeli, Uygula/İptal butonlu),
- **DeleteAction** kartına (uyarılı silme kartı),
- **MkdirAction** kartına (güvenli klasör oluşturma),
- **TerminalAction** kartına (küçük terminal penceresi)

dönüştürür.

### Terminal Agent Akışı

1. Model bir terminal komutu üretir: `[CMD: python -m http.server 8000]`
2. AI paneli bunu **Terminal** kartı olarak gösterir:
   - `Çalıştır` ve `Atla` butonları
   - Komut çalıştığında stdout/stderr çıktısı kart içindeki terminal kutusunda görünür.
3. Komut bittikten sonra kartın altında:
   - **Devam Et** → Çıktı ve exit code “başarılı” olarak modele geri gönderilir.
   - **Hatayı Bildir** → Çıktı ve exit code “hata var, analiz et ve çözüm öner” mesajıyla modele gönderilir.
4. Model bu çıktıya göre bir sonraki adımı (yeni CMD, yeni FILE, vb.) üretir.

Bu sayede:

- Model arka planda zincir komut çalıştırmaz.
- Kullanıcı her adımı, özellikle hataları, küçük terminal kutuları içinde görebilir.

### Dosya Sistemi Modları

StackMate iki farklı dosya çalışma modu destekler:

1. **File System Access API modu (doğrudan disk)**  
   - `showDirectoryPicker` ile klasör açıldığında kullanılır.  
   - AI’nın dosya işlemleri, `FileSystemDirectoryHandle` üzerinden direkt diske yazılır/silinir.

2. **Backend yolu modu (`currentDirPath`)**  
   - Proje klasör yolu backend’e verilmişse kullanılır.  
   - Dosya işlemleri `/api/save-file`, `/api/delete-file`, `/api/mkdir` endpoint’leri üzerinden yapılır.

AI paneli aksiyon başına otomatik seçim yapar:

- Yol biliniyorsa → backend API  
- Yol bilinmiyorsa ama handle varsa → File System Access API

---

## LM Studio Kurulumu

1. [LM Studio](https://lmstudio.ai/)'yu indirip kurun.  
2. Uygun bir model indirin (ör. `qwen`, `mistral`, `llama`, `glm` vb.).  
3. **Developer** sekmesinden OpenAI uyumlu sunucuyu başlatın.  
4. Sunucunun `http://127.0.0.1:1234` adresinde çalıştığından emin olun.  
5. `npm run dev:all` ile StackMate’i başlatın — AI paneli otomatik bağlanır.

AI paneli:

- Aktif modeli ve bağlantı durumunu header’da gösterir.
- Streaming yanıtları kelime kelime yazar.
- Uzun yanıtları istediğiniz an *Stop* butonuyla durdurmanızı sağlar.

---

## Klavye Kısayolları

**IDE genel kısayolları**

| Kısayol | İşlem |
|---|---|
| `Ctrl+S` / `Cmd+S` | Dosyayı kaydet |
| `Ctrl+K Ctrl+O` | Klasör aç |
| `Ctrl+O` | Dosya aç |
| `` Ctrl+` `` | Terminal aç/kapat |
| `Ctrl+Shift+E` | Explorer aç/kapat |
| `Ctrl+F` | Bul (editörde) |
| `Ctrl+H` | Değiştir (editörde) |
| `Shift+Alt+F` | Kodu biçimlendir |
| `F11` | Tam ekran |

**Terminal içi kısayollar**

| Tuş | İşlem |
|---|---|
| `↑ ↓` | Komut geçmişinde gezin |
| `← →` | Satır içinde imleç hareketi |
| `Tab` | Dosya/klasör adı tamamlama |
| `Ctrl+C` | Komutu iptal et |
| `Ctrl+U` | Satırı temizle |
| `Ctrl+K` | İmleçten sağı sil |
| `Home` / `Ctrl+A` | Satır başı |
| `End` / `Ctrl+E` | Satır sonu |

---

## State Kalıcılığı

Sayfa yenilendiğinde otomatik geri yüklenenler:

- ✅ Son açılan klasör (IndexedDB — `FileSystemDirectoryHandle`)  
- ✅ Açık sekmeler ve dosyalar (IndexedDB — `FileSystemFileHandle`)  
- ✅ Aktif sekme  
- ✅ Terminal açık/kapalı durumu (localStorage)  
- ✅ Panel boyutları (localStorage)  

> Tarayıcı, dosya erişimi için izin isteyebilir. İzin verilmezse proje klasörünü yeniden seçmeniz gerekir.

---

## Platform ve Tarayıcı Desteği

**Masaüstü OS**

| Platform | Frontend | Terminal | Notlar |
|---|---|---|---|
| **macOS** | ✅ | ✅ | `/bin/zsh` varsayılan shell |
| **Linux** | ✅ | ✅ | `/bin/bash` varsayılan shell, `$SHELL` öncelikli |
| **Windows** | ✅ | ✅ | `cmd.exe` varsayılan shell (`COMSPEC`) |

**Tarayıcı Özellikleri**

| Özellik | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Temel IDE | ✅ | ✅ | ✅ |
| Dosya Sistemi (File System Access API) | ✅ | ❌ | ❌ |
| Terminal | ✅ | ✅ | ✅ |

> **Önerilen:** Chrome veya Edge — FS Access API ve en sorunsuz IDE deneyimi için.

---

## Terminal Mimarisi (Detay)

```text
Tarayıcı (XTerm.js)
      │ WebSocket (ws://localhost:3001)
      ▼
Node.js (terminal-server.cjs)
      │
      ├── Readline emülatörü (↑↓ history, ←→ cursor, Tab completion)
      ├── Dahili komutlar: cd, clear, vs.
      └── spawn(SHELL, ['-c', cmd]) → tüm diğer komutlar
```

> `node-pty` kuruluysa tam PTY moduna geçer (interaktif TUI’ler daha iyi çalışır).  
> Yoksa, custom readline emülatörü devreye girer.

---

## Electron’a Dönüştürme (Özet)

Projeyi masaüstü uygulaması olarak paketlemek için temel adımlar:

```bash
npm install --save-dev electron electron-builder

# electron/main.js oluştur
# package.json içine:
#   "main": "electron/main.js"
#   "scripts": { "electron:build": "electron-builder" }
```

Detaylı Electron entegrasyonu bu repoda henüz tam şablonlanmadı, ancak yapı buna göre hazırlanmıştır.

---

## Lisans

Bu proje kişisel/prototip amaçlı geliştirilmiştir. Lisans dosyası eklenene kadar varsayılan olarak **tüm hakları saklıdır** (all rights reserved).  
Kendi projenizde kullanmak istiyorsanız, lütfen önce lisanslandırmayı netleştirin.

# StackMate — Web IDE

Tarayıcı tabanlı, Monaco Editor kullanan, koyu temalı bir geliştirme ortamı (IDE). Electron'a dönüştürülmeye hazır.

---

## Özellikler

| Bileşen | Açıklama |
|---|---|
| **File Explorer** | File System Access API ile gerçek dosya sistemi erişimi, lazy-loading klasör açma |
| **Monaco Editor** | VS Code ile aynı editör motoru — sözdizimi renklendirme, 20+ dil |
| **Tab Yönetimi** | Çoklu dosya sekmeleri, sekmeler arası geçiş, sekme kapatma |
| **Kaydetme** | Ctrl+S / Cmd+S ile yerel dosyaya kayıt (File System Access API) |
| **Terminal** | WebSocket tabanlı gerçek terminal — komut geçmişi, ok tuşları, tab tamamlama |
| **AI Panel** | LM Studio entegrasyonu — yerel yapay zeka ile sohbet, streaming yanıt, otomatik model algılama |
| **Resize** | Tüm paneller sürükleyerek boyutlandırılabilir |
| **State Kalıcılığı** | Son açılan klasör, dosyalar, terminal durumu ve panel boyutları kaydedilir |
| **IDE Benzeri Menü** | Üst menü (File/Edit/Selection/View/Go/Terminal/Help) + sağ tarafta hızlı butonlar |
| **Explorer Hızlı Aksiyonlar** | Explorer başlığında Yeni Dosya / Yeni Klasör / Yeniden Adlandır / Sil / Yenile |

---

## Kurulum

```bash
# Projeyi klon'la veya klasöre gir
cd StackMate

# Bağımlılıkları yükle
npm install
```

---

## Çalıştırma

```bash
# Hem frontend (Vite) hem terminal + dosya API + AI proxy backend'i birlikte başlatır
npm run dev:all
```

Uygulama: `http://localhost:5173`  
Terminal backend: `http://localhost:3001`

> **Not:** Terminal özelliği için her iki servisin çalışması gerekir.

---

## Proje Yapısı

```
StackMate/
├── src/
│   ├── App.jsx              # Ana uygulama — state, layout, panel resize
│   ├── App.css              # Genel layout stilleri
│   ├── main.jsx             # React giriş noktası
│   ├── index.css            # Global sıfırlama
│   ├── components/
│   │   ├── Navbar.jsx/css       # Üst menü çubuğu + sağ butonlar
│   │   ├── FileExplorer.jsx/css # Sol dosya gezgini
│   │   ├── TabBar.jsx/css       # Sekme çubuğu
│   │   ├── CodeEditor.jsx/css   # Monaco Editor sarmalayıcı
│   │   ├── Terminal.jsx/css     # XTerm.js terminal bileşeni
│   │   ├── AIPanel.jsx/css      # AI asistan paneli
│   │   ├── ResizeHandle.jsx/css # Sürükleyerek boyutlandırma
│   │   ├── StatusBar.jsx/css    # Alt durum çubuğu
│   │   └── ErrorBoundary.jsx    # Hata yakalama (sayfa boşalmasını önler)
│   └── utils/
│       ├── storage.js       # IndexedDB + localStorage yardımcıları
│       └── fileApi.js       # Backend dosya sistemi API yardımcıları
├── terminal-server.cjs      # Node.js WebSocket terminal + dosya API + AI proxy backend
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
| `Ctrl+F` | Bul (editörde) |
| `Ctrl+H` | Değiştir (editörde) |
| `Shift+Alt+F` | Kodu biçimlendir |
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

## AI Asistan (LM Studio Entegrasyonu)

IDE'nin sağ panelindeki yapay zeka asistanı, yerel makinenizde çalışan [LM Studio](https://lmstudio.ai/) ile entegre çalışır. Verileriniz dışarı çıkmaz — her şey bilgisayarınızda kalır.

### Kurulum

1. [LM Studio](https://lmstudio.ai/)'yu indirip kurun
2. İstediğiniz bir modeli yükleyin (örn: `glm-4.6v-flash`, `llama`, `mistral` vb.)
3. LM Studio'da **Developer** sekmesine gidin ve sunucuyu başlatın
4. Sunucunun `http://127.0.0.1:1234` adresinde çalıştığından emin olun
5. IDE'yi açın — AI paneli otomatik olarak bağlanacaktır

### Mimari

```
Tarayıcı (AIPanel.jsx)
      │ HTTP POST (streaming)
      ▼
terminal-server.cjs (:3001/api/ai-chat)   ← CORS proxy
      │ HTTP POST
      ▼
LM Studio (:1234/v1/chat/completions)     ← OpenAI uyumlu API
```

> Tarayıcılar farklı port'lar arası istekleri CORS nedeniyle engellediğinden, istekler `terminal-server.cjs` üzerindeki proxy aracılığıyla yönlendirilir.

### Özellikler

- 🔄 **Otomatik Model Algılama** — LM Studio'da hangi model yüklüyse onu kullanır, model değiştirince otomatik güncellenir
- 📡 **Streaming Yanıt** — Cevaplar kelime kelime anlık olarak ekrana yazılır
- 🟢 **Bağlantı Durumu** — Header'da yeşil/kırmızı nokta ile bağlantı göstergesi
- 🤖 **Model Bilgisi** — Aktif model adı panelde görüntülenir
- ⏹️ **Yanıt Durdurma** — Uzun yanıtları istediğiniz an durdurabilirsiniz
- 🗑️ **Sohbet Temizleme** — Konuşma geçmişini sıfırlama
- 💬 **Bağlam Hafızası** — Tüm konuşma geçmişi modele gönderilir, önceki mesajları hatırlar

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
