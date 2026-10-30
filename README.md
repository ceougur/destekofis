# Destek Ofis

Kayıt tutan her sektör için ofis yönetim sistemi. Bu depo ürünün tanıtım sitesini, lisans servisini (API) ve
operatör merkezini içerir. Programın kendisi ayrı depodadır (`ceougur/ofis---y-netimi`).

## Yapı

```
web/                     Vercel'e yayımlanan kök klasör
  index.html             Tanıtım sayfası (yalnızca demo; lisans satışı yok)
  kvkk.html              KVKK aydınlatma metni (/kvkk)
  admin.html             Operatör merkezi (/admin), parolayla girilir
  assets/                Site ve operatör merkezi dosyaları (style.css, main.js, admin.css, admin.js, favicon.svg)
  api/lisans/v1/         Programın lisans uçları: activate, check, durum; kapi/durum (mobil kapıcı)
  api/operator.mjs       Operatör merkezinin API'si
  api/_lib/              Ortak kod (imza, veritabanı çağrısı); uç değildir
  vercel.json            Temiz adresler, bölge (fra1), güvenlik başlıkları
supabase/lisans.sql      Lisans veritabanı şeması ve fonksiyonları
```

## Yayın

Depo Vercel'e bağlıdır (proje: `destek-ofis`, kök klasör: `web`). `main` dalına yapılan her gönderim siteyi, API'yi
ve operatör merkezini otomatik olarak yeniden yayınlar. Alan adı alındığında Vercel panelinde
**Settings → Domains** bölümünden eklenir; programlardaki lisans servisi adresi (`https://destek-ofis.vercel.app/api/lisans`)
çalışmaya devam eder.

## Lisans servisi ve operatör merkezi

- **Program → servis:** `POST /api/lisans/v1/activate` (deneme başlatma, lisans anahtarı) ve `POST /api/lisans/v1/check`
  (12 saatte bir doğrulama). Yanıtlar Ed25519 ile imzalıdır; program yalnızca kendi içindeki açık anahtarla imzalanmış
  yanıtı kabul eder. Protokol: program deposunda `docs/LISANS.md`.
- **Operatör merkezi:** `https://destek-ofis.vercel.app/admin`. Kullananlar (deneme başlatan/lisanslı ofisler), lisans
  oluşturma, bilgisayara lisans verme, süre değiştirme, engelleme, taşıma (bilgisayardan ayırma), internetsiz etkinleştirme
  kodu, KVKK silme, hareket kaydı ve parola değişimi.
- **e-Belge Kullanımı (2.4.7, EDM iş ortaklığı):** program `/v1/check` gövdesinde `usage.edoc` ile son 3 ayın ay × ortam
  (test/canlı) başına e-Fatura / e-Arşiv / e-SMM TOPLAM sayılarını gönderir (belge içeriği, alıcı, tutar, VKN, ETTN gelmez).
  API (`web/api/_lib/service.mjs` `usageOf`) ve veritabanı (`lisans.record_edoc_usage`) biçimi ayrı ayrı denetler; geçersiz
  satır atılır ve lisans yanıtı hiçbir durumda değişmez. Satır `lisans.edoc_usage` (kurulum, ay, ortam) başınadır ve her
  doğrulamada üzerine yazılır. Operatör merkezi › **e-Belge Kullanımı**: ofis × ay, varsayılan Canlı, ay seçimi, alt TOPLAM;
  ay sonunda EDM raporuyla karşılaştırılır.
- **Mobil Cihaz Sınırı (2.4.7 M2):** `lisans.licenses.mobile_devices` (0–100, varsayılan 3) program başına en çok eşli uzaktan
  cihazdır (telefon, tablet, uzak tarayıcı; iki şirket birlikte). Lisans belirtecine `mobileDevices` olarak girer (denemede sabit 3);
  operatör merkezinde lisans oluştururken ve "Bilgileri düzenle"de değiştirilir, değişiklik hareketlere `license.mobile_devices`
  olarak yazılır. Program yeni sınırı bir sonraki doğrulamada alır (internetsiz lisansta yeni kodla); eski program alanı yok sayar.
  Testler programın `server/lib/license-token.mjs` kopyasıyla (`test/fixtures/program-license-token.mjs`; `DESTEKOFIS_PROGRAM_DIR`
  verilirse aynılığı denetlenir) imzayı doğrular; göç testi `test/sql/lisans-2.4.6.sql` (2.4.6 şeması) üzerine yeni şemayı koşar.
