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

## Otomatik başarısız hesap temizliği

URL hesabı art arda 50 otomatik taramada `failed` sonucu alırsa kayıt, sağlık
bilgisi ve hata sayacı otomatik silinir. Mevcut ardışık hata sayacı korunur;
etiketleme eşiği (2/3/5) ile silme eşiği (50) birbirinden bağımsızdır.
Otomatik veya elle taramada `active` sonucu gelirse sayaç sıfırlanır ve
“Kalıcı çalışmıyor” etiketi kalkar. Elle tarama hataları silme sayacını artırmaz.
Dosya hesapları kapsam dışındadır; süresi biten hesaplar bu kuralla silinmez.
Otomatik tarama kapalıysa otomatik silme de çalışmaz.

Silme, yalnızca o turda yeniden başarısız bulunan ve tarama sırasında
değiştirilmemiş hesaplara uygulanır. İşlemler kullanıcı bazında sıraya alınır;
aynı otomatik tur ikinci kez sayılmaz. Hesaplar ekranı görünürken durumlar
30 saniyede bir yenilenir. Testler yalnızca izole test kullanıcıları ve sahte
ağ yanıtlarıyla çalışır; gerçek hesaplar test amacıyla silinmez.

### Kullanıcının gün seçimi

Ayarlar → Çalışmayan hesapları otomatik sil → Gün sayısına göre alanından
1–3650 tam gün seçilip kaydedilebilir. Ayar her kullanıcının kendi hesabında
saklanır. Bu modda 50 tarama sınırı yerine gün süresi kullanılır. İlk başarısız
otomatik taramadan itibaren süre hesaplanır; eski kayıtlarda mevcut kalıcı hata
tarihi kullanılır, tarih bilinmiyorsa yeni başarısız taramada başlar.
Süre dolması tek başına silmez: kalıcı hata eşiğini geçmiş hesabın sonraki
otomatik taramada da başarısız bulunması gerekir. Aktif sonuç süreyi sıfırlar.
Tarama sayısına göre modunda kullanıcı 1–10000 arasında istediği tam sayıyı
(örneğin 1, 2, 34 veya 1234) girebilir. Hesap seçilen sayı kadar art arda
otomatik taramada başarısız bulunursa silinir. Aktif sonuç sayacı sıfırlar.
Yeni kullanıcılar için başlangıç değeri 50'dir; mevcut ayarı olmayan
kullanıcılarda da 50 korunur.
