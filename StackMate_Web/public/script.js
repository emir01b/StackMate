'use strict';

/* ══════════════════════════════════════════════════════════════════════
   1. CANVAS PARTICLE SYSTEM
══════════════════════════════════════════════════════════════════════ */
(function initCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  const mouse = { x: -9999, y: -9999 };
  const COUNT = 100;
  const MAX_DIST = 130;
  const MOUSE_RADIUS = 200;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function Particle() {
    this.reset();
  }
  Particle.prototype.reset = function() {
    this.x     = Math.random() * W;
    this.y     = Math.random() * H;
    this.vx    = (Math.random() - 0.5) * 0.45;
    this.vy    = (Math.random() - 0.5) * 0.45;
    this.r     = Math.random() * 1.6 + 0.4;
    this.alpha = Math.random() * 0.45 + 0.15;
  };
  Particle.prototype.update = function() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > W) this.vx *= -1;
    if (this.y < 0 || this.y > H) this.vy *= -1;

    const dx = this.x - mouse.x;
    const dy = this.y - mouse.y;
    const dist = Math.hypot(dx, dy);
    if (dist < MOUSE_RADIUS) {
      const f = (1 - dist / MOUSE_RADIUS) * 0.5;
      this.vx += (dx / dist) * f;
      this.vy += (dy / dist) * f;
    }
    const spd = Math.hypot(this.vx, this.vy);
    if (spd > 1.8) { this.vx = (this.vx / spd) * 1.8; this.vy = (this.vy / spd) * 1.8; }
  };
  Particle.prototype.draw = function() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,122,204,${this.alpha})`;
    ctx.fill();
  };

  function build() { particles = Array.from({ length: COUNT }, () => new Particle()); }

  function drawLines() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const d = Math.hypot(particles[i].x - particles[j].x, particles[i].y - particles[j].y);
        if (d < MAX_DIST) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0,122,204,${(1 - d / MAX_DIST) * 0.16})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  function loop() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    drawLines();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => { resize(); build(); });
  window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  window.addEventListener('mouseleave', () => { mouse.x = -9999; mouse.y = -9999; });
  resize(); build(); loop();
})();


/* ══════════════════════════════════════════════════════════════════════
   2. NAVBAR SCROLL
══════════════════════════════════════════════════════════════════════ */
(function initNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  let ticking = false;
  const check = () => { nav.classList.toggle('scrolled', window.scrollY > 20); ticking = false; };
  window.addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(check); ticking = true; } });
})();


/* ══════════════════════════════════════════════════════════════════════
   3. AOS SCROLL ANIMATIONS
══════════════════════════════════════════════════════════════════════ */
(function initAOS() {
  const els = document.querySelectorAll('[data-aos]');
  function check() {
    els.forEach(el => {
      if (el.classList.contains('aos-animate')) return;
      if (el.getBoundingClientRect().top < window.innerHeight - 50) {
        const delay = parseInt(el.dataset.aosDelay || 0, 10);
        setTimeout(() => el.classList.add('aos-animate'), delay);
      }
    });
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  check();
})();


/* ══════════════════════════════════════════════════════════════════════
   4. ANIMATED STAT COUNTERS
══════════════════════════════════════════════════════════════════════ */
(function initCounters() {
  const nums = document.querySelectorAll('.stat-num[data-count]');
  let done = false;
  function run() {
    if (done) return;
    let allVisible = true;
    nums.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top >= window.innerHeight) { allVisible = false; return; }
      if (el.dataset.animated) return;
      el.dataset.animated = '1';
      const target = parseInt(el.dataset.count, 10);
      if (target === 0) { el.textContent = '0'; return; }
      let cur = 0;
      const step = Math.max(1, Math.ceil(target / 45));
      const iv = setInterval(() => {
        cur = Math.min(cur + step, target);
        el.textContent = cur;
        if (cur >= target) clearInterval(iv);
      }, 28);
    });
    if (allVisible) done = true;
  }
  window.addEventListener('scroll', run, { passive: true });
  run();
})();


/* ══════════════════════════════════════════════════════════════════════
   5. SMOOTH ANCHOR SCROLL
══════════════════════════════════════════════════════════════════════ */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id     = a.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!id || !target) return;
    e.preventDefault();
    window.scrollTo({ top: target.offsetTop - 68, behavior: 'smooth' });
  });
});


/* ══════════════════════════════════════════════════════════════════════
   6. CURSOR GLOW TRAIL
══════════════════════════════════════════════════════════════════════ */
(function initCursorGlow() {
  const g = document.createElement('div');
  g.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;width:360px;height:360px;border-radius:50%;background:radial-gradient(circle,rgba(0,122,204,0.055) 0%,transparent 70%);transform:translate(-50%,-50%);will-change:left,top;transition:left .1s ease,top .1s ease;';
  document.body.appendChild(g);
  let rx = -999, ry = -999;
  window.addEventListener('mousemove', e => { rx = e.clientX; ry = e.clientY; });
  (function tick() { g.style.left = rx + 'px'; g.style.top = ry + 'px'; requestAnimationFrame(tick); })();
})();


/* ══════════════════════════════════════════════════════════════════════
   7. FEATURE CARD HOVER SHIMMER
══════════════════════════════════════════════════════════════════════ */
document.querySelectorAll('.feature-card').forEach(card => {
  card.addEventListener('mousemove', e => {
    const rect = card.getBoundingClientRect();
    const x    = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
    const y    = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);
    card.style.setProperty('--mx', x + '%');
    card.style.setProperty('--my', y + '%');
  });
});