- **Mobil kapıcı → servis (2.4.7 M3):** `POST /api/lisans/v1/kapi/durum`, başlık `authorization: Bearer <anahtar>`, gövde
  `{ licenseId, machine }`. Yanıt `/v1/check` ile AYNI imzalı zarftır (`{ ok: true, token }`; engelli/taşınmış lisansta `status: "blocked"`,
  kayıt yoksa `/v1/check`'in reddi). Kapıcı (program deposu `bulut/kapi/kapi.mjs`) ofis sunucusu kapalıyken lisansın hâlâ geçerli olduğunu
  buradan öğrenir. Uç **salt okurdur**: veritabanında `public.lisans_kapi_durum` (STABLE; karar `lisans.check_impl` ile aynı) son görülme,
  doğrulama zamanı, IP, sürüm, hareket, e-Belge kullanımı ya da Altyapı sayacı yazmaz (ofis kapalıyken "çevrimiçi" görünmesin). Anahtar
  Vercel ortam değişkeni `KAPI_LISANS_ANAHTARI`'dır ve kapıcının `wrangler secret put KAPI_LISANS_ANAHTARI` ile verilen değeriyle AYNIDIR;
  tanımlı değilse ya da 32 karakterden kısaysa uç her isteği 401 ile reddeder (kapalı varsayılan). Karşılaştırma sabit zamanlıdır;
  yanlış/eksik anahtar 401, hatalı gövde (1 KB'tan büyük dahil) 400. Testler `test/lisans-kapi.test.mjs` ve `test/lisans-kapi-sql.test.mjs`
  (`DESTEKOFIS_PROGRAM_DIR` verilirse yanıt programdaki kapıcının doğrulayıcısıyla — `server/lib/kapi-protokol.mjs` — okunur).
- **Testler:** `node --test test/*.test.mjs` (API, veritabanı taklit). Veritabanı testi yerel, geçici bir PostgreSQL ister:
  `LISANS_TEST_PG="host=… port=… user=…" node --test test/*.test.mjs` (Supabase'e dokunmaz; tanımlı değilse atlanır).
- **Durum:** `GET /api/lisans/v1/durum` imza anahtarının ve veritabanı bağlantısının durumunu verir (gizli bilgi içermez).
- **Altyapı limitleri (Özet):** iki kart, Vercel (fonksiyon çağrısı, API veri aktarımı) ve Supabase (veritabanı boyutu,
  egress) kullanımını kotaya oranlar; %70'te sarı, %90'da kırmızı uyarı verir, üst çubukta rozet çıkar ve hareketlere
  `infra.warning` yazılır (günde bir kez). Sayım veritabanında yapılır: `public.lisans_*` fonksiyonları her isteği ve yanıt
  boyutunu `lisans.usage_daily` tablosuna işler (isteğin kendi işleminde; Vercel'e ya da Supabase'e **ek istek yoktur**).
  Veritabanı boyutu `pg_database_size` ile canlı okunur. Site sayfaları ve indirmeler sayıma girmez (indirmeler GitHub'dadır);
  resmî rakamlar Vercel ve Supabase panolarındaki *Usage* sayfalarındadır. Operatör merkezi kullanımı 10 dakika
  önbelleklenir; **Yenile** ile tazelenir. Kotalar ve dönem başlangıç günü *Ayarlar → Altyapı kotaları*'ndan değiştirilir
  (`lisans.settings.infra_limits`; varsayılan Vercel Hobby 1.000.000 çağrı / 100 GB, Supabase Free 500 MB / 5 GB).
- **Cloudflare (Mobil) kartı (2.4.8 C1):** Altyapı limitlerinin üçüncü kartı mobil kullanımın Cloudflare tarafını (kapıcı Worker'ı,
  R2 özet deposu, ofis tünelleri) ücretsiz plan kotalarına oranlar: Worker istekleri (bugün, UTC; 100.000/gün), R2 depolama (10 GB),
  R2 A sınıfı (1.000.000/ay) ve B sınıfı (10.000.000/ay) işlemler, tünel sayısı (hesap başına 1.000). Kota rakamları
  `web/api/_lib/cloudflare.mjs` `CF_LIMITS`'tedir; Cloudflare belgesinden doğrulanana dek `CF_LIMITS_VERIFIED = false` ve kart
  "doğrulanacak" der. Veri sunucu tarafında (operatör oturumu doğrulandıktan sonra) GraphQL Analytics (`workersInvocationsAdaptive`,
  `r2StorageAdaptiveGroups`, `r2OperationsAdaptiveGroups`) ve `GET /accounts/{id}/cfd_tunnel` ile okunur; 10 dakika önbelleklenir
  (Yenile en çok dakikada bir, hata 1 dakika). Hesap geneli sayılır. Değişkenler yoksa kart "Bağlantı Kurulmadı"; okunamayan ölçü
  "Okunamadı" der (0 gösterilmez). Belirteç yanıta, hata iletisine ve günlüğe girmez. Cloudflare uyarıları hareketlere yazılmaz
  (yalnız kart ve üst çubuk rozeti). Test: `test/cloudflare-limits.test.mjs` (Cloudflare taklit; gerçek servise gidilmez).

### Veritabanı (Supabase `destekofis`)

Şema `supabase/lisans.sql` dosyasındadır. Tablolar `lisans` şemasında durur ve dışarıya açık değildir; API yalnızca
`public.lisans_activate`, `public.lisans_check`, `public.lisans_kapi_durum` (salt okur, 2.4.7) ve `public.lisans_operator` fonksiyonlarını çağırır. Dördü de ilk parametre
olarak API sırrını ister (veritabanında yalnızca SHA-256 özeti saklanır). Operatör parolası bcrypt özetidir; oturumlar
veritabanında tutulur, tarayıcıda yalnızca HttpOnly çerezde rastgele bir belirteç bulunur.

Üç fonksiyon ince sarmalayıcıdır: gövdeleri `lisans.activate_impl`, `lisans.check_impl` ve `lisans.operator_impl`
içindedir; sarmalayıcı sonucu döndürmeden önce `lisans.count_usage` ile isteği sayar (Altyapı limitleri). Dördüncüsü
`public.lisans_kapi_durum` → `lisans.kapi_durum_impl` STABLE'dır ve hiçbir şey yazmaz (sayılmaz da).

Supabase güvenlik danışmanı bu dört fonksiyon için "anon çalıştırabilir" uyarısı verir; bilinçlidir (API'nin giriş
noktalarıdır ve sır olmadan hiçbir şey döndürmez). Tablolarda RLS açıktır, politika yoktur: doğrudan erişim kapalıdır.

### Ortam değişkenleri (Vercel → Settings → Environment Variables)

| Değişken | Tür | Açıklama |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | düz | Supabase adresi ve herkese açık anahtar |
| `DESTEKOFIS_API_SECRET` | gizli (Sensitive) | Veritabanı fonksiyonlarının istediği sır |
| `DESTEKOFIS_LICENSE_KEY` | gizli (Sensitive) | Lisans imza anahtarı (Ed25519, PEM) |
| `DESTEKOFIS_LICENSE_KEY_ID` | düz | `destekofis-lisans-2026-1` |
| `KAPI_LISANS_ANAHTARI` | gizli (Sensitive) | Mobil kapıcının `/v1/kapi/durum` anahtarı; kapıcının `wrangler secret`'ıyla aynı değer, en az 32 karakter (yoksa uç kapalı) |
| `CF_ACCOUNT_ID` | düz | Cloudflare hesap kimliği (32 karakter); Cloudflare (Mobil) kartı için |
| `CF_ANALYTICS_TOKEN` | gizli (Sensitive) | YALNIZ OKUMA belirteci (Account Analytics Read, Workers R2 Storage Read, Cloudflare Tunnel Read); kapıcının yazma yetkili `CF_API_TOKEN`'ı DEĞİL. Yoksa kart "Bağlantı Kurulmadı" |

Gizli değerler depoya ve belgelere yazılmaz. Vercel'deki gizli değerler sonradan okunamaz; kaybolursa yenisi üretilir:

- **API sırrını yenilemek:** yeni rastgele bir değer üretin; Vercel'de `DESTEKOFIS_API_SECRET`'ı güncelleyin ve Supabase SQL
  düzenleyicisinde `update lisans.settings set value = encode(sha256(convert_to('<yeni sır>', 'UTF8')), 'hex') where key = 'api_secret_sha256';`
  çalıştırın; ardından Vercel'de son yayını yeniden başlatın (Redeploy).
- **Operatör parolası unutulursa:** Supabase SQL düzenleyicisinde
  `update lisans.settings set value = extensions.crypt('<yeni parola>', extensions.gen_salt('bf', 10)) where key = 'operator_password';`
- **İmza anahtarı:** programdaki açık anahtarla eşleşmek zorundadır. Değiştirmek program güncellemesi gerektirir (program deposu `docs/LISANS.md`).

## İçerik notları

- Site şimdilik yalnızca **demoyu** tanıtır; lisans satışı siteden yapılmaz. Demodan sonra devam etmek isteyenler
  telefonla (Teknik Destek ve Satın Alımlar İçin: 0536 771 50 55; genel: 0532 605 05 87) veya e-postayla (destek@destekofis.net) iletişime geçer.
- `web/kvkk.html` KVKK aydınlatma metnidir. Veri sorumlusu: Uğur Çetin, Karatay / Konya / Türkiye (alan adı ve
  açık adres belli olunca "1. Veri sorumlusu" bölümünde güncellenir).

## İndirme bağlantıları

- **Demo:** `https://github.com/ceougur/ofis---y-netimi/releases/latest/download/DestekOfis-Kurulum.exe`. Her yeni
  sürümde GitHub Release'e kurulum dosyası **`DestekOfis-Kurulum.exe`** adıyla (sürüm numarasız) eklenir; site
  kendiliğinden en yeni sürümü indirir, siteye dokunmak gerekmez.
- **Kullanım kılavuzu:** `web/indir/DestekOfis-Kullanim-Kilavuzu.pdf` (sitede barındırılır; GitHub yayınından
  **gelmez**). Her sürümde bu dosya program deposundaki `client/kilavuz/DestekOfis-Kullanim-Kilavuzu.pdf` ile
  değiştirilir ve site PR'ı birleştirilir; aksi hâlde siteden eski kılavuz iner. Neden sitede: demo indirilince kılavuz
  yeni sekmede açılır (`web/assets/main.js`); GitHub yayın dosyası tarayıcıda açılmaz, ikinci bir indirme başlatır.
  Son güncelleme: 2.0.15 (02.10.2026; sha256 55f06754…).
- Demo indirilince kılavuz yeni sekmede açılır (`web/assets/main.js`).
