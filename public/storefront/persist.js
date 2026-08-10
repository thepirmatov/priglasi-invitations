// Saves the customer's in-progress wizard (including uploaded photo/music data
// URLs) so closing the tab and coming back doesn't lose their work. Uses
// IndexedDB rather than localStorage: a hero photo + collage photos + a music
// file can add up to several MB, well past what localStorage reliably holds
// (commonly capped around 5-10MB per origin across every key combined).
// Every function fails silently (falls back to no persistence) since this is
// a convenience feature - a storage error here must never block the wizard.
const DB_NAME = 'priglasi-wizard';
const STORE_NAME = 'draft';
const DRAFT_KEY = 'current';

function openDraftDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDraft(data) {
  try {
    const db = await openDraftDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...data, savedAt: Date.now() }, DRAFT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Wizard draft save failed (non-critical):', err);
  }
}

async function loadDraft() {
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(DRAFT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Wizard draft load failed (non-critical):', err);
    return null;
  }
}

async function clearDraft() {
  try {
    const db = await openDraftDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(DRAFT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Wizard draft clear failed (non-critical):', err);
  }
}

window.WizardPersist = { saveDraft, loadDraft, clearDraft };
