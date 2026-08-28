const STEP_COUNT = 8;
const MAX_COLLAGE_PHOTOS = 15;
// A raw MP3 people actually upload (not link) is much bigger than a compressed
// photo and can't be shrunk the same way (no simple "resize dimensions" trick
// for audio), so it gets its own explicit cap - clearly enforced up front
// rather than only failing later at the total-payload check below.
const MAX_MUSIC_BYTES = 4 * 1024 * 1024;
// Netlify Functions cap synchronous request bodies at 6MB; order.js is synchronous
// (it notifies Telegram inline), so the whole JSON payload - hero photo, every
// collage photo, and the music file, all base64 (~33% bigger than raw) - has to
// fit under that with margin to spare.
const MAX_PAYLOAD_BYTES = 5.5 * 1024 * 1024;
// Forces a fresh image fetch each page load instead of a stale cached PNG
// from before a template's screenshot was regenerated.
const CACHE_BUST = Date.now();

// Empty string means "same origin" (today's setup: storefront and functions
// both served from this Netlify site) - fill in the functions' own origin
// (e.g. "https://priglasi.netlify.app", no trailing slash) once the storefront
// moves to a separate host, and set the matching STOREFRONT_ORIGIN in
// order.js's environment (see README) so it accepts requests from there.
const FUNCTIONS_ORIGIN = '';

const state = {
  category: null,
  types: [],
  templatesInCategory: [],
  selectedTemplateId: null,
  selectedTemplateDefaults: null,
  currentStep: 0,
  schedule: [{ time: '', label: '' }],
  collagePhotos: [],
  previewReady: false,
};

// Resizes+recompresses an uploaded photo client-side (long edge capped at
// maxDimension, re-encoded as JPEG) before turning it into a data URL. Keeps
// a phone-camera photo (often 4-8MB) down to a couple hundred KB so it fits
// comfortably in a Netlify Function request body and a Blobs record, with no
// separate file-storage/CDN backend needed.
function compressImageFile(file, maxDimension = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDimension) {
          height = Math.round(height * (maxDimension / width));
          width = maxDimension;
        } else if (height >= width && height > maxDimension) {
          width = Math.round(width * (maxDimension / height));
          height = maxDimension;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Image failed to decode'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File failed to read'));
    reader.readAsDataURL(file);
  });
}

// Plain FileReader wrapper, no re-encoding - unlike photos, an audio file
// can't be shrunk with a simple canvas resize, so MAX_MUSIC_BYTES above is
// the only size control (enforced by the caller before this even runs).
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File failed to read'));
    reader.readAsDataURL(file);
  });
}

const screens = {
  category: document.getElementById('screen-category'),
  carousel: document.getElementById('screen-carousel'),
  wizard: document.getElementById('screen-wizard'),
  confirmation: document.getElementById('screen-confirmation'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.back;
    const map = { 'screen-category': 'category', 'screen-carousel': 'carousel' };
    showScreen(map[target]);
  });
});

// --- Screen 1: category ---

document.querySelectorAll('.category-card').forEach((card) => {
  card.addEventListener('click', async () => {
    state.category = card.dataset.category;
    try {
      await loadCarousel();
      showScreen('carousel');
    } catch (err) {
      console.error(err);
      alert('Каталог жүктөлгөн жок. Барак туура серверден ачылганын текшериңиз (file:// эмес).');
    }
  });
});

// --- Screen 2: carousel ---
//
// One long scrolling page: a sticky nav of type tabs (Classic, Envelope, ...)
// that jump to an in-page section, each section holding its own mini carousel
// that auto-rotates through that type's templates 3-at-a-time. Tapping a card
// reveals a "Select" (-> wizard) / "View" (-> template in a new tab) overlay.

const typeNav = document.getElementById('type-nav');
const typeSectionsContainer = document.getElementById('type-sections');
const ROTATE_INTERVAL_MS = 2000;
const ROTATE_RESUME_DELAY_MS = 4000;
let rotators = [];

async function loadCarousel() {
  const res = await fetch('../catalog/templates.json');
  const catalog = await res.json();
  state.types = catalog.types;
  state.templatesInCategory = catalog.templates.filter((t) => t.categories.includes(state.category));

  const availableTypeIds = [...new Set(state.templatesInCategory.map((t) => t.type))];
  const availableTypes = state.types.filter((t) => availableTypeIds.includes(t.id));

  renderTypeSections(availableTypes);
}

