(() => {
  const root = document.documentElement;

  // Tema: kayıtlı tercih > sistem tercihi
  const stored = (() => { try { return localStorage.getItem("do-theme"); } catch { return null; } })();
  if (stored) root.dataset.theme = stored;
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("do-theme", root.dataset.theme); } catch {}
  });

  // Mobil menü
  const menuBtn = document.getElementById("menuBtn");
  const links = document.getElementById("navLinks");
  menuBtn?.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  links?.querySelectorAll("a").forEach(a => a.addEventListener("click", () => {
    links.classList.remove("open");
    menuBtn?.setAttribute("aria-expanded", "false");
  }));

  // Kaydırınca menüye gölge
  const nav = document.querySelector(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Demo indirme bağlantısı henüz hazır değil
  const toast = document.getElementById("toast");
  let timer;
  document.querySelectorAll("[data-soon]").forEach(el => el.addEventListener("click", e => {
    e.preventDefault();
    toast.textContent = "Demo sürümü çok yakında burada olacak. Hemen denemek için bizi arayın: 0532 605 05 87";
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove("show"), 3200);
  }));

  // Görünür olunca yumuşak giriş
  const items = document.querySelectorAll(".card, .section-head, .statement h2, .numbers > div, .download, .trust-list li");
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach(el => el.classList.add("reveal"));
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    items.forEach(el => io.observe(el));
  }

  document.getElementById("year").textContent = new Date().getFullYear();
})();
