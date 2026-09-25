# Destek Ofis

Kayıt tutan her sektör için ofis yönetim sistemi. Bu depo şu an ürünün tanıtım ve indirme sitesini içerir.

## Yapı

```
web/                 Tanıtım sitesi (statik, derleme gerektirmez)
  index.html         Sayfanın tamamı
  assets/style.css   Tasarım (açık ve koyu tema)
  assets/main.js     Mobil menü, tema düğmesi, "yakında" bildirimi, animasyonlar
  assets/favicon.svg Destek Ofis logosu
```

Site `web/` klasöründe tutulur; deponun kökü ileride programın kendisi veya başka parçalar için boş bırakılmıştır.

## Yayın

Depo Vercel'e bağlıdır (proje: `destek-ofis`, kök klasör: `web`).
`main` dalına yapılan her gönderim siteyi otomatik olarak yeniden yayınlar.

Alan adı alındığında Vercel panelinde projeye girip **Settings → Domains** bölümünden eklenir.

## İçerik notları

- Site şimdilik yalnızca **demoyu** tanıtır; lisans satışı siteden yapılmaz. Demodan sonra devam etmek isteyenler
  telefon (0532 605 05 87) veya e-postayla (bilgi.ugurcetin@gmail.com) iletişime geçer.
- `web/kvkk.html` KVKK aydınlatma metnidir (`/kvkk`). Veri sorumlusunun ad-soyad/unvan ve adresi eklenmek istenirse
  "1. Veri sorumlusu" bölümüne yazılır.
- `web/vercel.json`: `cleanUrls` (`/kvkk.html` → `/kvkk`) ve temel güvenlik başlıkları.

## İndirme bağlantısı

"Demo sürümü indir" düğmesi şimdilik "çok yakında" bildirimi gösterir (bildirimde telefon numarası da yazar).
Kurulum dosyası yayımlandığında `web/index.html` içinde `data-soon="demo"` olan bağlantının `href="#"` değerini
indirme adresiyle değiştirip `data-soon` özelliğini silmek yeterlidir.

## Supabase

Supabase projesi: `destekofis` (`https://lvzaeekyovhquljzesye.supabase.co`).
Adres ve herkese açık (publishable) anahtar Vercel projesine ortam değişkeni olarak eklidir:
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. Veritabanında henüz tablo yoktur; indirme kaydı, lisans yönetimi
veya iletişim formu gibi özellikler eklendiğinde kullanılacaktır.