function stopAllRotators() {
  rotators.forEach((r) => {
    clearInterval(r.timerId);
    clearTimeout(r.resumeTimeoutId);
  });
  rotators = [];
}

function renderTypeSections(availableTypes) {
  stopAllRotators();
  typeNav.innerHTML = '';
  typeSectionsContainer.innerHTML = '';

  // Only show the sticky type nav when this category actually spans more than
  // one type - kyz uzatuu today is all "classic", so it's just one section.
  typeNav.classList.toggle('hidden', availableTypes.length <= 1);

  availableTypes.forEach((type) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'type-tab';
    tab.textContent = type.label;
    tab.addEventListener('click', () => {
      const section = document.getElementById(`type-${type.id}`);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    typeNav.appendChild(tab);

    const templates = state.templatesInCategory.filter((t) => t.type === type.id);
    if (!templates.length) return;

    const section = document.createElement('section');
    section.className = 'type-section';
    section.id = `type-${type.id}`;

    const heading = document.createElement('h2');
    heading.textContent = type.label;
    section.appendChild(heading);

    const track = document.createElement('div');
    track.className = 'mini-carousel-track';
    templates.forEach((tpl) => track.appendChild(buildMiniCarouselCard(tpl)));
    section.appendChild(track);

    typeSectionsContainer.appendChild(section);

    if (templates.length > 3) rotators.push(createRotator(track, templates.length));
  });
}

function buildMiniCarouselCard(tpl) {
  const card = document.createElement('div');
  card.className = 'mini-carousel-card';
  card.dataset.templateId = tpl.id;
  card.innerHTML = `
    <img src="../catalog/${tpl.screenshot}?v=${CACHE_BUST}" alt="${tpl.name}" />
    <span class="mini-carousel-card-name">${tpl.name}</span>
  `;

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'card-action card-action-select';
  selectBtn.textContent = 'Тандоо';
  selectBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    selectTemplateAndProceed(tpl.id);
  });

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'card-action card-action-view';
  viewBtn.textContent = 'Көрүү';
  viewBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    window.open(`../templates/${tpl.id}/index.html`, '_blank', 'noopener');
  });

  overlay.append(selectBtn, viewBtn);
  card.appendChild(overlay);
  card.addEventListener('click', () => toggleCardOverlay(card));

  return card;
}

function findRotatorForCard(card) {
  return rotators.find((r) => r.track.contains(card));
}

function closeAllCardOverlays(exceptCard) {
  document.querySelectorAll('.mini-carousel-card.revealed').forEach((card) => {
    if (card === exceptCard) return;
    card.classList.remove('revealed');
    const rotator = findRotatorForCard(card);
    if (rotator) scheduleResume(rotator);
  });
}

function toggleCardOverlay(card) {
  const willReveal = !card.classList.contains('revealed');
  closeAllCardOverlays();
  card.classList.toggle('revealed', willReveal);
  const rotator = findRotatorForCard(card);
  if (!rotator) return;
  if (willReveal) pauseRotator(rotator);
  else scheduleResume(rotator);
}

// Tapping anywhere outside a card (including scrolling the page) closes any
// open overlay instead of leaving it stuck open over a card that's rotated away.
document.addEventListener('click', (event) => {
  if (!event.target.closest('.mini-carousel-card')) closeAllCardOverlays();
});

function createRotator(track, count) {
  const rotator = { track, count, cursor: 0, timerId: null, resumeTimeoutId: null };

  const tick = () => {
    rotator.cursor = (rotator.cursor + 1) % count;
    const firstCard = track.children[0];
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = firstCard ? firstCard.getBoundingClientRect().width + gap : track.clientWidth / 3;
    track.scrollTo({ left: rotator.cursor * step, behavior: 'smooth' });
  };
  rotator.start = () => {
    if (rotator.timerId) return;
    rotator.timerId = setInterval(tick, ROTATE_INTERVAL_MS);
  };
  rotator.start();

  // Pause auto-rotation while the customer is actually touching/dragging the
  // row, and resume a few seconds after they let go (unless a card's overlay
  // is open, in which case toggleCardOverlay/closeAllCardOverlays own the resume).
  track.addEventListener('pointerdown', () => pauseRotator(rotator));
  track.addEventListener('pointerup', () => {
    if (!track.querySelector('.mini-carousel-card.revealed')) scheduleResume(rotator);
  });

  return rotator;
}

