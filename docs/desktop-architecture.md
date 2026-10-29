# StackMate masaüstü mimarisi

## Öneri

İlk masaüstü sürümünü Electron ile oluşturmak en kısa ve düşük riskli yoldur. Mevcut terminal ve dosya backend'i Node.js kullanıyor; Tauri seçilirse bu yetkili katman Rust komutlarına veya ayrı bir Node sidecar sürecine taşınmalıdır. Paketleme kararı uygulama işlevlerinden bağımsız tutulmalıdır.

## Süreçler ve izinler

1. Electron ana süreci pencereyi ve yetkili backend sürecini başlatır. Backend yalnızca loopback adresinde dinler. Uygulama kapanırken ana süreç, agent'ın başlattığı alt süreçleri de sonlandırır.
2. Renderer'da `nodeIntegration` kapalı, `contextIsolation` açık olmalıdır. Dosya, terminal ve model işlemleri renderer'dan doğrudan Node API çağırmaz; preload üzerinden dar kapsamlı bir köprü veya IPC kullanır.
3. Kullanıcının seçtiği proje kökü ana süreçte tutulur. Dosya API'leri hem sözdizimsel yol taşmasını hem sembolik bağlantı üzerinden kaçışı kontrol eder. Dosya eylemleri ve terminal komutları çalıştırılmadan önce arayüzde ayrı ayrı onaylanır.
4. Terminal komutları proje kökünde başlatılır, fakat kabuk komutunun içeriği proje dışına erişebilir. Bu yetki kullanıcı onayıyla verilir; komutlar dosya API'sinin yol sınırına eşdeğer bir sandbox içinde değildir.
5. Geliştirme modundaki Origin denetimi paketli uygulamada tek başına yeterli değildir. Paketli sürümde backend'e erişim için rastgele oturum anahtarı veya yalnızca IPC kullanılmalıdır. Anahtar uygulama kapanınca geçersizleşir.
6. LM Studio adresi uygulama ayarı olarak saklanır; bağlantı, model listesi ve akış durumu kullanıcıya görünür olur. Model çıktısı, terminal çıktısı ve web içeriği güvenilmeyen veri olarak ele alınır.

## Paketleme öncesi kabul ölçütleri

- Dosya açma, düzenleme, kaydetme ve aynı adlı dosyalar Windows/macOS/Linux üzerinde doğru çalışır.
- Yapılandırılmış araç çağrıları ve metin etiketi uyumluluğu onay kartları üretir; model çıktısı kendi başına dosya veya komut çalıştırmaz.
- Uzun süren süreç başlatma, arka planda bırakma, yeniden durum okuma, durdurma ve uygulama kapanışında temizleme test edilir.
- Paketli uygulamada renderer'dan keyfi filesystem veya child-process erişimi bulunmaz.
