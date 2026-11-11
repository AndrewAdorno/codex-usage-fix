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
 * Desempenho (só enquanto está na página de uso e a aba está visível):
 *  - Sem loop contínuo: repinta só em scroll/resize/mudança de layout (1 rAF por evento).
 *  - Varredura (estilos + valores) a cada 5 s com foco e 30 s sem foco; aba oculta não roda nada.
 *  - Mudança no texto do valor (MutationObserver) atualiza na hora, sem esperar a varredura.
 */
(() => {
  // Reinjeção (o usuário voltou à página de uso): só reavalia a URL.
  if (window.__codexUsageFix) { window.__codexUsageFix.check(); return; }

  const isUsagePage = () => location.pathname.replace(/\/+$/, '') === '/settings/usage';

  const REMAINING_RE =
    /^\s*(\d+(?:[.,]\d+)?)\s*%\s*(restante|restantes|remaining|left|restant|verbleibend)/i;
  const USED_WORD = { pt: 'usado', en: 'used', es: 'usado', fr: 'utilisé', de: 'verbraucht' };
  const usedWord = () =>
    USED_WORD[(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase()] || 'used';

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
    const mo = new MutationObserver(requestScan);
    mo.observe(textEl, { characterData: true, childList: true, subtree: true });
    const it = { prog, textEl, label, bar, fill, mo, cs: null, last: {} };
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
      const m = REMAINING_RE.exec(it.textEl.textContent);
      it.textRemaining = m ? parseFloat(m[1].replace(',', '.')) : NaN;
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

      // O texto da página é a fonte da verdade (já vem arredondado como o site exibe);
      // o <progress> só é usado se o texto não puder ser lido.
      const max = it.prog.max || 100;
      const rem = !isNaN(it.textRemaining) ? it.textRemaining : (it.prog.value / max) * 100;
      const used = Math.min(100, Math.max(0, 100 - rem));
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

  // ---------- Agendamento (só enquanto running) ----------
  const SCAN_FOCUSED = 5000;     // barras encontradas, janela em foco
  const SCAN_UNFOCUSED = 30000;  // visível, mas sem foco (ex.: monitor secundário)
  const SCAN_LOADING = 1000;     // na página de uso, mas as barras ainda não carregaram
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
    if (!active()) return;
    scan();
    requestPaint();
    const delay = !items.size ? SCAN_LOADING : document.hasFocus() ? SCAN_FOCUSED : SCAN_UNFOCUSED;
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