function pauseRotator(rotator) {
  clearInterval(rotator.timerId);
  rotator.timerId = null;
  clearTimeout(rotator.resumeTimeoutId);
}

function scheduleResume(rotator) {
  clearTimeout(rotator.resumeTimeoutId);
  rotator.resumeTimeoutId = setTimeout(() => {
    if (!rotator.track.querySelector('.mini-carousel-card.revealed')) rotator.start();
  }, ROTATE_RESUME_DELAY_MS);
}

async function selectTemplateAndProceed(templateId) {
  state.selectedTemplateId = templateId;
  try {
    const res = await fetch(`../templates/${templateId}/config.example.json`);
    state.selectedTemplateDefaults = await res.json();
  } catch (err) {
    console.error(err);
    alert('Шаблон жүктөлгөн жок. Барак туура серверден ачылганын текшериңиз (file:// эмес).');
    return;
  }

  state.currentStep = 0;
  state.schedule = [{ time: '', label: '' }];
  state.collagePhotos = [];
  renderScheduleRows();
  renderCollagePreviews();
  clearWizardFields();
  document.getElementById('field-heroPhoto-file').value = '';
  document.getElementById('field-collagePhotos-file').value = '';
  document.getElementById('field-music-file').value = '';
  setMusicPreview('');
  // Pre-fill with the template's own demo photo so the live preview matches
  // what the carousel just showed - otherwise the preview looks broken the
  // moment the customer arrives. Stripped back out at submit time unless the
  // customer replaces it with their own upload (see wizard-submit below).
  // File inputs can't be pre-filled programmatically, so this only sets the
  // hidden value + thumbnail, not the file picker itself.
  const demoPhotoUrl = state.selectedTemplateDefaults.heroPhotoUrl || '';
  document.getElementById('field-heroPhotoUrl').value = demoPhotoUrl;
  setHeroPhotoPreview(demoPhotoUrl);
  state.previewReady = false;

  const frame = document.getElementById('preview-frame');
  frame.onload = () => {
    state.previewReady = true;
    postPreviewUpdate();
  };
  frame.src = `../templates/${templateId}/index.html`;

  updateWizardStep();
  showScreen('wizard');
}

// --- Screen 3: wizard ---

function clearWizardFields() {
  ['coupleNames', 'heroPhotoUrl', 'date', 'time', 'venueName', 'venueAddress', 'mapUrl', 'dressCode', 'hostsNames', 'musicUrl', 'customerName', 'customerContact'].forEach((id) => {
    const el = document.getElementById(`field-${id}`);
    if (el) el.value = '';
  });
}

function setHeroPhotoPreview(url) {
  const wrap = document.getElementById('heroPhoto-preview-wrap');
  const img = document.getElementById('heroPhoto-preview');
  if (url) {
    img.src = url;
    wrap.classList.remove('hidden');
  } else {
    img.src = '';
    wrap.classList.add('hidden');
  }
}

document.getElementById('field-heroPhoto-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('heroPhoto-status');
  status.textContent = 'Иштелүүдө...';
  try {
    const dataUrl = await compressImageFile(file);
    document.getElementById('field-heroPhotoUrl').value = dataUrl;
    setHeroPhotoPreview(dataUrl);
    status.textContent = '';
    postPreviewUpdate();
  } catch (err) {
    console.error(err);
    status.textContent = 'Сүрөттү иштетүүдө ката кетти, кайра аракет кылыңыз.';
  }
});

document.getElementById('heroPhoto-remove').addEventListener('click', () => {
  document.getElementById('field-heroPhotoUrl').value = '';
  document.getElementById('field-heroPhoto-file').value = '';
  setHeroPhotoPreview('');
  postPreviewUpdate();
});

function setMusicPreview(url) {
  const wrap = document.getElementById('music-preview-wrap');
  const audio = document.getElementById('music-preview');
  if (url) {
    audio.src = url;
    wrap.classList.remove('hidden');
  } else {
    audio.removeAttribute('src');
    wrap.classList.add('hidden');
  }
}

document.getElementById('field-music-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('music-status');
  if (file.size > MAX_MUSIC_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const maxMb = (MAX_MUSIC_BYTES / (1024 * 1024)).toFixed(0);
    status.textContent = `Бул ыр өтө чоң (${sizeMb}МБ). ${maxMb}МБга чейин файл тандаңыз же кыскараак үзүндү колдонуңуз.`;
    event.target.value = '';
    return;
  }
  status.textContent = 'Иштелүүдө...';
  try {
    const dataUrl = await readFileAsDataUrl(file);
    document.getElementById('field-musicUrl').value = dataUrl;
    setMusicPreview(dataUrl);
    status.textContent = '';
    postPreviewUpdate();
  } catch (err) {
    console.error(err);
    status.textContent = 'Ырды иштетүүдө ката кетти, кайра аракет кылыңыз.';
  }
});

