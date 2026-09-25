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
  api/lisans/v1/         Programın lisans uçları: activate, check, durum
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
- **Durum:** `GET /api/lisans/v1/durum` imza anahtarının ve veritabanı bağlantısının durumunu verir (gizli bilgi içermez).

### Veritabanı (Supabase `destekofis`)

Şema `supabase/lisans.sql` dosyasındadır. Tablolar `lisans` şemasında durur ve dışarıya açık değildir; API yalnızca
`public.lisans_activate`, `public.lisans_check` ve `public.lisans_operator` fonksiyonlarını çağırır. Üçü de ilk parametre
olarak API sırrını ister (veritabanında yalnızca SHA-256 özeti saklanır). Operatör parolası bcrypt özetidir; oturumlar
veritabanında tutulur, tarayıcıda yalnızca HttpOnly çerezde rastgele bir belirteç bulunur.

Supabase güvenlik danışmanı bu üç fonksiyon için "anon çalıştırabilir" uyarısı verir; bilinçlidir (API'nin giriş
noktalarıdır ve sır olmadan hiçbir şey döndürmez). Tablolarda RLS açıktır, politika yoktur: doğrudan erişim kapalıdır.

### Ortam değişkenleri (Vercel → Settings → Environment Variables)

| Değişken | Tür | Açıklama |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | düz | Supabase adresi ve herkese açık anahtar |
| `DESTEKOFIS_API_SECRET` | gizli (Sensitive) | Veritabanı fonksiyonlarının istediği sır |
| `DESTEKOFIS_LICENSE_KEY` | gizli (Sensitive) | Lisans imza anahtarı (Ed25519, PEM) |
| `DESTEKOFIS_LICENSE_KEY_ID` | düz | `destekofis-lisans-2026-1` |

Gizli değerler depoya ve belgelere yazılmaz. Vercel'deki gizli değerler sonradan okunamaz; kaybolursa yenisi üretilir:

- **API sırrını yenilemek:** yeni rastgele bir değer üretin; Vercel'de `DESTEKOFIS_API_SECRET`'ı güncelleyin ve Supabase SQL
  düzenleyicisinde `update lisans.settings set value = encode(sha256(convert_to('<yeni sır>', 'UTF8')), 'hex') where key = 'api_secret_sha256';`
  çalıştırın; ardından Vercel'de son yayını yeniden başlatın (Redeploy).
- **Operatör parolası unutulursa:** Supabase SQL düzenleyicisinde
  `update lisans.settings set value = extensions.crypt('<yeni parola>', extensions.gen_salt('bf', 10)) where key = 'operator_password';`
- **İmza anahtarı:** programdaki açık anahtarla eşleşmek zorundadır. Değiştirmek program güncellemesi gerektirir (program deposu `docs/LISANS.md`).

## İçerik notları

- Site şimdilik yalnızca **demoyu** tanıtır; lisans satışı siteden yapılmaz. Demodan sonra devam etmek isteyenler
  telefon (0532 605 05 87) veya e-postayla (bilgi.ugurcetin@gmail.com) iletişime geçer.
- `web/kvkk.html` KVKK aydınlatma metnidir. Veri sorumlusu: Uğur Çetin, Karatay / Konya / Türkiye (alan adı ve
  açık adres belli olunca "1. Veri sorumlusu" bölümünde güncellenir).

## İndirme bağlantısı

"Demo sürümü indir" düğmesi şimdilik "çok yakında" bildirimi gösterir (bildirimde telefon numarası da yazar).
Kurulum dosyası yayımlandığında `web/index.html` içinde `data-soon="demo"` olan bağlantının `href="#"` değerini
indirme adresiyle değiştirip `data-soon` özelliğini silmek yeterlidir.
