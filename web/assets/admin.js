/* Destek Ofis — Operatör Merkezi.
 * Lisansları ve programı kullanan ofisleri yönetir. Sunucu: POST /api/operator { action, args }.
 * Oturum HttpOnly çerezdedir; bu sayfa hiçbir gizli bilgi saklamaz. Ekrandaki her metin kaçışlanarak basılır. */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const TZ = "Europe/Istanbul";
  const DAY = 86_400_000;
  const SUPPORT_PHONE = "0532 605 05 87";

  const state = {
    session: null,
    installations: null,
    licenses: null,
    filters: { kullananlar: "all", lisanslar: "all", hareketler: "all" },
    search: { kullananlar: "", lisanslar: "" },
  };

  // ---------- Biçimlendirme ----------
  const dateFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
  const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtDate = iso => (iso ? dateFormat.format(new Date(iso)) : "—");
  const fmtDateTime = iso => (iso ? dateTimeFormat.format(new Date(iso)) : "—");
  function ago(iso) {
    if (!iso) return "henüz bağlanmadı";
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (minutes < 2) return "az önce";
    if (minutes < 60) return `${minutes} dakika önce`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} saat önce`;
    const days = Math.round(hours / 24);
    if (days < 31) return `${days} gün önce`;
    return fmtDate(iso);
  }
  const installCode = machine => String(machine || "").toUpperCase().match(/.{4}/g)?.join("-") || "—";
  const normalizeCode = value => {
    const clean = String(value || "").replace(/[\s-]/g, "").toLowerCase();
    return /^[0-9a-f]{32}$/.test(clean) ? clean : null;
  };
  const telHref = phone => {
    const digits = String(phone).replace(/[^\d+]/g, "");
    return digits.startsWith("0") ? `+9${digits}` : digits;
  };
  // Tarih seçicideki gün İstanbul'da günün sonuna kadar geçerlidir (Türkiye yıl boyu UTC+3).
  const endOfDay = ymd => new Date(`${ymd}T23:59:59+03:00`).toISOString();
  const ymdOf = date => new Date(date.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  const addDays = (base, days) => new Date(base.getTime() + days * DAY);
  const addMonths = (base, months) => {
    const date = new Date(base);
    date.setMonth(date.getMonth() + months);
    return date;
  };
  const lower = value => String(value || "").toLocaleLowerCase("tr-TR");

  // ---------- Durum metinleri ----------
  function installationState(item) {
    switch (item.state) {
      case "trial":
        return { tone: (item.trial?.daysLeft ?? 99) <= 7 ? "warn" : "info", text: `Denemede · ${item.trial?.daysLeft ?? "?"} gün kaldı` };
      case "trial_expired":
        return { tone: "warn", text: "Denemesi bitti" };
      case "licensed":
        return { tone: "ok", text: item.license?.expiresAt ? `Lisanslı · bitiş ${fmtDate(item.license.expiresAt)}` : "Lisanslı · süresiz" };
      case "license_expired":
        return { tone: "bad", text: "Lisansı bitti" };
      case "blocked":
        return { tone: "bad", text: "Engelli" };
      default:
        return { tone: "muted", text: "Lisans yok" };
    }
  }
  function licenseState(license) {
    switch (license.state) {
      case "active":
        return { tone: "ok", text: "Kullanımda" };
      case "unused":
        return { tone: "info", text: "Henüz kullanılmadı" };
      case "expired":
        return { tone: "bad", text: "Süresi doldu" };
      case "blocked":
        return { tone: "bad", text: "Engelli" };
      default:
        return { tone: "muted", text: license.state };
    }
  }
  const expiryText = license => (license.expiresAt ? `${fmtDate(license.expiresAt)}${license.daysLeft != null && license.state !== "expired" ? ` (${license.daysLeft} gün)` : ""}` : "Süresiz");

  const EVENTS = {
    "trial.started": "Ücretsiz deneme başlatıldı",
    "trial.repeated": "Deneme yeniden istendi",
    "trial.rate_limited": "Deneme isteği sınırlandı (aynı adresten çok istek)",
    "trial.extended": event => `Deneme bitişi değiştirildi: ${fmtDate(event.detail?.to)}`,
    "trial.blocked": "Deneme engellendi",
    "trial.unblocked": "Deneme engeli kaldırıldı",
    "license.created": "Lisans oluşturuldu",
    "license.assigned": "Lisans bilgisayara tanımlandı",
    "license.activated": "Lisans anahtarı programda etkinleştirildi",
    "license.reactivated": "Lisans anahtarı aynı bilgisayarda yeniden girildi",
    "license.delivered": "Tanımlanan lisans programa ulaştı",
    "license.not_found": "Hatalı lisans anahtarı denendi",
    "license.rejected": event => ({ blocked: "Engelli lisans denendi", expired: "Süresi dolmuş lisans denendi", in_use: "Başka bilgisayardaki lisans denendi" })[event.detail?.reason] || "Lisans reddedildi",
    "license.extended": event => `Lisans bitişi değiştirildi: ${event.detail?.to ? fmtDate(event.detail.to) : "süresiz"}`,
    "license.updated": "Lisans bilgileri düzenlendi",
    "license.blocked": "Lisans engellendi",
    "license.unblocked": "Lisans engeli kaldırıldı",
    "license.released": "Lisans bilgisayardan ayrıldı (taşıma)",
    "license.deleted": "Lisans silindi",
    "license.code_issued": "İnternetsiz etkinleştirme kodu üretildi",
    "license.stop_sent": "Taşınan lisansın eski bilgisayarı durduruldu",
    "check.unknown": "Tanınmayan lisansla doğrulama denendi",
    "installation.contact": "Firma bilgilerini bıraktı (denemenin 3. günü)",
    "installation.updated": "Ofis bilgileri düzenlendi",
    "installation.forgotten": "Kişisel bilgiler silindi (KVKK)",
    "operator.login": "Operatör giriş yaptı",
    "operator.login_failed": "Hatalı parolayla giriş denendi",
    "operator.password_changed": "Operatör parolası değiştirildi",
  };
  const ALERTS = new Set(["license.not_found", "license.rejected", "trial.rate_limited", "operator.login_failed", "check.unknown", "license.stop_sent"]);
  const eventText = event => {
    const value = EVENTS[event.type];
    return typeof value === "function" ? value(event) : value || event.type;
  };
  function eventDetail(event) {
    const detail = event.detail || {};
    const parts = [];
    if (event.type === "trial.started" || event.type === "installation.contact") {
      if (detail.contact) parts.push(detail.contact);
      if (detail.phone) parts.push(detail.phone);
    }
    if (detail.message) parts.push(`“${detail.message}”`);
    if (event.type === "license.not_found" && detail.keyEnd) parts.push(`anahtarın sonu …${detail.keyEnd}`);
    if (event.type === "operator.login_failed" && event.ip) parts.push(`adres ${event.ip}`);
    if (event.actor === "operator" && !event.type.startsWith("operator.")) parts.push("operatör");
    return parts.join(" · ");
  }
  const EVENT_FILTERS = [
    ["all", "Tümü", () => true],
    ["deneme", "Deneme", event => event.type.startsWith("trial.")],
    ["lisans", "Lisans", event => event.type.startsWith("license.") || event.type.startsWith("check.")],
    ["operator", "Operatör", event => event.actor === "operator"],
    ["uyari", "Uyarılar", event => ALERTS.has(event.type)],
  ];
  const INSTALL_FILTERS = [
    ["all", "Tümü", () => true],
    ["trial", "Denemede", item => item.state === "trial"],
    ["trial_expired", "Denemesi biten", item => item.state === "trial_expired"],
    ["licensed", "Lisanslı", item => item.state === "licensed"],
    ["blocked", "Engelli / süresi biten", item => ["blocked", "license_expired", "none"].includes(item.state)],
  ];
  const LICENSE_FILTERS = [
    ["all", "Tümü", () => true],
    ["active", "Kullanımda", item => item.state === "active"],
    ["unused", "Kullanılmamış", item => item.state === "unused"],
    ["expired", "Süresi dolan", item => item.state === "expired"],
    ["blocked", "Engelli", item => item.state === "blocked"],
  ];

  // ---------- Sunucu ----------
  class UiError extends Error {
    constructor(message, silent = false) {
      super(message);
      this.silent = silent;
    }
  }
  async function api(action, args = {}, extra = {}, { quiet = false } = {}) {
    let response;
    try {
      response = await fetch("/api/operator", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-destekofis": "operator" },
        body: JSON.stringify({ action, args, ...extra }),
      });
    } catch {
      throw new UiError("Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // aşağıda ele alınır
    }
    if (response.status === 401 && data?.code === "SESSION") {
      if (!quiet) showLogin("Oturumunuz kapandı. Lütfen yeniden giriş yapın.");
      throw new UiError(data.error, true);
    }
    if (!response.ok || !data?.ok) throw new UiError(data?.error || `Sunucu hatası (${response.status}). Biraz sonra tekrar deneyin.`);
    return data;
  }
  async function loadInstallations(force = false) {
    if (!state.installations || force) state.installations = (await api("installations")).items;
    return state.installations;
  }
  async function loadLicenses(force = false) {
    if (!state.licenses || force) state.licenses = (await api("licenses")).items;
    return state.licenses;
  }
  const invalidate = () => {
    state.installations = null;
    state.licenses = null;
  };

  // ---------- Bildirim, kopyalama ----------
  let toastTimer = null;
  function toast(message, error = false) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.toggle("error", error);
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), error ? 6500 : 3500);
  }
  async function copy(text, label = "Kopyalandı") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "copy-helper";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast(label);
  }

  // ---------- Pencere ----------
  const modal = {
    busy: false,
    lastFocus: null,
    open({ eyebrow = "", title, html }) {
      this.lastFocus = document.activeElement;
      $("#modalEyebrow").textContent = eyebrow;
      $("#modalEyebrow").hidden = !eyebrow;
      $("#modalTitle").textContent = title;
      // Her pencere yeni bir gövde öğesiyle açılır: önceki pencerenin olay dinleyicileri taşınmaz.
      const previous = $("#modalBody");
      const body = previous.cloneNode(false);
      previous.replaceWith(body);
      body.innerHTML = html;
      $("#modal").hidden = false;
      document.body.classList.add("modal-open");
      const first = $("#modalBody [autofocus]");
      setTimeout(() => (first || $("#modalClose")).focus(), 20);
      return $("#modalBody");
    },
    close(force = false) {
      if (this.busy && !force) return;
      $("#modal").hidden = true;
      $("#modalBody").innerHTML = "";
      document.body.classList.remove("modal-open");
      if (this.lastFocus?.isConnected) this.lastFocus.focus();
    },
  };
  $("#modalClose").addEventListener("click", () => modal.close());
  $("#modal").addEventListener("mousedown", event => {
    if (event.target === $("#modal")) modal.close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("#modal").hidden) modal.close();
  });
  document.addEventListener("click", event => {
    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      event.preventDefault();
      copy(copyButton.dataset.copy, copyButton.dataset.copyLabel || "Kopyalandı");
      return;
    }
    if (event.target.closest("[data-close]")) modal.close();
  });

  // Düğmeyi işlem bitene kadar kilitler; hata olursa formdaki alana veya bildirime yazar. Başarıda sonucu döndürür.
  async function run(button, task, errorElement = null) {
    if (errorElement) errorElement.textContent = "";
    if (button) button.disabled = true;
    modal.busy = true;
    try {
      return await task();
    } catch (error) {
      if (!error.silent) {
        if (errorElement) errorElement.textContent = error.message;
        else toast(error.message, true);
      }
      return null;
    } finally {
      modal.busy = false;
      if (button) button.disabled = false;
    }
  }

  // Basit onay penceresi; isteğe bağlı açıklama kutusu.
  function confirmAction({ eyebrow, title, html, confirmLabel, danger = false, messageLabel = null, task }) {
    const body = modal.open({
      eyebrow,
      title,
      html: `${html}
        <form data-confirm novalidate>
          ${messageLabel ? `<label class="field"><span>${esc(messageLabel)}</span><textarea name="message" maxlength="300" rows="2" autofocus></textarea></label>` : ""}
          <p class="form-error" data-error></p>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(confirmLabel)}</button></div>
        </form>`,
    });
    const form = $("[data-confirm]", body);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const message = form.elements.namedItem("message")?.value.trim() || "";
      await run($("button[type=submit]", form), () => task(message), $("[data-error]", form));
    });
  }

  // ---------- Giriş / çıkış ----------
  function showLogin(message = "") {
    modal.close(true);
    state.session = null;
    invalidate();
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#loginError").textContent = message;
    $("#loginPassword").value = "";
    setTimeout(() => $("#loginPassword").focus(), 20);
  }
  function showApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    route();
  }
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("#loginPassword").value;
    if (!password) {
      $("#loginError").textContent = "Parolayı yazın.";
      return;
    }
    const button = $("#loginButton");
    button.disabled = true;
    $("#loginError").textContent = "";
    try {
      await api("login", {}, { password });
      state.session = (await api("me")).session;
      showApp();
    } catch (error) {
      $("#loginError").textContent = error.message;
      $("#loginPassword").select();
    } finally {
      button.disabled = false;
    }
  });
  $("#logoutButton").addEventListener("click", async () => {
    try {
      await api("logout", {}, {}, { quiet: true });
    } catch {
      // oturum zaten kapanmış olabilir
    }
    showLogin("Çıkış yaptınız.");
  });
  $("#refreshButton").addEventListener("click", () => {
    invalidate();
    route();
  });

  // ---------- Yönlendirme ----------
  const VIEWS = { ozet: renderOverview, kullananlar: renderInstallations, lisanslar: renderLicenses, hareketler: renderEvents, ayarlar: renderSettings };
  const currentView = () => {
    const view = location.hash.slice(1);
    return VIEWS[view] ? view : "ozet";
  };
  let routeSerial = 0;
  async function route() {
    const view = currentView();
    const serial = ++routeSerial;
    $$(".tabs a").forEach(link => link.classList.toggle("on", link.dataset.view === view));
    const content = $("#content");
    if (!content.dataset.view || content.dataset.view !== view) content.innerHTML = '<p class="loading">Yükleniyor…</p>';
    content.dataset.view = view;
    try {
      await VIEWS[view](content, () => serial === routeSerial);
    } catch (error) {
      if (!error.silent && serial === routeSerial) content.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  }
  window.addEventListener("hashchange", () => {
    if (!$("#app").hidden) {
      $("#content").dataset.view = "";
      route();
      $("#content").focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  });
  function go(view, filter = null) {
    if (filter) state.filters[view] = filter;
    if (location.hash === `#${view}`) {
      $("#content").dataset.view = "";
      route();
    } else location.hash = view;
  }
  // Ekrandaki kayıtlar değişince görünümü sessizce tazeler (açık pencere kapanmaz).
  const refreshView = () => route();

  // İçerikteki düğmeler
  $("#content").addEventListener("click", async event => {
    const target = event.target.closest("[data-act], [data-go]");
    if (!target) return;
    if (target.dataset.go) {
      go(target.dataset.go, target.dataset.filter || null);
      return;
    }
    const { act, machine, id } = target.dataset;
    if (act === "new-license") licenseForm();
    else if (act === "new-license-code") licenseForm({ bindToCode: true });
    else if (act === "open-installation") openInstallation(machine);
    else if (act === "give-license") {
      const item = (await loadInstallations()).find(entry => entry.machine === machine);
      if (item) licenseForm({ installation: item });
    } else if (act === "open-license") openLicense(id);
  });

  // ---------- Özet ----------
  function stat(view, filter, label, value, note, tone = "") {
    return `<button class="stat ${tone}" type="button" data-go="${view}" data-filter="${filter}"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(note)}</span></button>`;
  }
  const ATTENTION = {
    trial_ending: item => `Denemesi ${fmtDate(item.date)} tarihinde bitiyor`,
    trial_expired: item => `Denemesi ${fmtDate(item.date)} tarihinde bitti`,
    license_ending: item => `Lisansı ${fmtDate(item.date)} tarihinde bitiyor`,
    license_expired: item => `Lisansı ${fmtDate(item.date)} tarihinde bitti`,
  };
  function contactLine(item) {
    const parts = [];
    if (item.contact) parts.push(esc(item.contact));
    if (item.phone) parts.push(`<a class="tel" href="tel:${esc(telHref(item.phone))}">${esc(item.phone)}</a>`);
    if (item.email) parts.push(`<a class="tel" href="mailto:${esc(item.email)}">${esc(item.email)}</a>`);
    return parts.join(" · ") || "İletişim bilgisi yazılmamış";
  }
  function attentionRow(item) {
    const tone = item.kind.endsWith("expired") ? "bad" : "warn";
    return `<div class="attn">
      <div><b>${esc(item.officeName || "Adı yazılmamış ofis")}</b><span class="sub">${contactLine(item)}</span><span class="when ${tone}">${esc(ATTENTION[item.kind]?.(item) || "")}</span></div>
      <div class="attn-actions">
        ${item.kind.startsWith("trial") ? `<button class="btn btn-primary btn-sm" type="button" data-act="give-license" data-machine="${esc(item.machine)}">Lisans ver</button>` : ""}
        <button class="btn btn-ghost btn-sm" type="button" data-act="open-installation" data-machine="${esc(item.machine)}">Ayrıntı</button>
      </div>
    </div>`;
  }
  function eventRow(event) {
    let who = "";
    if (event.machine && event.officeName) who = `<button class="who" type="button" data-act="open-installation" data-machine="${esc(event.machine)}">${esc(event.officeName)}</button>`;
    else if (event.licenseId && event.officeName && event.type !== "license.deleted") who = `<button class="who" type="button" data-act="open-license" data-id="${esc(event.licenseId)}">${esc(event.officeName)}</button>`;
    else if (event.officeName) who = esc(event.officeName);
    else if (event.machine) who = `<span class="mono">${esc(installCode(event.machine))}</span>`;
    const detail = esc(eventDetail(event));
    const sub = [who, detail].filter(Boolean).join(" · ");
    return `<div class="ev${ALERTS.has(event.type) ? " alert" : ""}"><time datetime="${esc(event.at)}">${esc(fmtDateTime(event.at))}</time><div><b>${esc(eventText(event))}</b>${sub ? `<div class="sub">${sub}</div>` : ""}</div></div>`;
  }
  async function renderOverview(content, current) {
    const overview = await api("overview");
    if (!current()) return;
    const counts = overview.counts;
    content.innerHTML = `
      <div class="page-head">
        <div><h1>Özet</h1><p>Programı kullanan ofislerin ve lisansların genel durumu. Kutulara tıklayınca ilgili liste açılır.</p></div>
        <div class="page-actions"><button class="btn btn-primary" type="button" data-act="new-license">+ Yeni lisans</button></div>
      </div>
      <div class="stats">
        ${stat("kullananlar", "all", "Programı kullanan", counts.installations, `son 7 günde bağlanan: ${counts.seenLast7Days}`)}
        ${stat("kullananlar", "trial", "Denemede", counts.trial, counts.trialEndingSoon ? `${counts.trialEndingSoon} tanesi 7 gün içinde bitiyor` : "yakında biten yok", counts.trialEndingSoon ? "warn" : "")}
        ${stat("kullananlar", "trial_expired", "Denemesi biten", counts.trialExpired, "lisans için aranabilir", counts.trialExpired ? "warn" : "")}
        ${stat("kullananlar", "licensed", "Lisanslı", counts.licensed, counts.licenseExpired ? `lisansı biten: ${counts.licenseExpired}` : "sorunsuz çalışıyor", "ok")}
        ${stat("lisanslar", "unused", "Kullanılmamış lisans", overview.unusedLicenses, "anahtarı verildi, henüz girilmedi")}
        ${stat("kullananlar", "blocked", "Engelli", counts.blocked, "program salt okunur çalışıyor", counts.blocked ? "bad" : "")}
      </div>
      <section class="card">
        <div class="card-head"><h2>Aranması gerekenler</h2><span class="count-note">Denemesi veya lisansı biten ve bitmek üzere olanlar</span></div>
        ${overview.attention.length ? `<div class="attention">${overview.attention.map(attentionRow).join("")}</div>` : '<div class="empty">Şu an aranması gereken kimse yok.</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Son hareketler</h2><a class="link-btn" href="#hareketler">Tümünü gör</a></div>
        ${overview.recent.length ? `<div class="timeline">${overview.recent.map(eventRow).join("")}</div>` : '<div class="empty">Henüz hareket yok. Bir ofis demoyu başlattığında burada görünür.</div>'}
      </section>`;
  }

  // ---------- Kullananlar ----------
  function chipsHtml(filters, active, items) {
    return filters.map(([key, label, test]) => `<button type="button" class="chip${key === active ? " on" : ""}" data-filter-key="${key}">${esc(label)}<b>${items.filter(test).length}</b></button>`).join("");
  }
  function installationRow(item) {
    const status = installationState(item);
    return `<button class="row" type="button" data-act="open-installation" data-machine="${esc(item.machine)}">
      <div><b>${esc(item.officeName || "Adı yazılmamış ofis")}</b><span class="sub">${esc(item.contact || "Yetkili yazılmamış")}</span></div>
      <div><span class="sub">${esc(item.phone || "—")}</span><span class="sub">${esc(item.email || "")}</span></div>
      <div><span class="pill ${status.tone}">${esc(status.text)}</span></div>
      <div><span class="sub">${esc(ago(item.lastSeen))}</span><span class="sub">${item.version ? `Sürüm ${esc(item.version)}` : ""}</span></div>
    </button>`;
  }
  const installationText = item => lower([item.officeName, item.contact, item.phone, String(item.phone || "").replace(/\D/g, ""), item.email, item.machine, installCode(item.machine), item.license?.key, item.license?.customer, item.note].join(" "));
  async function renderInstallations(content, current) {
    const items = await loadInstallations();
    if (!current()) return;
    content.innerHTML = `
      <div class="page-head">
        <div><h1>Kullananlar</h1><p>Programı kurup demoyu başlatan veya lisans etkinleştiren ofisler. Her satır bir ofisin sunucu bilgisayarıdır.</p></div>
        <div class="page-actions"><button class="btn btn-ghost" type="button" data-act="new-license-code">Kurulum koduyla lisans ver</button></div>
      </div>
      <div class="toolbar">
        <input class="search" type="search" id="installSearch" placeholder="Ofis, kişi, telefon, e-posta veya kurulum kodu ile arayın" aria-label="Kullananlarda ara">
        <div class="chips" role="group" aria-label="Süzgeç">${chipsHtml(INSTALL_FILTERS, state.filters.kullananlar, items)}</div>
      </div>
      <div id="installList"></div>`;
    const search = $("#installSearch", content);
    search.value = state.search.kullananlar;
    const draw = () => {
      const test = INSTALL_FILTERS.find(([key]) => key === state.filters.kullananlar)?.[2] || (() => true);
      const words = lower(state.search.kullananlar).split(/\s+/).filter(Boolean);
      const shown = items.filter(item => test(item) && words.every(word => installationText(item).includes(word)));
      $("#installList", content).innerHTML = shown.length
        ? `<div class="rows cols-inst"><div class="row-head"><div>Ofis</div><div>İletişim</div><div>Durum</div><div>Son bağlantı</div></div>${shown.map(installationRow).join("")}</div>`
        : `<div class="empty">${items.length ? "Aramaya uyan kayıt yok." : "Henüz kimse demoyu başlatmadı. Bir ofis programı kurup denemeyi başlattığında burada görünür."}</div>`;
    };
    search.addEventListener("input", () => {
      state.search.kullananlar = search.value;
      draw();
    });
    $$(".chip", content).forEach(chip =>
      chip.addEventListener("click", () => {
        state.filters.kullananlar = chip.dataset.filterKey;
        $$(".chip", content).forEach(other => other.classList.toggle("on", other === chip));
        draw();
      }),
    );
    draw();
  }

  async function loadHistory(body, args) {
    const box = $("[data-history]", body);
    if (!box) return;
    try {
      const items = (await api("events", { ...args, limit: 40 })).items;
      if (!box.isConnected) return;
      box.innerHTML = items.length ? items.map(eventRow).join("") : '<p class="faint">Kayıt yok.</p>';
    } catch (error) {
      if (box.isConnected) box.innerHTML = `<p class="faint">${esc(error.message)}</p>`;
    }
  }

  async function openInstallation(machine) {
    const item = (await loadInstallations().catch(error => (toast(error.message, true), []))).find(entry => entry.machine === machine);
    if (!item) {
      toast("Kayıt bulunamadı.", true);
      return;
    }
    const status = installationState(item);
    const { trial, license } = item;
    const body = modal.open({
      eyebrow: "Kullanan ofis",
      title: item.officeName || "Adı yazılmamış ofis",
      html: `
        <div><span class="pill ${status.tone}">${esc(status.text)}</span></div>
        <dl class="kv">
          <dt>Yetkili</dt><dd>${esc(item.contact || "—")}</dd>
          <dt>Telefon</dt><dd>${item.phone ? `<a class="tel" href="tel:${esc(telHref(item.phone))}">${esc(item.phone)}</a>` : "—"}</dd>
          <dt>E-posta</dt><dd>${item.email ? `<a class="tel" href="mailto:${esc(item.email)}">${esc(item.email)}</a>` : "—"}</dd>
          <dt>Kurulum kodu</dt><dd><span class="mono">${esc(installCode(item.machine))}</span> <button class="link-btn" type="button" data-copy="${esc(installCode(item.machine))}" data-copy-label="Kurulum kodu kopyalandı">Kopyala</button></dd>
          <dt>Program sürümü</dt><dd>${esc(item.version || "—")}</dd>
          <dt>Son bağlantı</dt><dd>${item.lastSeen ? `${esc(fmtDateTime(item.lastSeen))} (${esc(ago(item.lastSeen))})` : "Henüz bağlanmadı"}</dd>
          ${trial ? `<dt>Deneme</dt><dd>${esc(fmtDate(trial.startedAt))} – ${esc(fmtDate(trial.expiresAt))}${trial.status === "blocked" ? " · <b>engelli</b>" : ""}</dd>` : ""}
          ${license ? `<dt>Lisans</dt><dd><span class="mono">${esc(license.key)}</span> · ${license.expiresAt ? `bitiş ${esc(fmtDate(license.expiresAt))}` : "süresiz"}</dd>` : ""}
          ${item.note ? `<dt>Not</dt><dd>${esc(item.note)}</dd>` : ""}
        </dl>
        <div class="action-grid">
          ${license ? '<button class="btn btn-primary" type="button" data-do="open-license">Lisansı aç</button>' : '<button class="btn btn-primary" type="button" data-do="give">Lisans ver</button>'}
          ${trial && !license ? '<button class="btn btn-ghost" type="button" data-do="extend-trial">Denemeyi uzat</button>' : ""}
          ${trial && !license ? (trial.status === "blocked" ? '<button class="btn btn-ghost" type="button" data-do="trial-unblock">Deneme engelini kaldır</button>' : '<button class="btn btn-danger-ghost" type="button" data-do="trial-block">Denemeyi engelle</button>') : ""}
          <button class="btn btn-ghost" type="button" data-do="edit">Bilgileri düzenle</button>
          <button class="btn btn-danger-ghost" type="button" data-do="forget">Kişisel bilgileri sil</button>
        </div>
        <div class="history"><h3>Geçmiş</h3><div class="timeline" data-history><p class="faint">Yükleniyor…</p></div></div>`,
    });
    body.querySelector(".action-grid").addEventListener("click", event => {
      const action = event.target.closest("[data-do]")?.dataset.do;
      if (action === "open-license") openLicense(license.id);
      else if (action === "give") licenseForm({ installation: item });
      else if (action === "extend-trial") extendTrial(item);
      else if (action === "trial-block") trialStatus(item, "blocked");
      else if (action === "trial-unblock") trialStatus(item, "active");
      else if (action === "edit") editInstallation(item);
      else if (action === "forget") forgetInstallation(item);
    });
    loadHistory(body, { machine: item.machine });
  }

  async function afterInstallationChange(machine, message) {
    invalidate();
    toast(message);
    refreshView();
    await openInstallation(machine);
  }

  function extendTrial(item) {
    const current = new Date(item.trial.expiresAt);
    const base = current > new Date() ? current : new Date();
    const options = [["7", "+7 gün"], ["15", "+15 gün"], ["30", "+30 gün"], ["date", "Tarih seç"]];
    const body = modal.open({
      eyebrow: "Denemeyi uzat",
      title: item.officeName || "Adı yazılmamış ofis",
      html: `<form class="form-grid" novalidate data-form>
        <p class="wide muted">Şu anki bitiş: <b>${esc(fmtDate(item.trial.expiresAt))}</b>. Program yeni tarihi bir sonraki doğrulamada (en geç 12 saat) alır; hemen almak için ofisten programda <b>Yönetim → Lisans → “Şimdi doğrula”</b>ya basmasını isteyin.</p>
        <div class="field wide"><span>Ne kadar uzatılsın?</span><div class="choice">${options.map(([value, label], index) => `<label><input type="radio" name="term" value="${value}"${index === 0 ? " checked" : ""}><span>${label}</span></label>`).join("")}</div>
          <input type="date" name="date" hidden min="${ymdOf(addDays(new Date(), 1))}"><small class="preview" data-preview></small></div>
        <p class="form-error wide" data-error></p>
        <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">Kaydet</button></div>
      </form>`,
    });
    const form = $("[data-form]", body);
    const field = name => form.elements.namedItem(name);
    const compute = () => {
      const term = field("term").value;
      if (term === "date") return field("date").value ? endOfDay(field("date").value) : null;
      return endOfDay(ymdOf(addDays(base, Number(term))));
    };
    const update = () => {
      field("date").hidden = field("term").value !== "date";
      const value = compute();
      $("[data-preview]", form).textContent = value ? `Yeni bitiş: ${fmtDate(value)}` : "Bir tarih seçin.";
    };
    form.addEventListener("change", update);
    update();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const expiresAt = compute();
      if (!expiresAt) {
        $("[data-error]", form).textContent = "Bir tarih seçin.";
        return;
      }
      const done = await run($("button[type=submit]", form), () => api("set_trial", { machine: item.machine, expiresAt }), $("[data-error]", form));
      if (done) afterInstallationChange(item.machine, "Deneme süresi güncellendi.");
    });
  }

  function trialStatus(item, status) {
    if (status === "blocked") {
      confirmAction({
        eyebrow: "Denemeyi engelle",
        title: item.officeName || "Adı yazılmamış ofis",
        html: '<p>Program bir sonraki doğrulamada (en geç 12 saat) <b>salt okunur</b> olur: kayıtlar görünür, yeni işlem yapılamaz. Engeli istediğiniz zaman kaldırabilirsiniz.</p>',
        messageLabel: "Programda görünecek açıklama (isteğe bağlı)",
        confirmLabel: "Denemeyi engelle",
        danger: true,
        task: async message => {
          await api("set_trial", { machine: item.machine, status: "blocked", message });
          afterInstallationChange(item.machine, "Deneme engellendi.");
          return true;
        },
      });
    } else {
      confirmAction({
        eyebrow: "Deneme engelini kaldır",
        title: item.officeName || "Adı yazılmamış ofis",
        html: "<p>Program bir sonraki doğrulamada yeniden çalışır.</p>",
        confirmLabel: "Engeli kaldır",
        task: async () => {
          await api("set_trial", { machine: item.machine, status: "active" });
          afterInstallationChange(item.machine, "Deneme engeli kaldırıldı.");
          return true;
        },
      });
    }
  }

  function editInstallation(item) {
    const body = modal.open({
      eyebrow: "Bilgileri düzenle",
      title: item.officeName || "Adı yazılmamış ofis",
      html: `<form class="form-grid" novalidate data-form>
        <label class="field wide"><span>Ofis adı</span><input name="officeName" maxlength="120" value="${esc(item.officeName)}" autofocus></label>
        <label class="field"><span>Yetkili kişi</span><input name="contact" maxlength="120" value="${esc(item.contact)}"></label>
        <label class="field"><span>Telefon</span><input name="phone" type="tel" maxlength="40" value="${esc(item.phone)}"></label>
        <label class="field wide"><span>E-posta</span><input name="email" type="email" maxlength="160" value="${esc(item.email)}"></label>
        <label class="field wide"><span>Not (yalnızca siz görürsünüz)</span><textarea name="note" maxlength="500" rows="3">${esc(item.note)}</textarea></label>
        <p class="form-error wide" data-error></p>
        <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">Kaydet</button></div>
      </form>`,
    });
    const form = $("[data-form]", body);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const value = name => form.elements.namedItem(name).value;
      const done = await run($("button[type=submit]", form), () => api("update_installation", { machine: item.machine, officeName: value("officeName"), contact: value("contact"), phone: value("phone"), email: value("email"), note: value("note") }), $("[data-error]", form));
      if (done) afterInstallationChange(item.machine, "Bilgiler kaydedildi.");
    });
  }

  function forgetInstallation(item) {
    confirmAction({
      eyebrow: "Kişisel bilgileri sil (KVKK)",
      title: item.officeName || "Adı yazılmamış ofis",
      html: `<div class="note bad">Bu ofisin <b>adı, yetkilisi, telefonu, e-postası ve IP adresleri</b> bu kayıttan ve geçmişten silinir. <b>Geri alınamaz.</b></div>
        <p class="muted">Kurulum kodu ve deneme tarihleri kalır; bu bilgisayara yeniden deneme verilmez. Kişi KVKK kapsamında silinmesini istediğinde kullanın. Lisans kaydındaki müşteri bilgileri ayrıca lisansın “Bilgileri düzenle” bölümünden silinir.</p>`,
      confirmLabel: "Kalıcı olarak sil",
      danger: true,
      task: async () => {
        await api("forget_installation", { machine: item.machine });
        afterInstallationChange(item.machine, "Kişisel bilgiler silindi.");
        return true;
      },
    });
  }

  // ---------- Lisanslar ----------
  function licenseRow(license) {
    const status = licenseState(license);
    const where = license.machine ? `${esc(license.installation?.officeName || "Bilgisayar")}<span class="sub mono">${esc(installCode(license.machine))}</span>` : '<span class="sub">Henüz bir bilgisayara bağlı değil</span>';
    return `<button class="row" type="button" data-act="open-license" data-id="${esc(license.id)}">
      <div><b>${esc(license.customer)}</b><span class="sub">${esc([license.contact, license.phone].filter(Boolean).join(" · ") || "—")}</span></div>
      <div><b class="mono">${esc(license.key)}</b><span class="sub">${license.offline ? "İnternetsiz lisans" : "İnternetli lisans"}</span></div>
      <div><span class="pill ${status.tone}">${esc(status.text)}</span><span class="sub">Bitiş: ${esc(expiryText(license))}</span></div>
      <div><b>${where}</b></div>
    </button>`;
  }
  const licenseText = license => lower([license.customer, license.contact, license.phone, String(license.phone || "").replace(/\D/g, ""), license.email, license.key, license.key?.replace(/-/g, ""), license.id, license.machine, installCode(license.machine), license.installation?.officeName, license.note].join(" "));
  async function renderLicenses(content, current) {
    const items = await loadLicenses();
    if (!current()) return;
    content.innerHTML = `
      <div class="page-head">
        <div><h1>Lisanslar</h1><p>Oluşturduğunuz lisans anahtarları. Bir anahtar, programa ilk girildiği bilgisayara bağlanır.</p></div>
        <div class="page-actions"><button class="btn btn-primary" type="button" data-act="new-license">+ Yeni lisans</button></div>
      </div>
      <div class="toolbar">
        <input class="search" type="search" id="licenseSearch" placeholder="Müşteri, anahtar, telefon veya kurulum kodu ile arayın" aria-label="Lisanslarda ara">
        <div class="chips" role="group" aria-label="Süzgeç">${chipsHtml(LICENSE_FILTERS, state.filters.lisanslar, items)}</div>
      </div>
      <div id="licenseList"></div>`;
    const search = $("#licenseSearch", content);
    search.value = state.search.lisanslar;
    const draw = () => {
      const test = LICENSE_FILTERS.find(([key]) => key === state.filters.lisanslar)?.[2] || (() => true);
      const words = lower(state.search.lisanslar).split(/\s+/).filter(Boolean);
      const shown = items.filter(item => test(item) && words.every(word => licenseText(item).includes(word)));
      $("#licenseList", content).innerHTML = shown.length
        ? `<div class="rows cols-lic"><div class="row-head"><div>Müşteri</div><div>Anahtar</div><div>Durum</div><div>Bilgisayar</div></div>${shown.map(licenseRow).join("")}</div>`
        : `<div class="empty">${items.length ? "Aramaya uyan lisans yok." : "Henüz lisans yok. “+ Yeni lisans” ile ilk lisansı oluşturun."}</div>`;
    };
    search.addEventListener("input", () => {
      state.search.lisanslar = search.value;
      draw();
    });
    $$(".chip", content).forEach(chip =>
      chip.addEventListener("click", () => {
        state.filters.lisanslar = chip.dataset.filterKey;
        $$(".chip", content).forEach(other => other.classList.toggle("on", other === chip));
        draw();
      }),
    );
    draw();
  }

  async function openLicense(id) {
    const license = (await loadLicenses().catch(error => (toast(error.message, true), []))).find(entry => entry.id === id);
    if (!license) {
      toast("Lisans bulunamadı.", true);
      return;
    }
    const status = licenseState(license);
    const usable = license.status === "active" && license.state !== "expired";
    const body = modal.open({
      eyebrow: "Lisans",
      title: license.customer,
      html: `
        <div><span class="pill ${status.tone}">${esc(status.text)}</span></div>
        <div class="keybox"><span class="mono">${esc(license.key)}</span><button class="btn btn-primary btn-sm" type="button" data-copy="${esc(license.key)}" data-copy-label="Anahtar kopyalandı">Anahtarı kopyala</button></div>
        <dl class="kv">
          <dt>Bitiş</dt><dd>${esc(expiryText(license))}</dd>
          <dt>Tür</dt><dd>${license.offline ? "İnternetsiz (kodla açılır, uzaktan engellenemez)" : "İnternetli (program 12 saatte bir doğrular)"}</dd>
          <dt>Bilgisayar</dt><dd>${license.machine ? `${esc(license.installation?.officeName || "—")} · <span class="mono">${esc(installCode(license.machine))}</span>` : "Henüz bir bilgisayara bağlı değil"}</dd>
          ${license.activatedAt ? `<dt>Bağlandığı tarih</dt><dd>${esc(fmtDateTime(license.activatedAt))}</dd>` : ""}
          ${license.installation?.lastSeen ? `<dt>Son bağlantı</dt><dd>${esc(ago(license.installation.lastSeen))}</dd>` : ""}
          <dt>Yetkili</dt><dd>${esc(license.contact || "—")}</dd>
          <dt>Telefon</dt><dd>${license.phone ? `<a class="tel" href="tel:${esc(telHref(license.phone))}">${esc(license.phone)}</a>` : "—"}</dd>
          <dt>E-posta</dt><dd>${license.email ? `<a class="tel" href="mailto:${esc(license.email)}">${esc(license.email)}</a>` : "—"}</dd>
          <dt>Oluşturulma</dt><dd>${esc(fmtDateTime(license.createdAt))}</dd>
          <dt>Lisans no</dt><dd class="mono">${esc(license.id)}</dd>
          ${license.message ? `<dt>Engel açıklaması</dt><dd>${esc(license.message)}</dd>` : ""}
          ${license.note ? `<dt>Not</dt><dd>${esc(license.note)}</dd>` : ""}
        </dl>
        <div class="action-grid">
          <button class="btn btn-ghost" type="button" data-do="expiry">Süreyi değiştir</button>
          ${usable ? '<button class="btn btn-ghost" type="button" data-do="code">İnternetsiz kod üret</button>' : ""}
          ${license.status === "blocked" ? '<button class="btn btn-primary" type="button" data-do="unblock">Engeli kaldır</button>' : '<button class="btn btn-danger-ghost" type="button" data-do="block">Engelle</button>'}
          ${license.machine ? '<button class="btn btn-ghost" type="button" data-do="release">Bilgisayardan ayır</button>' : ""}
          <button class="btn btn-ghost" type="button" data-do="edit">Bilgileri düzenle</button>
          ${license.everBound ? "" : '<button class="btn btn-danger-ghost" type="button" data-do="delete">Sil</button>'}
        </div>
        <div class="history"><h3>Geçmiş</h3><div class="timeline" data-history><p class="faint">Yükleniyor…</p></div></div>`,
    });
    body.querySelector(".action-grid").addEventListener("click", event => {
      const action = event.target.closest("[data-do]")?.dataset.do;
      if (action === "expiry") changeExpiry(license);
      else if (action === "code") offlineCode(license);
      else if (action === "block") blockLicense(license);
      else if (action === "unblock") unblockLicense(license);
      else if (action === "release") releaseLicense(license);
      else if (action === "edit") editLicense(license);
      else if (action === "delete") deleteLicense(license);
    });
    loadHistory(body, { licenseId: license.id });
  }

  async function afterLicenseChange(id, message) {
    invalidate();
    toast(message);
    refreshView();
    if (id) await openLicense(id);
    else modal.close(true);
  }

  function termField(options, { dateMin }) {
    return `<div class="choice" role="radiogroup">${options.map(([value, label], index) => `<label><input type="radio" name="term" value="${value}"${index === 0 ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>
      <input type="date" name="date" hidden min="${dateMin}"><small class="preview" data-preview></small>`;
  }

  function changeExpiry(license) {
    const current = license.expiresAt ? new Date(license.expiresAt) : null;
    const base = current && current > new Date() ? current : new Date();
    const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 };
    const body = modal.open({
      eyebrow: "Süreyi değiştir",
      title: license.customer,
      html: `<form class="form-grid" novalidate data-form>
        <p class="wide muted">${current ? `Şu anki bitiş: <b>${esc(fmtDate(license.expiresAt))}</b>.` : "Bu lisans şu an <b>süresiz</b>."} Uzatma, ${current && current > new Date() ? "mevcut bitiş tarihinin" : "bugünün"} üzerine eklenir. Program yeni süreyi bir sonraki doğrulamada (en geç 12 saat) alır.</p>
        <div class="field wide"><span>Yeni süre</span>${termField([["1y", "+1 yıl"], ["6m", "+6 ay"], ["3m", "+3 ay"], ["1m", "+1 ay"], ["forever", "Süresiz"], ["date", "Tarih seç"]], { dateMin: ymdOf(addDays(new Date(), 1)) })}</div>
        ${license.offline ? '<div class="note warn wide">Bu lisans <b>internetsiz</b>: yeni süre programa ancak yeni bir internetsiz kodla ulaşır. Kaydettikten sonra “İnternetsiz kod üret” ile yeni kodu müşteriye gönderin.</div>' : ""}
        <p class="form-error wide" data-error></p>
        <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">Kaydet</button></div>
      </form>`,
    });
    const form = $("[data-form]", body);
    const field = name => form.elements.namedItem(name);
    const compute = () => {
      const term = field("term").value;
      if (term === "forever") return { ok: true, value: null };
      if (term === "date") return field("date").value ? { ok: true, value: endOfDay(field("date").value) } : { ok: false };
      return { ok: true, value: endOfDay(ymdOf(addMonths(base, months[term]))) };
    };
    const update = () => {
      field("date").hidden = field("term").value !== "date";
      const result = compute();
      $("[data-preview]", form).textContent = !result.ok ? "Bir tarih seçin." : result.value ? `Yeni bitiş: ${fmtDate(result.value)}` : "Yeni durum: süresiz";
    };
    form.addEventListener("change", update);
    update();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const result = compute();
      if (!result.ok) {
        $("[data-error]", form).textContent = "Bir tarih seçin.";
        return;
      }
      const done = await run($("button[type=submit]", form), () => api("update_license", { id: license.id, expiresAt: result.value }), $("[data-error]", form));
      if (done) afterLicenseChange(license.id, "Lisans süresi güncellendi.");
    });
  }

  function blockLicense(license) {
    confirmAction({
      eyebrow: "Lisansı engelle",
      title: license.customer,
      html: `<p>Program bir sonraki doğrulamada (en geç 12 saat) <b>salt okunur</b> olur: kayıtlar görünür, yedek alınır; yeni işlem yapılamaz. Engeli istediğiniz zaman kaldırabilirsiniz.</p>
        ${license.offline ? '<div class="note warn">Bu lisans <b>internetsiz</b>: program internete bağlanmıyorsa engel ona ulaşmaz.</div>' : ""}`,
      messageLabel: "Programda görünecek açıklama (isteğe bağlı), örn. “Ödeme bekleniyor.”",
      confirmLabel: "Lisansı engelle",
      danger: true,
      task: async message => {
        await api("set_license_status", { id: license.id, status: "blocked", message });
        afterLicenseChange(license.id, "Lisans engellendi.");
        return true;
      },
    });
  }
  function unblockLicense(license) {
    confirmAction({
      eyebrow: "Engeli kaldır",
      title: license.customer,
      html: "<p>Program bir sonraki doğrulamada yeniden çalışır. Hemen düzelmesi için ofisten <b>Yönetim → Lisans → “Şimdi doğrula”</b>ya basmasını isteyin.</p>",
      confirmLabel: "Engeli kaldır",
      task: async () => {
        await api("set_license_status", { id: license.id, status: "active" });
        afterLicenseChange(license.id, "Lisans engeli kaldırıldı.");
        return true;
      },
    });
  }
  function releaseLicense(license) {
    confirmAction({
      eyebrow: "Bilgisayardan ayır",
      title: license.customer,
      html: `<p>Ofis sunucu bilgisayarını değiştirdiyse kullanılır.</p>
        <div class="note tip"><ol><li>Lisans şu anki bilgisayardan (<span class="mono">${esc(installCode(license.machine))}</span>) ayrılır; o bilgisayar bir sonraki doğrulamada salt okunur olur.</li><li>Aynı anahtar (<span class="mono">${esc(license.key)}</span>) yeni bilgisayarda programa girilerek etkinleştirilir.</li></ol></div>`,
      confirmLabel: "Bilgisayardan ayır",
      task: async () => {
        await api("release_license", { id: license.id });
        afterLicenseChange(license.id, "Lisans bilgisayardan ayrıldı.");
        return true;
      },
    });
  }
  function deleteLicense(license) {
    confirmAction({
      eyebrow: "Lisansı sil",
      title: license.customer,
      html: `<p>Bu anahtar hiç kullanılmadığı için silinebilir: <span class="mono">${esc(license.key)}</span>. Silinen anahtar bir daha çalışmaz.</p>`,
      confirmLabel: "Lisansı sil",
      danger: true,
      task: async () => {
        await api("delete_license", { id: license.id });
        afterLicenseChange(null, "Lisans silindi.");
        return true;
      },
    });
  }
  function editLicense(license) {
    const body = modal.open({
      eyebrow: "Bilgileri düzenle",
      title: license.customer,
      html: `<form class="form-grid" novalidate data-form>
        <label class="field wide"><span>Müşteri / ofis adı <span class="req">*</span></span><input name="customer" maxlength="120" value="${esc(license.customer)}" autofocus></label>
        <label class="field"><span>Yetkili kişi</span><input name="contact" maxlength="120" value="${esc(license.contact)}"></label>
        <label class="field"><span>Telefon</span><input name="phone" type="tel" maxlength="40" value="${esc(license.phone)}"></label>
        <label class="field wide"><span>E-posta</span><input name="email" type="email" maxlength="160" value="${esc(license.email)}"></label>
        <label class="check wide"><input type="checkbox" name="offline"${license.offline ? " checked" : ""}><span><b>İnternetsiz lisans</b><small>Sunucu bilgisayar internete hiç bağlanmıyorsa işaretleyin. Değişiklik programa yeni bir internetsiz kodla ulaşır.</small></span></label>
        <label class="field wide"><span>Not (yalnızca siz görürsünüz)</span><textarea name="note" maxlength="500" rows="3">${esc(license.note)}</textarea></label>
        <p class="form-error wide" data-error></p>
        <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">Kaydet</button></div>
      </form>`,
    });
    const form = $("[data-form]", body);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const value = name => form.elements.namedItem(name).value.trim();
      if (!value("customer")) {
        $("[data-error]", form).textContent = "Müşteri / ofis adını yazın.";
        return;
      }
      const done = await run($("button[type=submit]", form), () => api("update_license", { id: license.id, customer: value("customer"), contact: value("contact"), phone: value("phone"), email: value("email"), note: value("note"), offline: form.elements.namedItem("offline").checked }), $("[data-error]", form));
      if (done) afterLicenseChange(license.id, "Bilgiler kaydedildi.");
    });
  }

  function offlineCode(license) {
    const needsMachine = !license.machine;
    const body = modal.open({
      eyebrow: "İnternetsiz etkinleştirme kodu",
      title: license.customer,
      html: `${license.offline ? "" : '<div class="note warn">Bu lisans <b>internetli</b>: kodla açılan program ilk 7 gün içinde internete bağlanıp doğrulanmalıdır. Sunucu internete hiç bağlanmayacaksa önce lisansın “Bilgileri düzenle” bölümünden <b>İnternetsiz lisans</b>’ı işaretleyin.</div>'}
        <form class="form-grid" novalidate data-form>
          ${needsMachine
            ? '<label class="field wide"><span>Müşterinin kurulum kodu <span class="req">*</span></span><input name="machine" class="mono" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autofocus><small>Müşterinin programında Yönetim → Lisans → “İnternetsiz etkinleştirme” bölümünde yazar. Lisans bu bilgisayara bağlanır.</small></label>'
            : `<div class="field wide"><span>Bilgisayar</span><input class="mono" readonly value="${esc(installCode(license.machine))}"></div>`}
          <p class="form-error wide" data-error></p>
          <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">Kodu üret</button></div>
        </form>`,
    });
    const form = $("[data-form]", body);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      let machine = license.machine;
      if (needsMachine) {
        machine = normalizeCode(form.elements.namedItem("machine").value);
        if (!machine) {
          $("[data-error]", form).textContent = "Kurulum kodu 32 karakter olmalı (8 grup). Kodu eksiksiz yazın.";
          return;
        }
      }
      const result = await run($("button[type=submit]", form), () => api("license_code", { id: license.id, machine }), $("[data-error]", form));
      if (!result) return;
      invalidate();
      refreshView();
      $("#modalBody").innerHTML = `
        <p>Kod, <span class="mono">${esc(installCode(machine))}</span> kurulum kodlu bilgisayar içindir; başka bilgisayarda çalışmaz.</p>
        <textarea class="codebox mono" readonly aria-label="Etkinleştirme kodu">${esc(result.code)}</textarea>
        <div class="modal-actions"><button class="btn btn-ghost" type="button" data-close>Kapat</button><button class="btn btn-primary" type="button" data-copy="${esc(result.code)}" data-copy-label="Kod kopyalandı">Kodu kopyala</button></div>
        <div class="note tip"><b>Müşteri ne yapacak?</b><ol><li>Kodu müşteriye e-posta veya WhatsApp ile gönderin.</li><li>Müşteri programda <b>Yönetim → Lisans → İnternetsiz etkinleştirme</b> bölümündeki <b>Etkinleştirme kodu</b> kutusuna yapıştırır.</li><li><b>Kodu uygula</b>’ya basar; program hemen lisanslı olur.</li></ol></div>`;
      $("#modalBody .codebox").addEventListener("focus", event => event.target.select());
    });
  }

  // Yeni lisans / Lisans ver
  function licenseForm({ installation = null, bindToCode = false } = {}) {
    const fixed = Boolean(installation);
    const body = modal.open({
      eyebrow: fixed ? "Lisans ver" : "Yeni lisans",
      title: fixed ? installation.officeName || "Adı yazılmamış ofis" : "Yeni lisans oluştur",
      html: `<form class="form-grid" novalidate data-form>
        <label class="field wide"><span>Müşteri / ofis adı <span class="req">*</span></span><input name="customer" maxlength="120" value="${esc(installation?.officeName || "")}" autofocus></label>
        <label class="field"><span>Yetkili kişi</span><input name="contact" maxlength="120" value="${esc(installation?.contact || "")}"></label>
        <label class="field"><span>Telefon</span><input name="phone" type="tel" maxlength="40" value="${esc(installation?.phone || "")}"></label>
        <label class="field wide"><span>E-posta</span><input name="email" type="email" maxlength="160" value="${esc(installation?.email || "")}"></label>
        <div class="field wide"><span>Süre</span>${termField([["1y", "1 yıl"], ["2y", "2 yıl"], ["forever", "Süresiz"], ["date", "Tarih seç"]], { dateMin: ymdOf(addDays(new Date(), 1)) })}</div>
        ${fixed
          ? `<div class="field wide"><span>Bilgisayar</span><input class="mono" readonly value="${esc(installCode(installation.machine))}"><small>Lisans bu bilgisayara hemen tanımlanır; müşterinin bir şey yazması gerekmez.</small></div>`
          : `<div class="field wide"><span>Lisans hangi bilgisayar için?</span>
              <div class="radio-list">
                <label><input type="radio" name="bind" value="key"${bindToCode ? "" : " checked"}><span><b>Anahtarı müşteriye vereceğim</b><small>Müşteri anahtarı programa kendisi yazar; lisans o bilgisayara bağlanır.</small></span></label>
                <label><input type="radio" name="bind" value="machine"${bindToCode ? " checked" : ""}><span><b>Kurulum kodunu biliyorum</b><small>Lisans hemen o bilgisayara tanımlanır. Kurulum kodu müşterinin programında Yönetim → Lisans ekranında yazar.</small></span></label>
              </div>
              <input name="machine" class="mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="Kurulum kodu"${bindToCode ? "" : " hidden"}>
            </div>`}
        <label class="check wide"><input type="checkbox" name="offline"><span><b>İnternetsiz lisans</b><small>Yalnızca sunucu bilgisayar internete hiç bağlanmıyorsa işaretleyin. Programa anahtarla değil, internetsiz kodla girilir ve uzaktan engellenemez.</small></span></label>
        <label class="field wide"><span>Not (yalnızca siz görürsünüz)</span><textarea name="note" maxlength="500" rows="2"></textarea></label>
        <p class="form-error wide" data-error></p>
        <div class="modal-actions wide"><button type="button" class="btn btn-ghost" data-close>Vazgeç</button><button type="submit" class="btn btn-primary">${fixed ? "Lisansı ver" : "Lisansı oluştur"}</button></div>
      </form>`,
    });
    const form = $("[data-form]", body);
    const field = name => form.elements.namedItem(name);
    const compute = () => {
      const term = field("term").value;
      if (term === "forever") return { ok: true, value: null };
      if (term === "date") return field("date").value ? { ok: true, value: endOfDay(field("date").value) } : { ok: false };
      return { ok: true, value: endOfDay(ymdOf(addMonths(new Date(), term === "2y" ? 24 : 12))) };
    };
    const update = () => {
      field("date").hidden = field("term").value !== "date";
      if (!fixed) field("machine").hidden = field("bind").value !== "machine";
      const result = compute();
      $("[data-preview]", form).textContent = !result.ok ? "Bir tarih seçin." : result.value ? `Bitiş: ${fmtDate(result.value)}` : "Süresiz lisans";
    };
    form.addEventListener("change", update);
    update();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const error = $("[data-error]", form);
      const customer = field("customer").value.trim();
      if (!customer) {
        error.textContent = "Müşteri / ofis adını yazın.";
        field("customer").focus();
        return;
      }
      const term = compute();
      if (!term.ok) {
        error.textContent = "Bitiş için bir tarih seçin.";
        return;
      }
      let machine = fixed ? installation.machine : null;
      if (!fixed && field("bind").value === "machine") {
        machine = normalizeCode(field("machine").value);
        if (!machine) {
          error.textContent = "Kurulum kodu 32 karakter olmalı (8 grup). Müşterinin programında Yönetim → Lisans ekranında yazar.";
          field("machine").focus();
          return;
        }
      }
      const result = await run($("button[type=submit]", form), () => api("create_license", {
        customer,
        contact: field("contact").value.trim(),
        phone: field("phone").value.trim(),
        email: field("email").value.trim(),
        note: field("note").value.trim(),
        expiresAt: term.value,
        offline: field("offline").checked,
        machine,
      }), error);
      if (!result) return;
      invalidate();
      refreshView();
      showLicenseCreated(result.license);
    });
  }

  function showLicenseCreated(license) {
    const bound = Boolean(license.machine);
    const message = bound
      ? `Destek Ofis lisansınız tanımlandı. Programda Yönetim → Lisans bölümündeki "Şimdi doğrula" düğmesine basmanız yeterli (en geç 12 saat içinde kendiliğinden de geçer).\nLisans anahtarınız (program yeniden kurulursa gerekir): ${license.key}\nSorunuz olursa: ${SUPPORT_PHONE}`
      : `Destek Ofis lisans anahtarınız: ${license.key}\nProgramda Yönetim → Lisans bölümündeki "Lisans anahtarı" kutusuna yazıp "Lisansı etkinleştir" düğmesine basın.\nSorunuz olursa: ${SUPPORT_PHONE}`;
    const body = modal.open({
      eyebrow: "Lisans hazır",
      title: license.customer,
      html: `
        <div class="keybox"><span class="mono">${esc(license.key)}</span><button class="btn btn-primary btn-sm" type="button" data-copy="${esc(license.key)}" data-copy-label="Anahtar kopyalandı">Anahtarı kopyala</button></div>
        ${license.offline
          ? `<div class="note warn"><b>İnternetsiz lisans.</b> Programa anahtarla değil, internetsiz etkinleştirme koduyla girilir. ${bound ? "Kodu şimdi üretebilirsiniz." : "Kod üretmek için müşterinin kurulum kodu gerekir."}</div>`
          : bound
            ? `<div class="note tip"><b>Lisans bu bilgisayara tanımlandı (<span class="mono">${esc(installCode(license.machine))}</span>).</b> Program internete bağlıysa en geç 12 saat içinde kendiliğinden lisanslı olur. Hemen geçmesi için müşteriden programda <b>Yönetim → Lisans → “Şimdi doğrula”</b> düğmesine basmasını isteyin. Anahtarı da saklayın: program yeniden kurulursa bu anahtar girilir.</div>`
            : '<div class="note tip">Bu anahtarı müşteriye iletin. Müşteri programda <b>Yönetim → Lisans</b> bölümündeki <b>Lisans anahtarı</b> kutusuna yazıp <b>Lisansı etkinleştir</b>’e basar. Anahtar, ilk girildiği bilgisayara bağlanır.</div>'}
        <div class="modal-actions">
          ${license.offline ? "" : `<button class="btn btn-ghost" type="button" data-copy="${esc(message)}" data-copy-label="Mesaj kopyalandı">Müşteriye mesajı kopyala</button>`}
          <button class="btn btn-ghost" type="button" data-do="open">Lisansı aç</button>
          ${license.offline ? '<button class="btn btn-primary" type="button" data-do="code">İnternetsiz kod üret</button>' : '<button class="btn btn-primary" type="button" data-close>Tamam</button>'}
        </div>`,
    });
    $(".modal-actions", body).addEventListener("click", event => {
      const action = event.target.closest("[data-do]")?.dataset.do;
      if (action === "open") openLicense(license.id);
      else if (action === "code") offlineCode(license);
    });
  }

  // ---------- Hareketler ----------
  async function renderEvents(content, current) {
    const items = (await api("events", { limit: 500 })).items;
    if (!current()) return;
    content.innerHTML = `
      <div class="page-head"><div><h1>Hareketler</h1><p>Denemeler, lisans işlemleri, uyarılar ve operatör girişleri. En yeni en üstte.</p></div></div>
      <div class="toolbar"><div class="chips" role="group" aria-label="Süzgeç">${chipsHtml(EVENT_FILTERS, state.filters.hareketler, items)}</div></div>
      <section class="card"><div class="timeline" id="eventList"></div></section>`;
    const draw = () => {
      const test = EVENT_FILTERS.find(([key]) => key === state.filters.hareketler)?.[2] || (() => true);
      const shown = items.filter(test);
      $("#eventList", content).innerHTML = shown.length ? shown.map(eventRow).join("") : '<p class="faint">Bu süzgece uyan hareket yok.</p>';
    };
    $$(".chip", content).forEach(chip =>
      chip.addEventListener("click", () => {
        state.filters.hareketler = chip.dataset.filterKey;
        $$(".chip", content).forEach(other => other.classList.toggle("on", other === chip));
        draw();
      }),
    );
    draw();
  }

  // ---------- Ayarlar ----------
  async function renderSettings(content, current) {
    if (!state.session) state.session = (await api("me")).session;
    if (!current()) return;
    content.innerHTML = `
      <div class="page-head"><div><h1>Ayarlar</h1><p>Operatör parolası ve lisans servisinin durumu.</p></div></div>
      <div class="settings-grid">
        <section class="card">
          <h2>Parolayı değiştir</h2>
          <p class="muted">Yeni parola en az 8 karakter olmalı. Değiştirince diğer cihazlardaki oturumlar kapanır; bu oturum açık kalır.</p>
          <form id="passwordForm" novalidate>
            <label class="field"><span>Mevcut parola</span><input type="password" name="current" autocomplete="current-password"></label>
            <label class="field"><span>Yeni parola</span><input type="password" name="next" autocomplete="new-password" minlength="8"></label>
            <label class="field"><span>Yeni parola (tekrar)</span><input type="password" name="again" autocomplete="new-password" minlength="8"></label>
            <p class="form-error" data-error></p>
            <div><button class="btn btn-primary" type="submit">Parolayı değiştir</button></div>
          </form>
        </section>
        <section class="card">
          <h2>Lisans servisi</h2>
          <div class="status-list" id="serviceStatus"><p class="faint">Denetleniyor…</p></div>
          <div class="note">Programlar lisans servisine şu adresten bağlanır:<br><span class="mono">${esc(location.origin)}/api/lisans</span></div>
          <p class="muted">Bu oturum ${esc(fmtDateTime(state.session?.expiresAt))} tarihinde kendiliğinden kapanır.</p>
        </section>
      </div>`;
    const form = $("#passwordForm", content);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const value = name => form.elements.namedItem(name).value;
      const error = $("[data-error]", form);
      if (value("next").length < 8) {
        error.textContent = "Yeni parola en az 8 karakter olmalı.";
        return;
      }
      if (value("next") !== value("again")) {
        error.textContent = "Yeni parolalar aynı değil.";
        return;
      }
      const done = await run($("button[type=submit]", form), () => api("change_password", { current: value("current"), next: value("next") }), error);
      if (done) {
        form.reset();
        toast("Parola değiştirildi.");
      }
    });
    const box = $("#serviceStatus", content);
    try {
      const status = await (await fetch("/api/lisans/v1/durum", { cache: "no-store" })).json();
      const line = (label, ok, text) => `<div><span>${esc(label)}</span><span class="pill ${ok ? "ok" : "bad"}">${esc(text)}</span></div>`;
      box.innerHTML = [
        line("Lisans servisi", status.ok, status.ok ? "Çalışıyor" : "Sorun var"),
        line("İmza anahtarı", status.signer, status.signer ? `Yüklü (${status.keyId})` : "Yüklenemedi"),
        line("Veritabanı", status.db, status.db ? "Bağlı" : "Ulaşılamıyor"),
      ].join("");
    } catch {
      box.innerHTML = '<p class="form-error">Servis durumu alınamadı.</p>';
    }
  }

  // ---------- Açılış ----------
  (async () => {
    try {
      state.session = (await api("me", {}, {}, { quiet: true })).session;
      showApp();
    } catch {
      showLogin();
    }
  })();
})();
