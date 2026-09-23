# Siberdeyz IPTV Player

Basit ve moduler IPTV yayin listeleme/oynatma sistemi.

## Ozellikler

- M3U / m3u_plus yayin listesini sunucuda ceker.
- Kanallari kategoriye gore ayirir.
- Kanal arama ve liste yenileme vardir.
- Video oynatma istegi `/api/stream/:id` proxy rotasindan akar.
- Moduller ayridir; yeni ozellikler mevcut sistemi bozmadan eklenebilir.

## Moduller

| Dosya | Gorev |
| --- | --- |
| `src/config.js` | Ortam ayarlarini okur. |
| `src/modules/m3uParser.js` | M3U metnini kanal listesine cevirir. |
| `src/modules/playlistService.js` | Yayin listesini ceker ve cache yapar. |
| `src/modules/streamProxy.js` | Secilen kanali tarayiciya proxy eder. |
| `src/modules/mediaFinderProService.js` | Site + film/oyuncu veya dogrudan yayin linkiyle calisan bagimsiz Yayin Bul Pro is akisini yonetir. |
| `src/modules/mediaFinderPro/*` | Guvenli URL, coklu arama, tarayici kesfi ve yayin dogrulama motorlari. |
| `src/routes/api.js` | API rotalarini tutar. |
| `public/*` | Basit kullanici arayuzu. |

## Railway Kurulum

Railway'de GitHub reposunu bagla ve su ortam degiskenlerini ekle:

```env
M3U_SOURCE_URL=http://senin-yayin-adresin/get.php?username=KULLANICI&password=SIFRE&type=m3u_plus
PLAYLIST_CACHE_SECONDS=120
```

`PORT` degiskenini Railway kendisi verir. Uygulama `npm start` ile calisir.

## Lokal Calistirma

```bash
npm install
cp .env.example .env
npm run dev
```

Sonra tarayicida `http://localhost:3000` adresini ac.

## Gelistirme Notu

Yeni ozellik eklerken mevcut modulleri bozma. Ornegin favoriler icin `src/modules/favoritesService.js`, admin icin `src/routes/admin.js` gibi ayri dosyalar acilabilir.
# Masaüstü arayüz modülü

`public/desktopLayout.js` ve `public/desktopLayout.css`, en az 1024 CSS piksel
genişliğinde, fare/trackpad kullanan masaüstü ekranlarında ayrı bir düzen sağlar.
iPhone, iPad ve iPad'in masaüstü Safari modu bu düzenin dışında tutulur.
Dar pencere veya dokunmatik kullanımda mevcut arayüz devam eder.

- Sol menü, yan yana oynatıcı ve içerik paneli; masaüstünde yayın seçimi listeyi kapatmaz.
- Hesaplar, ayarlar ve dört web tarama modu mevcut kontrolleri ve servisleri kullanır.
- `/` kanal aramasını açar; `Alt+1/2/3/4` bölümlere geçer. Form yazarken kısayollar devre dışıdır.
- Ekran boyutu değiştiğinde video, alanlar ve olay dinleyicileri yeniden oluşturulmaz.
- Mobil stil dosyaları değiştirilmez; masaüstü CSS'i hem medya sorgusu hem cihaz sınıfıyla sınırlanır.

Kontrol: `npm ci && npm test`. Masaüstü regresyon testleri cihaz seçimini,
mobil DOM'un korunmasını, ekran geçişlerini ve kısayolları kapsar. Gerçek iOS
Safari ve oturum açılmış canlı yayın testi ayrıca yapılmalıdır.
