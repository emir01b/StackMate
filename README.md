# StackMate — Masaüstü IDE ve AI Agent

StackMate, Monaco Editor, yerel terminal ve AI agent içeren bir Electron masaüstü uygulamasıdır.

---

## Genel Özellikler

| Bileşen | Açıklama |
|---|---|
| **File Explorer** | Yerel klasör seçici ve klasör içeriğini gerektiğinde yükleyen dosya ağacı |
| **Monaco Editor** | VS Code ile aynı editör motoru — sözdizimi renklendirme, 20+ dil |
| **Tab Yönetimi** | Çoklu dosya sekmeleri, sekmeler arası geçiş, sekme kapatma |
| **Kaydetme** | Ctrl+S / Cmd+S ile yerel dosyaya kayıt |
| **Terminal** | WebSocket tabanlı gerçek terminal — komut geçmişi, ok tuşları, tab tamamlama |
| **AI Panel (Agent)** | LM Studio entegrasyonu + agent sistemi — dosya/klasör/terminal aksiyon kartları, onay akışı |
| **Resize** | Tüm paneller sürükleyerek boyutlandırılabilir |
| **State Kalıcılığı** | Son açılan klasör, dosyalar, terminal durumu ve panel boyutları kaydedilir |
| **IDE Benzeri Menü** | Üst menü (File/Edit/Selection/View/Go/Terminal/Help) + sağ tarafta hızlı butonlar |

---

## Geliştirme

Kaynak koddan çalıştırmak için Node.js 22.12 veya üstü ve npm gerekir.

```bash
npm ci
npm run dev
```

`npm run dev` Electron penceresini açar ve Vite geliştirme sunucusunu uygulama kapanana kadar çalıştırır. Electron, terminal ve dosya servislerini dinamik bir yerel portta başlatır. `npm run dev:all` aynı komutun takma adıdır.

`npm run lint` ve `npm test` kod kontrollerini çalıştırır. Üretim arayüzünü yerel uygulama protokolüyle denemek için önce `npm run build`, ardından `npm start` çalıştırın. `npm run smoke:desktop` yerel Monaco worker'ı, terminal, kimlik doğrulama ve backend yeniden başlatma dahil gerçek Electron açılışını test eder.

LM Studio için varsayılan port `1234` olarak ayarlanmıştır. Farklı bir port kullanıyorsanız **Ayarlar → AI bağlantısı** bölümünden yerel API adresini değiştirin. Uzak, OpenAI uyumlu bir API için aynı bölümde HTTPS taban adresini, model kimliğini ve API anahtarını girin. Bağlantıyı oradan test edebilirsiniz.

Agent ve editör tercihleri de Ayarlar bölümünden yönetilir. API anahtarı tarayıcı depolamasına yazılmaz veya ayar yanıtında gösterilmez; backend tarafından kullanıcıya ait yerel ayar dosyasında saklanır (`%LOCALAPPDATA%\StackMate\settings.json` / `~/.config/StackMate/settings.json`). Bu yerel dosyada anahtar düz metindir; cihaz hesabınıza erişimi olan kişiler dosyayı okuyabilir.

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
├── electron/                   # Ana süreç, app:// protokolü ve preload köprüsü
├── terminal-server.cjs          # Node.js terminal + dosya API + AI proxy backend
├── package.json
└── vite.config.js
```

---

## AI Agent Sistemi

StackMate’in AI paneli klasik bir sohbet değil, **agent odaklı** bir arayüzdür. Model, özel etiketlerle dosya ve terminal komutları üretir; bu komutlar UI içinde **onay kartları** olarak görünür.

### Mimarisi

```text
Electron arayüzü (AIPanel.jsx)
      │ HTTP POST (streaming, SSE)
      ▼
terminal-server.cjs (/api/ai-chat)         ← Yerel API ve model proxy
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

### Proje Dosyaları

**File → Klasör Aç** sistemin yerel klasör seçicisini açar. Seçici hata verirse tam klasör yolunu elle girebilirsiniz. Backend, proje dosyası ve agent işlemlerini seçilen proje köküyle sınırlar.

AI dosya ve klasör eylemleri uygulanmadan önce karttaki onay düğmesine basılmalıdır. Var olan bir dosyanın üzerine yazmadan önce ayrıca onay istenir.

Uyumlu LM Studio modelleri yapılandırılmış araç çağrıları kullanır; diğer modeller için etiketli komut biçimi desteklenir. Terminal kartındaki uzun süren komutlar arka planda bırakılabilir veya durdurulabilir. Sohbeti temizlemek çalışan agent süreçlerine durdurma isteği gönderir.

---

## LM Studio Kurulumu

1. [LM Studio](https://lmstudio.ai/)'yu indirip kurun.  
2. Uygun bir model indirin (ör. `qwen`, `mistral`, `llama`, `glm` vb.).  
3. **Developer** sekmesinden OpenAI uyumlu sunucuyu başlatın.  
4. Sunucunun `http://127.0.0.1:1234` adresinde çalıştığından emin olun.  
5. StackMate’i başlatın. AI paneli yerel sunucuya bağlanır.

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

## Oturum Kalıcılığı

Uygulama açıldığında son proje yolu, açık dosya sekmeleri ve aktif sekme geri yüklenir. Panel boyutları ve terminalin görünürlüğü de saklanır.

---

## Masaüstü Mimarisi

Ana süreç arayüzü `app://stackmate` üzerinden sunar. Dosya, terminal ve AI istekleri yalnızca yerel makinede dinleyen bir alt sürece gider. Arayüz her backend başlangıcında üretilen bağlantı bilgilerini preload köprüsünden alır. Monaco ve worker dosyaları uygulama paketinden yüklenir.

Terminal, WebSocket üzerinden XTerm.js ile haberleşir. Komut geçmişi, satır düzenleme ve dosya adı tamamlama korunur. Windows'ta kabuk `COMSPEC` veya `cmd.exe`, macOS ve Linux'ta `SHELL` veya platformun varsayılan kabuğudur.

---

## Dağıtım Paketi Oluşturma

Paketleme komutunu ilgili işletim sisteminde çalıştırın. Kurulum dosyaları `release/` altında oluşur.

```bash
npm run package -- --win --x64       # Windows x64 NSIS (.exe)
npm run package -- --mac --x64       # macOS Intel (.dmg)
npm run package -- --mac --arm64     # macOS Apple Silicon (.dmg)
npm run package -- --linux --x64     # Linux x64 (.AppImage)
```

Tek başına `npm run package` çalıştırmak mevcut işletim sisteminin hedeflerini üretir. Uygulama dizinini kurulum dosyası oluşturmadan paketlemek için `npm run package:dir` kullanın.

GitHub Actions her hedefi kendi işletim sisteminde derler ve paketlenmiş uygulamayı açılış testinden geçirir. İmzalama anahtarları yapılandırılana kadar üretilen paketler imzasızdır. Kurulu StackMate kendi Electron çalışma zamanını ve yerel backend'ini içerir.

---

## Lisans

Bu proje kişisel/prototip amaçlı geliştirilmiştir. Lisans dosyası eklenene kadar varsayılan olarak **tüm hakları saklıdır** (all rights reserved).  
Kendi projenizde kullanmak istiyorsanız, lütfen önce lisanslandırmayı netleştirin.