document.getElementById('music-remove').addEventListener('click', () => {
  document.getElementById('field-musicUrl').value = '';
  document.getElementById('field-music-file').value = '';
  setMusicPreview('');
  postPreviewUpdate();
});

function renderCollagePreviews() {
  const wrap = document.getElementById('collagePhotos-preview-wrap');
  wrap.innerHTML = '';
  state.collagePhotos.forEach((dataUrl, index) => {
    const item = document.createElement('div');
    item.className = 'collage-preview-item';
    item.innerHTML = `<img src="${dataUrl}" alt="" /><button type="button" aria-label="Өчүрүү">×</button>`;
    item.querySelector('button').addEventListener('click', () => {
      state.collagePhotos.splice(index, 1);
      renderCollagePreviews();
      postPreviewUpdate();
    });
    wrap.appendChild(item);
  });
}

document.getElementById('field-collagePhotos-file').addEventListener('change', async (event) => {
  let files = Array.from(event.target.files || []);
  if (!files.length) return;
  const status = document.getElementById('collagePhotos-status');
  const roomLeft = MAX_COLLAGE_PHOTOS - state.collagePhotos.length;
  let truncated = false;
  if (files.length > roomLeft) {
    files = files.slice(0, Math.max(roomLeft, 0));
    truncated = true;
  }
  if (!files.length) {
    status.textContent = `Көбүрөөк сүрөт кошууга болбойт (максимум ${MAX_COLLAGE_PHOTOS}).`;
    event.target.value = '';
    return;
  }
  status.textContent = 'Иштелүүдө...';
  try {
    const compressed = await Promise.all(files.map((f) => compressImageFile(f, 1200, 0.78)));
    state.collagePhotos.push(...compressed);
    renderCollagePreviews();
    status.textContent = truncated ? `Максимум ${MAX_COLLAGE_PHOTOS} сүрөт гана кошулду.` : '';
    event.target.value = '';
    postPreviewUpdate();
  } catch (err) {
    console.error(err);
    status.textContent = 'Сүрөттөрдү иштетүүдө ката кетти, кайра аракет кылыңыз.';
  }
});

function currentConfig() {
  const defaults = state.selectedTemplateDefaults || {};
  return {
    eventType: state.category,
    coupleNames: document.getElementById('field-coupleNames').value || defaults.coupleNames,
    // musicUrl/heroPhotoUrl deliberately do NOT fall back to the template's
    // demo asset: they're optional per the UI copy, and the preview must
    // stay pixel-identical to what actually gets deployed - defaulting to
    // our stock photo/track here would show the customer something that
    // silently disappears (or worse, leaks a stranger's photo) once deployed.
    heroPhotoUrl: document.getElementById('field-heroPhotoUrl').value || '',
    date: document.getElementById('field-date').value || defaults.date,
    time: document.getElementById('field-time').value || defaults.time,
    venueName: document.getElementById('field-venueName').value || defaults.venueName,
    venueAddress: document.getElementById('field-venueAddress').value || defaults.venueAddress,
    mapUrl: document.getElementById('field-mapUrl').value || defaults.mapUrl,
    schedule: state.schedule.filter((row) => row.time && row.label).length
      ? state.schedule.filter((row) => row.time && row.label)
      : defaults.schedule,
    dressCode: document.getElementById('field-dressCode').value || defaults.dressCode,
    hostsNames: document.getElementById('field-hostsNames').value || '',
    // Collage photos have no template-demo default to fall back to or leak,
    // so they're always exactly what the customer uploaded this session.
    collagePhotos: state.collagePhotos,
    musicUrl: document.getElementById('field-musicUrl').value || '',
    colorTheme: defaults.colorTheme,
  };
}

function postPreviewUpdate() {
  scheduleDraftSave();
  if (!state.previewReady) return;
  const frame = document.getElementById('preview-frame');
  frame.contentWindow.postMessage({ type: 'PREVIEW_CONFIG', config: currentConfig() }, '*');
}

// --- Draft persistence: resume after closing the tab (see persist.js) ---

