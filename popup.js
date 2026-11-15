const DEFAULT_SETTINGS = {
  enableSortReviews: true,
  enableSortRating: true,
  enableSortDiscountPct: true,
  enableSortDiscountEur: false,
  enableSidebarFilters: true,
  maxPagesToFetch: 5
};

document.addEventListener('DOMContentLoaded', () => {
  const checkboxes = [
    'enableSortReviews',
    'enableSortRating',
    'enableSortDiscountPct',
    'enableSortDiscountEur',
    'enableSidebarFilters'
  ];
  const maxPagesSelect = document.getElementById('maxPagesToFetch');
  const saveStatus = document.getElementById('saveStatus');

  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    for (const id of checkboxes) {
      const el = document.getElementById(id);
      if (el) el.checked = Boolean(settings[id]);
    }
    if (maxPagesSelect) {
      maxPagesSelect.value = String(settings.maxPagesToFetch || 5);
    }
  });

  function showSavedNotice() {
    if (!saveStatus) return;
    saveStatus.textContent = 'Shranjeno ✓';
    saveStatus.classList.add('saved');
    setTimeout(() => {
      saveStatus.textContent = 'Nastavitve se shranjujejo samodejno';
      saveStatus.classList.remove('saved');
    }, 1500);
  }

  for (const id of checkboxes) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      chrome.storage.sync.set({ [id]: el.checked }, showSavedNotice);
    });
  }

  if (maxPagesSelect) {
    maxPagesSelect.addEventListener('change', () => {
      chrome.storage.sync.set(
        { maxPagesToFetch: parseInt(maxPagesSelect.value, 10) || 5 },
        showSavedNotice
      );
    });
  }
});
