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

## Doldurulacak yerler

`web/index.html` içinde köşeli parantezli metinler yer tutucudur:

- `[Demo süresi / kayıt sınırı]` — Lisans bölümü, Demo kartı
- `[₺ ____ ] / [dönem]` — Lisans bölümü, Ofis Lisansı fiyatı
- `[Demo verilerinin lisanslı sürüme aktarımı ...]` — SSS
- `mailto:[iletisim@alanadiniz.com]` — Son bölümdeki "Bize yazın" düğmesi

## İndirme bağlantıları

"Demo sürümü indir" ve "Lisanslı sürümü indir" düğmeleri şimdilik "çok yakında" bildirimi gösterir.
Dosyalar hazır olduğunda `web/index.html` içinde `data-soon="demo"` ve `data-soon="lisans"` olan iki bağlantının
`href="#"` değerini indirme adresiyle değiştirip `data-soon` özelliğini silmek yeterlidir.

## Supabase

Supabase projesi: `destekofis` (`https://lvzaeekyovhquljzesye.supabase.co`).
Adres ve herkese açık (publishable) anahtar Vercel projesine ortam değişkeni olarak eklidir:
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. Veritabanında henüz tablo yoktur; indirme kaydı, lisans yönetimi
veya iletişim formu gibi özellikler eklendiğinde kullanılacaktır.
