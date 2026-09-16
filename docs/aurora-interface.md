# Aurora arayüz modülü

Aurora, mevcut uygulamanın üzerine eklenen ve cihaz bazında kapatılabilen bir sunum katmanıdır. Oynatıcı, hesap, tarama, oturum ve sunucu modüllerini değiştirmez.

- `public/interface/aurora.js`: görünüm seçimi, dekoratif simgeler, gerçek video olaylarından durum metni ve menü yüksekliğinin ölçülmesi.
- `public/interface/aurora.css`: yalnızca `html[data-interface="aurora"]` altında etkin yeni görünüm; bağımsız geçiş düğmesi ve ayar kartı her iki görünümde bulunur.
- `public/index.html`: iki yeni dosyanın yüklenmesi.
- `public/service-worker.js`: yeni dosyaların çevrimdışı önbelleğe alınması ve önbellek sürümü.

## Kullanım ve geri dönüş

İlk açılışta Aurora etkindir. Üstte **Klasik görünüm** veya **Ayarlar → Arayüz → Klasik** ile önceki tasarıma dönülür. Seçim yalnızca bu tarayıcıda `siberdeyz.interface.v1` anahtarında saklanır. Görünüm değişimi video öğesini değiştirmez ve sayfayı yenilemez.

Ayar paneli açılamıyorsa `/?interface=classic` ile klasik görünümü zorlayın. `/?interface=aurora` yeni görünümü zorlar. URL parametresi kayıtlı tercihten önceliklidir; sonraki ziyaretlerde ana adresi kullanın. Depolama engellenirse geçiş mevcut sayfada çalışır, kalıcı kaydedilemediği ayar kartında belirtilir.

Tam geri alma için bu değişiklik commit'ini revert edin. Eski stil dosyaları ve uygulama modülleri korunmuştur. Railway dağıtımı ana dal üzerinden yapılıyorsa özellik dalı tek başına canlı uygulamayı güncellemez.

## Doğrulama

İsteğe bağlı yerel test: Playwright/Chromium ve FFmpeg kurulu bir geliştirme ortamında `node scripts/verify-interface.mjs` çalıştırın. Test sunucusu 3131 portunda geçici veri dizini ve yalnızca test şifresiyle açılır; üretim hesaplarına bağlanmaz. Playwright ayrı konumdaysa `PLAYWRIGHT_MODULE`, Chromium ayrı konumdaysa `TEST_CHROMIUM_EXECUTABLE` kullanılabilir. Ekran görüntüleri geçici dizine yazılır; `UI_TEST_OUTPUT` ile konum seçilebilir.

Test; 393, 320, 852 ve 1280 piksel genişliklerde dört panelin açılmasını, panel/menü çakışmasını, yatay taşmayı, M3U yüklemeyi, aramayı, favorileri, kanal seçimini, test videosu oynarken görünüm geçişini, durdurmayı, tercih kalıcılığını ve URL ile geri dönüşü kontrol eder. Video yalnızca yerel üretilmiş test klibidir.

Fiziksel iPhone Safari, gerçek IPTV/HLS kaynakları ve Railway üretim dağıtımı ayrıca denenmelidir. Chromium testleri bunların yerine geçmez.
