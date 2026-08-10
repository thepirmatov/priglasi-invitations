// Small library of purely decorative inline SVGs shared by every template.
// Each uses stroke/fill="currentColor" so it inherits `color` from CSS (see
// .decor in decor.css, which sets color: var(--color-accent)) - no per-template
// color wiring needed. All are aria-hidden since they carry no information a
// screen reader user needs (the text/labels next to them already say it).
const DECOR_ICONS = {
  // Two interlocking wedding rings - used above the RSVP heading on every template.
  rings: `<svg viewBox="0 0 48 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="18" cy="16" r="12" stroke="currentColor" stroke-width="2"/>
    <circle cx="30" cy="16" r="12" stroke="currentColor" stroke-width="2"/>
  </svg>`,

  // Thin flourish line with a small diamond center - a generic section divider
  // that stays tasteful whether the template is ornate or minimal.
  divider: `<svg viewBox="0 0 160 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="0" y1="10" x2="66" y2="10" stroke="currentColor" stroke-width="1.5"/>
    <rect x="74" y="4" width="12" height="12" transform="rotate(45 80 10)" stroke="currentColor" stroke-width="1.5"/>
    <line x1="94" y1="10" x2="160" y2="10" stroke="currentColor" stroke-width="1.5"/>
  </svg>`,

  // Small branch with a few leaves either side of the stem - replaces emoji
  // leaf/❧ ornaments so rendering is crisp and consistent across devices.
  leafSprig: `<svg viewBox="0 0 60 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M30 4 C30 16 30 24 30 36" stroke="currentColor" stroke-width="1.5"/>
    <path d="M30 12 C22 10 16 4 14 0 C10 8 12 16 30 20" fill="currentColor" opacity="0.85"/>
    <path d="M30 12 C38 10 44 4 46 0 C50 8 48 16 30 20" fill="currentColor" opacity="0.85"/>
    <path d="M30 22 C24 21 19 17 17 14 C14 20 16 26 30 29" fill="currentColor" opacity="0.7"/>
    <path d="M30 22 C36 21 41 17 43 14 C46 20 44 26 30 29" fill="currentColor" opacity="0.7"/>
  </svg>`,

  // Tiny five-petal bloom - a softer accent for romantic/floral-themed templates.
  bloom: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g fill="currentColor" opacity="0.85">
      <ellipse cx="20" cy="10" rx="6" ry="9"/>
      <ellipse cx="20" cy="10" rx="6" ry="9" transform="rotate(72 20 20)"/>
      <ellipse cx="20" cy="10" rx="6" ry="9" transform="rotate(144 20 20)"/>
      <ellipse cx="20" cy="10" rx="6" ry="9" transform="rotate(216 20 20)"/>
      <ellipse cx="20" cy="10" rx="6" ry="9" transform="rotate(288 20 20)"/>
    </g>
    <circle cx="20" cy="20" r="3.5" fill="currentColor"/>
  </svg>`,
};

// Fills every <div class="decor" data-decor="rings"> (etc.) found on the page.
// Called once per page load - templates are static once rendered, no need to
// re-scan after that.
function initDecor() {
  document.querySelectorAll('[data-decor]').forEach((el) => {
    const name = el.getAttribute('data-decor');
    const svg = DECOR_ICONS[name];
    if (!svg) return;
    el.innerHTML = svg;
    el.setAttribute('aria-hidden', 'true');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDecor);
} else {
  initDecor();
}

window.PriglasiDecor = { initDecor, DECOR_ICONS };