const DRAFT_FIELD_IDS = [
  'coupleNames', 'heroPhotoUrl', 'date', 'time', 'venueName', 'venueAddress',
  'mapUrl', 'dressCode', 'hostsNames', 'musicUrl', 'customerName', 'customerContact',
];

function buildDraftSnapshot() {
  const fields = {};
  DRAFT_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(`field-${id}`);
    if (el) fields[id] = el.value;
  });
  return {
    category: state.category,
    selectedTemplateId: state.selectedTemplateId,
    currentStep: state.currentStep,
    schedule: state.schedule,
    collagePhotos: state.collagePhotos,
    fields,
  };
}

let draftSaveTimer = null;
function scheduleDraftSave() {
  // Nothing worth resuming before a template is actually picked.
  if (!state.selectedTemplateId) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    window.WizardPersist.saveDraft(buildDraftSnapshot());
  }, 600);
}

document.querySelectorAll('.wizard-step input').forEach((input) => {
  input.addEventListener('input', postPreviewUpdate);
});

function renderScheduleRows() {
  const container = document.getElementById('schedule-rows');
  container.innerHTML = '';
  state.schedule.forEach((row, index) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'schedule-row';
    rowEl.innerHTML = `
      <input type="time" value="${row.time}" data-index="${index}" data-field="time" aria-label="Программанын убактысы" />
      <input type="text" placeholder="Мис. Дасторкон" value="${row.label}" data-index="${index}" data-field="label" aria-label="Программанын аталышы" />
      <button type="button" data-remove="${index}" aria-label="Өчүрүү">×</button>
    `;
    container.appendChild(rowEl);
  });

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.index);
      state.schedule[idx][input.dataset.field] = input.value;
      postPreviewUpdate();
    });
  });
  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.schedule.splice(Number(btn.dataset.remove), 1);
      if (state.schedule.length === 0) state.schedule.push({ time: '', label: '' });
      renderScheduleRows();
      postPreviewUpdate();
    });
  });
}

document.getElementById('add-schedule-row').addEventListener('click', () => {
  state.schedule.push({ time: '', label: '' });
  renderScheduleRows();
});

