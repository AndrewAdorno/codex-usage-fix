// Injeta o content.js só quando uma aba do ChatGPT chega em /settings/usage por navegação SPA
// (pushState, sem reload). Carregamentos completos da página já são cobertos pelo
// content_scripts do manifest. Nas demais páginas do ChatGPT nada é injetado.
const isUsageUrl = (url) => {
  try {
    const u = new URL(url);
    return u.origin === 'https://chatgpt.com' && u.pathname.replace(/\/+$/, '') === '/settings/usage';
  } catch {
    return false;
  }
};

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isUsageUrl(changeInfo.url)) return;
  chrome.scripting
    .executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] })
    .catch(() => {}); // aba fechada / navegou de novo no meio: ignora
});
