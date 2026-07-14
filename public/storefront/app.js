const STEP_COUNT = 7;
// Forces a fresh image fetch each page load instead of a stale cached PNG
// from before a template's screenshot was regenerated.
const CACHE_BUST = Date.now();

const state = {
  category: null,
  types: [],
  templatesInCategory: [],
  selectedType: null,
  templates: [],
  selectedTemplateId: null,
  selectedTemplateDefaults: null,
  currentStep: 0,
  schedule: [{ time: '', label: '' }],
  previewReady: false,
};

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

const carouselTrack = document.getElementById('carousel-track');
const typeTabsContainer = document.getElementById('type-tabs');
const useTemplateButton = document.getElementById('use-template-button');
let carouselObserver = null;

async function loadCarousel() {
  const res = await fetch('../catalog/templates.json');
  const catalog = await res.json();
  state.types = catalog.types;
  state.templatesInCategory = catalog.templates.filter((t) => t.categories.includes(state.category));

  // Only show type tabs when this category actually spans more than one type -
  // kyz uzatuu today is all "classic", so it stays a plain carousel with no tabs.
  const availableTypeIds = [...new Set(state.templatesInCategory.map((t) => t.type))];
  const availableTypes = state.types.filter((t) => availableTypeIds.includes(t.id));
  state.selectedType = availableTypes[0] ? availableTypes[0].id : null;

  renderTypeTabs(availableTypes);
  renderCarouselCards();
}

function renderTypeTabs(availableTypes) {
  typeTabsContainer.innerHTML = '';
  if (availableTypes.length <= 1) {
    typeTabsContainer.classList.add('hidden');
    return;
  }
  typeTabsContainer.classList.remove('hidden');

  availableTypes.forEach((type) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'type-tab';
    tab.textContent = type.label;
    tab.classList.toggle('active', type.id === state.selectedType);
    tab.addEventListener('click', () => {
      state.selectedType = type.id;
      typeTabsContainer.querySelectorAll('.type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderCarouselCards();
    });
    typeTabsContainer.appendChild(tab);
  });
}

function renderCarouselCards() {
  state.templates = state.templatesInCategory.filter((t) => t.type === state.selectedType);

  carouselTrack.innerHTML = '';
  state.selectedTemplateId = null;
  useTemplateButton.disabled = true;

  state.templates.forEach((tpl) => {
    const card = document.createElement('div');
    card.className = 'carousel-card';
    card.dataset.templateId = tpl.id;
    card.innerHTML = `
      <img src="../catalog/${tpl.screenshot}?v=${CACHE_BUST}" alt="${tpl.name}" />
      <span class="carousel-card-name">${tpl.name}</span>
    `;
    card.addEventListener('click', () => {
      card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      selectCarouselCard(tpl.id);
    });
    carouselTrack.appendChild(card);
  });

  if (carouselObserver) carouselObserver.disconnect();
  carouselObserver = new IntersectionObserver(
    (entries) => {
      const mostVisible = entries.reduce((best, e) => (e.intersectionRatio > (best?.intersectionRatio || 0) ? e : best), null);
      if (mostVisible && mostVisible.intersectionRatio > 0.6) {
        selectCarouselCard(mostVisible.target.dataset.templateId);
      }
    },
    { root: carouselTrack, threshold: [0.6, 0.9] }
  );
  carouselTrack.querySelectorAll('.carousel-card').forEach((card) => carouselObserver.observe(card));
}

function selectCarouselCard(templateId) {
  state.selectedTemplateId = templateId;
  carouselTrack.querySelectorAll('.carousel-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.templateId === templateId);
  });
  useTemplateButton.disabled = false;
}

document.querySelector('.carousel-arrow-left').addEventListener('click', () => {
  carouselTrack.scrollBy({ left: -carouselTrack.clientWidth, behavior: 'smooth' });
});
document.querySelector('.carousel-arrow-right').addEventListener('click', () => {
  carouselTrack.scrollBy({ left: carouselTrack.clientWidth, behavior: 'smooth' });
});

useTemplateButton.addEventListener('click', async () => {
  if (!state.selectedTemplateId) return;
  try {
    const res = await fetch(`../templates/${state.selectedTemplateId}/config.example.json`);
    state.selectedTemplateDefaults = await res.json();
  } catch (err) {
    console.error(err);
    alert('Шаблон жүктөлгөн жок. Барак туура серверден ачылганын текшериңиз (file:// эмес).');
    return;
  }

  state.currentStep = 0;
  state.schedule = [{ time: '', label: '' }];
  renderScheduleRows();
  clearWizardFields();
  // Pre-fill with the template's own demo photo so the live preview matches
  // what the carousel just showed - otherwise the preview looks broken the
  // moment the customer arrives. Stripped back out at submit time unless the
  // customer replaces it with their own (see wizard-submit below).
  document.getElementById('field-heroPhotoUrl').value = state.selectedTemplateDefaults.heroPhotoUrl || '';
  state.previewReady = false;

  const frame = document.getElementById('preview-frame');
  frame.onload = () => {
    state.previewReady = true;
    postPreviewUpdate();
  };
  frame.src = `../templates/${state.selectedTemplateId}/index.html`;

  updateWizardStep();
  showScreen('wizard');
});

// --- Screen 3: wizard ---

function clearWizardFields() {
  ['coupleNames', 'heroPhotoUrl', 'date', 'time', 'venueName', 'venueAddress', 'mapUrl', 'dressCode', 'musicUrl', 'customerName', 'customerContact'].forEach((id) => {
    const el = document.getElementById(`field-${id}`);
    if (el) el.value = '';
  });
}

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
    musicUrl: document.getElementById('field-musicUrl').value || '',
    colorTheme: defaults.colorTheme,
    telegramChatId: '',
  };
}

function postPreviewUpdate() {
  if (!state.previewReady) return;
  const frame = document.getElementById('preview-frame');
  frame.contentWindow.postMessage({ type: 'PREVIEW_CONFIG', config: currentConfig() }, '*');
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
      <input type="time" value="${row.time}" data-index="${index}" data-field="time" />
      <input type="text" placeholder="Мис. Дасторкон" value="${row.label}" data-index="${index}" data-field="label" />
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
  document.querySelectorAll('.wizard-step').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === state.currentStep);
  });
  document.getElementById('wizard-prev').disabled = state.currentStep === 0;

  const isLastStep = state.currentStep === STEP_COUNT - 1;
  document.getElementById('wizard-next').classList.toggle('hidden', isLastStep);
  document.getElementById('wizard-submit').classList.toggle('hidden', !isLastStep);
}

document.getElementById('wizard-prev').addEventListener('click', () => {
  if (state.currentStep > 0) {
    state.currentStep -= 1;
    updateWizardStep();
  }
});

document.getElementById('wizard-next').addEventListener('click', () => {
  if (state.currentStep < STEP_COUNT - 1) {
    state.currentStep += 1;
    updateWizardStep();
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
  // preview wouldn't look broken (see useTemplateButton above). If the
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

  try {
    const res = await fetch('/.netlify/functions/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    document.getElementById('confirmation-order-id').textContent = orderId;
    showScreen('confirmation');
  } catch (err) {
    console.error(err);
    submitButton.disabled = false;
    submitButton.textContent = 'Telegram аркылуу жөнөтүү';
    alert('Ката кетти, кайра аракет кылыңыз.');
  }
});
