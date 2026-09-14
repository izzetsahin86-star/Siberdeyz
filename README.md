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
