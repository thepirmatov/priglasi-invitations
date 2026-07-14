const EVENT_TYPE_LABELS = {
  wedding: 'Той',
  kyzUzatuu: 'Кыз узатуу',
};

const MONTHS_KY = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

let countdownIntervalId = null;

function applyColorTheme(colorTheme = {}) {
  const root = document.documentElement;
  if (colorTheme.primary) root.style.setProperty('--color-primary', colorTheme.primary);
  if (colorTheme.accent) root.style.setProperty('--color-accent', colorTheme.accent);
  if (colorTheme.background) root.style.setProperty('--color-background', colorTheme.background);
}

// Optional: a couple's own photo behind their names. Templates that support
// this opt in via a `.hero.has-photo` CSS block; the gradient overlay keeps
// white hero text readable regardless of how bright the source photo is.
function applyHeroPhoto(heroPhotoUrl) {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  if (heroPhotoUrl) {
    hero.style.backgroundImage = `linear-gradient(to bottom, rgba(0,0,0,0.2), rgba(0,0,0,0.6)), url("${heroPhotoUrl}")`;
    hero.classList.add('has-photo');
  } else {
    hero.style.backgroundImage = '';
    hero.classList.remove('has-photo');
  }
}

// "Азамат & Жасмина" -> "А & Ж". Used by monogram-style templates
// (initials-frame, envelope-seal) that lead with initials instead of full names.
function getInitials(coupleNames) {
  if (!coupleNames) return '';
  return coupleNames
    .split('&')
    .map((part) => part.trim().charAt(0).toUpperCase())
    .filter(Boolean)
    .join(' & ');
}

let revealGateInitialized = false;
// Opt-in "open to reveal" interaction (envelope-seal's wax seal, etc.): the
// template marks its cover screen with #reveal-gate; clicking it reveals the
// rest of the page and - since a real user gesture just happened - is also
// the one safe moment to autoplay the background music (browsers block
// autoplay without a preceding user gesture).
function setupRevealGate() {
  const gate = document.getElementById('reveal-gate');
  if (!gate || revealGateInitialized) return;
  revealGateInitialized = true;

  gate.addEventListener('click', () => {
    gate.classList.add('revealed');
    setTimeout(() => {
      gate.style.display = 'none';
    }, 700);

    const audio = document.getElementById('bg-music');
    const musicToggle = document.getElementById('music-toggle');
    if (audio && audio.src) {
      audio.play().then(() => musicToggle && musicToggle.classList.add('playing')).catch(() => {});
    }
  }, { once: true });
}

function formatDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS_KY[month - 1]}, ${year}`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderStaticContent(config) {
  setText('event-type', EVENT_TYPE_LABELS[config.eventType] || '');
  setText('couple-names', config.coupleNames || '');
  setText('couple-initials', getInitials(config.coupleNames));
  if (config.date && config.time) {
    setText('event-date', `${formatDate(config.date)} · ${config.time}`);
  }

  setText('venue-name', config.venueName || '');
  setText('venue-address', config.venueAddress || '');
  const mapLink = document.getElementById('map-link');
  if (mapLink) mapLink.href = config.mapUrl || '#';

  const scheduleList = document.getElementById('schedule-list');
  if (scheduleList) {
    scheduleList.innerHTML = '';
    (config.schedule || []).forEach((item) => {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = item.time;
      const label = document.createElement('span');
      label.textContent = item.label;
      li.append(time, label);
      scheduleList.appendChild(li);
    });
  }

  setText('dress-code-text', config.dressCode || '');
}

function startCountdown(dateStr, timeStr) {
  const el = document.getElementById('countdown');
  if (!el || !dateStr || !timeStr) return;

  if (countdownIntervalId) clearInterval(countdownIntervalId);
  const target = new Date(`${dateStr}T${timeStr}:00`);

  function tick() {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      el.textContent = 'Той башталды!';
      clearInterval(countdownIntervalId);
      return;
    }
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);
    const seconds = Math.floor((diff / 1000) % 60);

    el.innerHTML = '';
    [
      [days, 'күн'],
      [hours, 'саат'],
      [minutes, 'мүнөт'],
      [seconds, 'секунд'],
    ].forEach(([value, label]) => {
      const unit = document.createElement('div');
      unit.innerHTML = `${value}<span>${label}</span>`;
      el.appendChild(unit);
    });
  }

  tick();
  countdownIntervalId = setInterval(tick, 1000);
}

let musicInitialized = false;
function setupMusic(musicUrl) {
  const audio = document.getElementById('bg-music');
  const toggle = document.getElementById('music-toggle');
  if (!audio || !toggle) return;

  if (!musicUrl) {
    toggle.style.display = 'none';
    return;
  }
  toggle.style.display = '';
  if (audio.src !== musicUrl) {
    audio.pause();
    audio.src = musicUrl;
    toggle.classList.remove('playing');
  }

  if (!musicInitialized) {
    musicInitialized = true;
    toggle.addEventListener('click', () => {
      if (audio.paused) {
        audio.play();
        toggle.classList.add('playing');
      } else {
        audio.pause();
        toggle.classList.remove('playing');
      }
    });
  }
}

let rsvpInitialized = false;
function setupRsvpForm(telegramChatId, rsvpEndpoint) {
  const form = document.getElementById('rsvp-form');
  if (!form) return;
  form.dataset.telegramChatId = telegramChatId || '';
  // Every deployed invitation lives on its own separate Netlify site (see
  // deploy-site-background.js) and does not carry its own copy of rsvp.js,
  // so this must point back at the main storefront site's function unless
  // explicitly overridden.
  form.dataset.rsvpEndpoint = rsvpEndpoint || '/.netlify/functions/rsvp';

  if (rsvpInitialized) return;
  rsvpInitialized = true;

  const status = document.getElementById('rsvp-status');
  const submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const guestName = form.guestName.value.trim();
    const attendance = form.attendance.value;
    if (!guestName || !attendance) return;

    submitButton.disabled = true;
    status.textContent = 'Жөнөтүлүүдө...';

    try {
      const response = await fetch(form.dataset.rsvpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramChatId: form.dataset.telegramChatId, guestName, attendance }),
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      status.textContent = 'Рахмат! Жообуңуз жөнөтүлдү.';
      form.reset();
    } catch (err) {
      status.textContent = 'Ката кетти, кайра аракет кылыңыз.';
    } finally {
      submitButton.disabled = false;
    }
  });
}

// Populates the page from a config object. Safe to call repeatedly with
// partial/updated configs (standalone deployed sites call it once from
// fetched config.json; the wizard's live preview iframe calls it on every
// field change via postMessage) - this is the single source of truth for
// what an invitation looks like, so the preview always matches the deploy.
function render(config) {
  applyColorTheme(config.colorTheme);
  applyHeroPhoto(config.heroPhotoUrl);
  renderStaticContent(config);
  startCountdown(config.date, config.time);
  setupMusic(config.musicUrl);
  setupRsvpForm(config.telegramChatId, config.rsvpEndpoint);
  setupRevealGate();
}

window.TemplateCore = { render };

// Standalone mode: a real deployed invitation site has its own config.json
// next to index.html. Preview mode (embedded in the wizard's iframe) skips
// this and waits for postMessage instead.
if (window.self === window.top) {
  fetch('config.json')
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load config.json: ${res.status}`);
      return res.json();
    })
    .then(render)
    .catch((err) => {
      console.error(err);
      const main = document.querySelector('main');
      if (main) main.innerHTML = '<p>Чакырууну жүктөөдө ката кетти.</p>';
    });
} else {
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'PREVIEW_CONFIG') {
      render(event.data.config);
    }
  });
}
