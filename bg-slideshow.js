/* ============================================================
   bg-slideshow.js
   Full-bleed destination background. Crossfades + slow Ken Burns
   zoom between high-res Unsplash photos every 15 seconds.

   Swap the IMAGES list to change destinations. Each entry is a
   remote Unsplash URL; a dark gradient backdrop (.bg-backdrop)
   sits on top so the interface stays legible.
   ============================================================ */

(() => {
  const IMAGES = [
    "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=2400&q=80", // Paris
    "https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?auto=format&fit=crop&w=2400&q=80", // Venice
    "https://images.unsplash.com/photo-1538970272646-f61fabb3a8a2?auto=format&fit=crop&w=2400&q=80", // Santorini
    "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=2400&q=80", // Tokyo
    "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=2400&q=80", // Dubai
    "https://images.unsplash.com/photo-1533929736458-ca588d08c8be?auto=format&fit=crop&w=2400&q=80", // London
    "https://images.unsplash.com/photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=2400&q=80"  // Paris street
  ];

  const INTERVAL_MS = 15000;

  const root = document.getElementById("bgSlideshow");
  if (!root) return;

  const slides = IMAGES.map((url, i) => {
    const slide = document.createElement("div");
    slide.className = "bg-slide";
    slide.style.backgroundImage = `url("${url}")`;
    if (i === 0) slide.classList.add("active");
    root.appendChild(slide);
    // Preload so the crossfade has the image ready.
    const img = new Image();
    img.src = url;
    return slide;
  });

  if (slides.length <= 1) return;

  let index = 0;
  setInterval(() => {
    const current = slides[index];
    index = (index + 1) % slides.length;
    const next = slides[index];
    // Restart the Ken Burns zoom on the incoming slide.
    next.classList.remove("active");
    void next.offsetWidth; // force reflow so the animation replays
    current.classList.remove("active");
    next.classList.add("active");
  }, INTERVAL_MS);
})();
