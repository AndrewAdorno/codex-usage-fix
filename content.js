/*
 * Codex Usage Fix
 * Sobrepõe (sem alterar a lógica da página) os indicadores "X% restante(s)" por "Y% usado",
 * onde Y = 100 - X. Os elementos originais ficam transparentes (opacity:0) e uma camada própria,
 * em Shadow DOM fixo no <body>, é desenhada exatamente sobre eles.
 *
 * Ciclo de vida:
 *  - O background.js só injeta este script quando a aba entra em /settings/usage
 *    (nas conversas e demais páginas a extensão não existe na aba).
 *  - Ao sair da página (navegação SPA, sem reload), tudo é desmontado: overlay, timers e observers.
 *    A troca de URL é detectada pela Navigation API, popstate e por clique.
 *
 * Título e favicon da aba:
 *  - Título e favicon escolhidos no popup; padrões, montagem do título e desenho ficam em shared.js.
 *    Padrão: "13% · ↻ em 3h 19min — Uso do Codex" (números primeiro porque o Chrome corta o título
 *    pelo final quando a aba é estreita) e favicon com o número da janela de 5 h. Os <link rel=icon> da
 *    página não são removidos (o React é dono deles): só o atributo rel é trocado e depois restaurado.
 *
 * Desempenho (só enquanto está na página de uso):
 *  - Sem loop contínuo: repinta só em scroll/resize/mudança de layout (1 rAF por evento).
 *  - Varredura (estilos + valores) a cada 5 s com foco e 30 s sem foco. Com a aba oculta não há
 *    pintura; só uma varredura a cada 60 s para manter título/favicon em dia (é quando eles importam).
 *  - Mudança no texto do valor (MutationObserver) atualiza na hora, sem esperar a varredura.
 */