function updateWizardStep() {
  let activeStepEl = null;
  document.querySelectorAll('.wizard-step').forEach((el) => {
    const isActive = Number(el.dataset.step) === state.currentStep;
    el.classList.toggle('active', isActive);
    if (isActive) activeStepEl = el;
  });
  document.getElementById('wizard-prev').disabled = state.currentStep === 0;

  const isLastStep = state.currentStep === STEP_COUNT - 1;
  document.getElementById('wizard-next').classList.toggle('hidden', isLastStep);
  document.getElementById('wizard-submit').classList.toggle('hidden', !isLastStep);

  // The full-screen preview sits behind a floating panel, and .wizard-steps
  // (not the page) is what scrolls internally - for a long step (e.g. a
  // schedule with many rows), always bring the new step's own heading back
  // to the top of that panel instead of leaving it wherever the previous
  // step happened to be scrolled to.
  if (activeStepEl) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollContainer = document.querySelector('.wizard-steps');
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const rect = activeStepEl.getBoundingClientRect();
      const targetScroll = Math.max(0, scrollContainer.scrollTop + (rect.top - containerRect.top));
      scrollContainer.scrollTo({ top: targetScroll, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }
}

document.getElementById('wizard-prev').addEventListener('click', () => {
  if (state.currentStep > 0) {
    state.currentStep -= 1;
    updateWizardStep();
    scheduleDraftSave();
  }
});

document.getElementById('wizard-next').addEventListener('click', () => {
  if (state.currentStep < STEP_COUNT - 1) {
    state.currentStep += 1;
    updateWizardStep();
    scheduleDraftSave();
  }
});

document.getElementById('wizard-submit').addEventListener('click', async () => {
  const submitButton = document.getElementById('wizard-submit');
  submitButton.disabled = true;
  submitButton.textContent = 'Жөнөтүлүүдө...';

  const orderId = crypto.randomUUID();
  const submittedConfig = currentConfig();
  const defaults = state.selectedTemplateDefaults || {};
  // The field was pre-filled with the template's own demo photo so the
  // preview wouldn't look broken (see selectTemplateAndProceed above). If the
  // customer never replaced it, don't ship our stock/demo photo (or its
  // dev-only relative path) to their real site.
  if (submittedConfig.heroPhotoUrl === defaults.heroPhotoUrl) {
    submittedConfig.heroPhotoUrl = '';
  }

  const payload = {
    orderId,
    templateId: state.selectedTemplateId,
    category: state.category,
    config: submittedConfig,
    customer: {
      name: document.getElementById('field-customerName').value,
      contact: document.getElementById('field-customerContact').value,
    },
  };

  const body = JSON.stringify(payload);
  if (new Blob([body]).size > MAX_PAYLOAD_BYTES) {
    submitButton.disabled = false;
    submitButton.textContent = 'Жөнөтүү';
    alert('Файлдардын жалпы көлөмү өтө чоң. Ырды же бир нече сүрөттү өчүрүп, кайра аракет кылыңыз.');
    return;
  }

  try {
    const res = await fetch(`${FUNCTIONS_ORIGIN}/.netlify/functions/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    // whatsappUrl is only present when MANAGER_WHATSAPP_NUMBER is configured
    // server-side (see order.js) - the Telegram-only default omits it.
    const { whatsappUrl } = await res.json();
    document.getElementById('confirmation-order-id').textContent = orderId;
    const whatsappLink = document.getElementById('confirmation-whatsapp-link');
    if (whatsappUrl) {
      whatsappLink.href = whatsappUrl;
      whatsappLink.classList.remove('hidden');
      document.getElementById('confirmation-message').textContent =
        'Буйрутмаңыз сакталды. Төлөмдү тактоо жана чакырууну даярдоо үчүн менеджер менен WhatsApp аркылуу байланышыңыз.';
    } else {
      whatsappLink.classList.add('hidden');
      document.getElementById('confirmation-message').textContent =
        'Сиздин буйрутмаңыз жөнөтүлдү. Төлөмдү тактоо үчүн жакында сиз менен байланышабыз.';
    }
    window.WizardPersist.clearDraft();
    showScreen('confirmation');
  } catch (err) {
    console.error(err);
    submitButton.disabled = false;
    submitButton.textContent = 'Жөнөтүү';
    alert('Ката кетти, кайра аракет кылыңыз.');
  }
});

// --- Draft restore, offered on first load only (see persist.js) ---

function hideDraftBanner() {
  document.getElementById('draft-banner').classList.add('hidden');
}

async function restoreDraft(draft) {
  hideDraftBanner();
  state.category = draft.category;
  try {
    await loadCarousel();
  } catch (err) {
    console.error(err);
    await window.WizardPersist.clearDraft();
    return;
  }

  if (!state.templatesInCategory.some((t) => t.id === draft.selectedTemplateId)) {
    // The template this draft was for no longer exists in the catalog.
    await window.WizardPersist.clearDraft();
    return;
  }
  state.selectedTemplateId = draft.selectedTemplateId;

  try {
    const res = await fetch(`../templates/${draft.selectedTemplateId}/config.example.json`);
    if (!res.ok) throw new Error('Template config missing');
    state.selectedTemplateDefaults = await res.json();
  } catch (err) {
    console.error(err);
    await window.WizardPersist.clearDraft();
    return;
  }

  state.schedule = draft.schedule && draft.schedule.length ? draft.schedule : [{ time: '', label: '' }];
  state.collagePhotos = draft.collagePhotos || [];
  renderScheduleRows();
  renderCollagePreviews();

  const fields = draft.fields || {};
  DRAFT_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(`field-${id}`);
    if (el) el.value = fields[id] || '';
  });
  setHeroPhotoPreview(fields.heroPhotoUrl || '');
  setMusicPreview(fields.musicUrl || '');

  state.currentStep = draft.currentStep || 0;
  updateWizardStep();

  state.previewReady = false;
  const frame = document.getElementById('preview-frame');
  frame.onload = () => {
    state.previewReady = true;
    postPreviewUpdate();
  };
  frame.src = `../templates/${draft.selectedTemplateId}/index.html`;

  showScreen('wizard');
}

async function tryRestoreDraft() {
  const draft = await window.WizardPersist.loadDraft();
  if (!draft || !draft.selectedTemplateId) return;

  const banner = document.getElementById('draft-banner');
  banner.classList.remove('hidden');
  document.getElementById('draft-continue').addEventListener('click', () => restoreDraft(draft), { once: true });
  document.getElementById('draft-discard').addEventListener(
    'click',
    async () => {
      hideDraftBanner();
      await window.WizardPersist.clearDraft();
    },
    { once: true }
  );
}

tryRestoreDraft();