(() => {
  // Reinjeção (o usuário voltou à página de uso): só reavalia a URL.
  if (window.__codexUsageFix) { window.__codexUsageFix.check(); return; }

  const isUsagePage = () => location.pathname.replace(/\/+$/, '') === '/settings/usage';

  const REMAINING_RE =
    /^\s*(\d+(?:[.,]\d+)?)\s*%\s*(restante|restantes|remaining|left|restant|verbleibend)/i;
  const USED_WORD = { pt: 'usado', en: 'used', es: 'usado', fr: 'utilisé', de: 'verbraucht' };
  // Preferências do popup (chrome.storage.sync); padrões, título e favicon ficam em shared.js.
  let settings = CUF.normalize({});
  const lang = () => (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  const usedWord = () => USED_WORD[lang()] || 'used';
  const WEEK_RE = /seman|week|hebdo|woche/i;
  const FIVE_H_RE = /\b5\s*(h\b|hora|hour|heure|stunde)/i;

  const HIDE_ATTR = 'data-cuf-hidden';
  const style = document.createElement('style');
  style.textContent = `[${HIDE_ATTR}]{opacity:0 !important}`;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .lbl{position:absolute;white-space:nowrap;text-align:right;width:300px;font-variant-numeric:tabular-nums;}
    .bar{position:absolute;overflow:hidden;border-radius:999px;}
    .fill{height:100%;border-radius:999px;transition:width .3s ease;}
  </style>`;

  const items = new Map(); // <progress> -> item
  let rafId = 0;

  // Arredonda para 1 casa antes de decidir o formato: 44.0000001 -> "44", 44.25 -> "44,3".
  const fmt = (n) => {
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
  };
  const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

  const usageColor = (used, base) => (used >= 90 ? '#ef4444' : used >= 70 ? '#f59e0b' : base);

  // Descobre se a barra é a de 5 h ou a semanal pelo texto do próprio card: sobe a partir do
  // texto do valor enquanto o ancestral contiver no máximo um <progress>.
  function findCard(textEl) {
    let el = textEl;
    while (el.parentElement && el.parentElement.querySelectorAll('progress').length <= 1) el = el.parentElement;
    return el;
  }
  function findKind(card) {
    const t = card.textContent || '';
    return WEEK_RE.test(t) ? 'week' : FIVE_H_RE.test(t) ? '5h' : null;
  }

  // "Reinicia em 3 h e 53 min" / "Reinicia em 6 dias e 21 h" / "Resets at 6:42 PM" -> timestamp.
  const RESET_RE = /reinicia|redefine|renova|reset|réinitialis|zurückgesetzt|restablece/i;
  const UNIT_RE = /(\d+)\s*(dias?|days?|d\b|jours?|j\b|tage?n?|h\b|horas?|hours?|hrs?|heures?|stunden?|std|min\w*|m\b)/gi;
  function parseReset(text) {
    const clock = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
    if (clock) {
      let h = +clock[1] % (clock[3] ? 12 : 24);
      if (clock[3] && clock[3].toLowerCase() === 'pm') h += 12;
      const d = new Date();
      d.setHours(h, +clock[2], 0, 0);
      if (d <= Date.now()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    let min = 0, found = false;
    for (const [, n, u] of text.matchAll(UNIT_RE)) {
      found = true;
      const c = u[0].toLowerCase();
      min += +n * (c === 'd' || c === 'j' || c === 't' ? 1440 : c === 'm' ? 1 : 60);
    }
    return found ? Date.now() + min * 60000 : NaN;
  }
  // Só recalcula o horário quando o texto muda: assim a contagem regressiva anda sozinha
  // mesmo que a página não atualize o texto enquanto a aba está aberta.
  function resetOf(it) {
    let el = null;
    for (const e of it.card.querySelectorAll('span, div, p')) {
      if (e.childElementCount === 0 && RESET_RE.test(e.textContent)) { el = e; break; }
    }
    const t = el ? el.textContent.trim() : '';
    if (t !== it.resetText) { it.resetText = t; it.resetAt = t ? parseReset(t) : NaN; }
    return it.resetAt;
  }


  // O texto da página é a fonte da verdade (já vem arredondado como o site exibe);
  // o <progress> só é usado se o texto não puder ser lido.
  function usedOf(it) {
    const m = REMAINING_RE.exec(it.textEl.textContent);
    const max = it.prog.max || 100;
    const rem = m ? parseFloat(m[1].replace(',', '.')) : (it.prog.value / max) * 100;
    return isNaN(rem) ? NaN : Math.min(100, Math.max(0, 100 - rem));
  }

  function findTextEl(prog) {
    let card = prog.parentElement;
    for (let i = 0; i < 4 && card; i++, card = card.parentElement) {
      for (const el of card.querySelectorAll('span, div, p')) {
        if (el.childElementCount === 0 && REMAINING_RE.test(el.textContent)) return el;
      }
    }
    return null;
  }

  function createItem(prog, textEl) {
    const label = document.createElement('div');
    label.className = 'lbl';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    root.append(bar, label);
    textEl.setAttribute(HIDE_ATTR, '');
    prog.setAttribute(HIDE_ATTR, '');
    // Valor novo no texto => atualiza no próximo frame, sem esperar a varredura periódica.
    // A aba pode estar oculta (sem rAF), então título/favicon são atualizados direto aqui.
    const mo = new MutationObserver(() => { requestScan(); updateTab(); });
    mo.observe(textEl, { characterData: true, childList: true, subtree: true });
    const card = findCard(textEl);
    const it = { prog, textEl, card, label, bar, fill, mo, kind: findKind(card), cs: null, last: {} };
    items.set(prog, it);
    return it;
  }

  function removeItem(it) {
    it.mo.disconnect();
    it.label.remove();
    it.bar.remove();
    it.textEl.removeAttribute(HIDE_ATTR);
    it.prog.removeAttribute(HIDE_ATTR);
    items.delete(it.prog);
  }

  // Varredura: descobre/limpa itens e atualiza estilos e valores cacheados.
  function scan() {
    const progs = document.querySelectorAll('progress');
    const live = new Set();
    for (const prog of progs) {
      let it = items.get(prog);
      if (it && (!it.textEl.isConnected || !REMAINING_RE.test(it.textEl.textContent))) {
        removeItem(it);
        it = null;
      }
      if (!it) {
        const textEl = findTextEl(prog);
        if (!textEl) continue;
        it = createItem(prog, textEl);
      }
      live.add(prog);
      const cs = getComputedStyle(it.textEl);
      const track = getComputedStyle(prog, '::-webkit-progress-bar').backgroundColor;
      const base = getComputedStyle(prog, '::-webkit-progress-value').backgroundColor;
      it.cs = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
        track: transparent(track) ? 'rgba(128,128,128,.25)' : track,
        base: transparent(base) ? '#888' : base,
      };
    }
    for (const it of [...items.values()]) if (!live.has(it.prog)) removeItem(it);
  }

  function setIf(it, key, el, prop, val) {
    if (it.last[key] !== val) { it.last[key] = val; el.style[prop] = val; }
  }

  function paint() {
    // 1) leituras de layout, 2) escritas (evita layout thrashing)
    const reads = [];
    for (const it of items.values()) {
      if (!it.cs) continue;
      if (!it.prog.isConnected || !it.textEl.isConnected) { needScan = true; continue; }
      const tr = it.textEl.getBoundingClientRect();
      const pr = it.prog.getBoundingClientRect();
      let visible = false;
      if (tr.width > 0 && pr.width > 0) {
        const x = pr.left + pr.width / 2, y = pr.top + pr.height / 2;
        if (x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight) {
          const hit = document.elementFromPoint(x, y);
          visible = !!hit && (hit === it.prog || it.prog.contains(hit));
        }
      }
      reads.push([it, tr, pr, visible]);
    }
    for (const [it, tr, pr, visible] of reads) {
      const { label, bar, fill, cs } = it;
      const disp = visible ? '' : 'none';
      setIf(it, 'd', label, 'display', disp);
      setIf(it, 'db', bar, 'display', disp);
      if (!visible) continue;

      const used = usedOf(it);
      if (isNaN(used)) continue;
      const text = `${fmt(used)}% ${usedWord()}`;
      if (it.last.text !== text) { it.last.text = text; label.textContent = text; }

      setIf(it, 'll', label, 'left', tr.right - 300 + 'px');
      setIf(it, 'lt', label, 'top', tr.top + 'px');
      setIf(it, 'lh', label, 'height', tr.height + 'px');
      setIf(it, 'ln', label, 'lineHeight', tr.height + 'px');
      setIf(it, 'ff', label, 'fontFamily', cs.fontFamily);
      setIf(it, 'fs', label, 'fontSize', cs.fontSize);
      setIf(it, 'fw', label, 'fontWeight', cs.fontWeight);
      setIf(it, 'co', label, 'color', cs.color);

      setIf(it, 'bl', bar, 'left', pr.left + 'px');
      setIf(it, 'bt', bar, 'top', pr.top + 'px');
      setIf(it, 'bw', bar, 'width', pr.width + 'px');
      setIf(it, 'bh', bar, 'height', pr.height + 'px');
      setIf(it, 'bb', bar, 'background', cs.track);
      setIf(it, 'fw2', fill, 'width', used + '%');
      setIf(it, 'fb', fill, 'background', usageColor(used, cs.base));
    }
    if (needScan) requestPaint();
  }

  // ---------- Título e favicon da aba ----------
  let baseTitle = null;   // título da página antes de ser substituído (para restaurar)
  let ourTitle = null;    // último título escrito pela extensão
  let iconLink = null;
  let iconKey = '';
  let headObs = null;
  let lastSaved = '';
  const ICON_STASH = 'data-cuf-rel';

  // Valores na ordem 5 h, semanal. Sem rótulo reconhecido, vale a ordem no documento.
  function tabValues() {
    const list = [...items.values()]
      .filter((it) => it.prog.isConnected)
      .sort((a, b) => (a.prog.compareDocumentPosition(b.prog) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const five = list.find((it) => it.kind === '5h');
    const week = list.find((it) => it.kind === 'week');
    // Sempre 2 posições: sem barras (ainda carregando) ou com uma só, o que falta vira NaN.
    const ordered = five || week ? [five, week] : [list[0], list[1]];
    return ordered.map((it) => (it ? { used: usedOf(it), resetAt: resetOf(it) } : { used: NaN, resetAt: NaN }));
  }

  function setTitle(title) {
    if (document.title !== ourTitle && document.title !== title) baseTitle = document.title;
    ourTitle = title;
    if (document.title !== title) document.title = title;
  }

  function restoreTitle() {
    if (ourTitle && document.title === ourTitle && baseTitle != null) document.title = baseTitle;
    ourTitle = null;
  }

  // Desativa os ícones da página (troca o rel, não remove o nó) e garante o nosso por último.
  function claimIcons() {
    for (const l of document.querySelectorAll('link[rel~="icon"]')) {
      if (l === iconLink) continue;
      l.setAttribute(ICON_STASH, l.getAttribute('rel'));
      l.setAttribute('rel', 'cuf-disabled-icon');
    }
    if (iconLink && !iconLink.isConnected) document.head.appendChild(iconLink);
  }

  function restoreIcons() {
    if (iconLink) iconLink.remove();
    iconLink = null;
    iconKey = '';
    for (const l of document.querySelectorAll(`link[${ICON_STASH}]`)) {
      l.setAttribute('rel', l.getAttribute(ICON_STASH));
      l.removeAttribute(ICON_STASH);
    }
  }

  function updateTab() {
    if (!running) return;
    const [h5, sem] = tabValues();
    const vals = [h5.used, sem.used];
    const known = vals.filter((v) => !isNaN(v));
    if (!known.length) { restoreTitle(); restoreIcons(); return; }

    const data = {
      h5: vals[0], sem: vals[1], reset5hAt: h5.resetAt, resetSemAt: sem.resetAt,
      page: (ourTitle ? baseTitle : document.title) || '',
    };
    setTitle(CUF.renderTitle(settings.template, data, settings.value));

    // Últimos valores para a prévia do popup (só grava quando mudam).
    const lastKey = [...vals, h5.resetAt, sem.resetAt].join('|');
    if (lastKey !== lastSaved) {
      lastSaved = lastKey;
      try { chrome.storage.local.set({ lastValues: data }); } catch {}
    }

    const mode = settings.favicon;
    if (mode === 'off') { restoreIcons(); return; }
    const key = [mode, settings.value, ...vals.map((v) => Math.round(v))].join('|');
    if (!iconLink) {
      iconLink = document.createElement('link');
      iconLink.rel = 'icon';
      iconLink.type = 'image/png';
    }
    if (key !== iconKey) { iconKey = key; iconLink.href = CUF.drawIcon(mode, vals[0], vals[1], settings.value); }
    claimIcons();
  }

  // O app pode reescrever o título ou recolocar ícones (ex.: re-render); reaplica na hora.
  function onHeadChange() {
    if (!ourTitle) return;
    if (document.title !== ourTitle) { baseTitle = document.title; document.title = ourTitle; }
    const foreign = [...document.querySelectorAll('link[rel~="icon"]')].some((l) => l !== iconLink);
    if (iconLink && (foreign || !iconLink.isConnected)) claimIcons();
  }

  // Preferências: carrega uma vez e reaplica na hora quando o popup muda algo.
  function applySettings(s) {
    settings = CUF.normalize(s);
    updateTab();
  }
  try {
    chrome.storage.sync.get(null).then(applySettings, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const s = { ...settings };
      for (const k of Object.keys(changes)) s[k] = changes[k].newValue;
      applySettings(s);
    });
  } catch {} // contexto da extensão invalidado (extensão recarregada): segue com o padrão

  // ---------- Agendamento (só enquanto running) ----------
  const SCAN_FOCUSED = 5000;     // barras encontradas, janela em foco
  const SCAN_UNFOCUSED = 30000;  // visível, mas sem foco (ex.: monitor secundário)
  const SCAN_LOADING = 1000;     // na página de uso, mas as barras ainda não carregaram
  const SCAN_HIDDEN = 60000;     // aba oculta: só mantém título/favicon atualizados
  let running = false;
  let timerId = 0;
  let needScan = false;
  let resizeObs = null;

  const active = () => running && !document.hidden;

  function frame() {
    rafId = 0;
    if (!active()) return;
    if (needScan) { needScan = false; scan(); }
    if (items.size) paint();
  }
  function requestPaint() {
    if (!rafId && items.size && active()) rafId = requestAnimationFrame(frame);
  }
  function requestScan() {
    needScan = true;
    requestPaint();
  }

  function schedule() {
    clearTimeout(timerId);
    timerId = 0;
    if (!running) return;
    scan();
    updateTab();
    requestPaint();
    const delay = document.hidden ? SCAN_HIDDEN
      : !items.size ? SCAN_LOADING
      : document.hasFocus() ? SCAN_FOCUSED : SCAN_UNFOCUSED;
    timerId = setTimeout(schedule, delay);
  }

  function start() {
    if (running) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', check, { once: true }); return; }
    running = true;
    document.documentElement.appendChild(style);
    document.body.appendChild(host);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    // capture: pega também o scroll de containers internos (o painel de configurações rola por dentro).
    window.addEventListener('scroll', requestPaint, { capture: true, passive: true });
    window.addEventListener('resize', requestPaint, { passive: true });
    // Mudanças de layout que não são scroll/resize (conteúdo carregando, seções abrindo).
    resizeObs = new ResizeObserver(requestPaint);
    resizeObs.observe(document.documentElement);
    headObs = new MutationObserver(onHeadChange);
    headObs.observe(document.head, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['rel', 'href'],
    });
    schedule();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearTimeout(timerId);
    timerId = 0;
    cancelAnimationFrame(rafId);
    rafId = 0;
    needScan = false;
    for (const it of [...items.values()]) removeItem(it);
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('focus', schedule);
    window.removeEventListener('scroll', requestPaint, { capture: true });
    window.removeEventListener('resize', requestPaint);
    resizeObs.disconnect();
    resizeObs = null;
    headObs.disconnect();
    headObs = null;
    restoreTitle();
    restoreIcons();
    host.remove();
    style.remove();
  }

  const check = () => (isUsagePage() ? start() : stop());

  // Detecção de troca de URL em SPA (sem reload). Os três são baratos e só reagem a eventos.
  let lastHref = location.href;
  const onMaybeNavigate = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    check();
  };
  if (window.navigation) window.navigation.addEventListener('currententrychange', onMaybeNavigate);
  window.addEventListener('popstate', onMaybeNavigate);
  // Clique: o roteador troca a URL logo depois do clique, então verifica no frame seguinte e após 300 ms.
  document.addEventListener('click', () => {
    requestAnimationFrame(onMaybeNavigate);
    setTimeout(onMaybeNavigate, 300);
  }, { capture: true, passive: true });

  window.__codexUsageFix = { check };
  check();
})();
