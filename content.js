/*
 * Codex Usage Fix
 * Sobrepõe (sem alterar a lógica da página) os indicadores "X% restante(s)" por "Y% usado",
 * onde Y = 100 - X. Os elementos originais ficam transparentes (opacity:0) e uma camada própria,
 * em Shadow DOM fixo no <body>, é desenhada exatamente sobre eles e reposicionada a cada frame.
 * Os valores são lidos continuamente do DOM original => atualização em tempo real.
 */
(() => {
  if (window.__codexUsageFix) return;
  window.__codexUsageFix = true;

  // "28% restante(s)", "28% remaining", "28% left", "28 % restante" ...
  const REMAINING_RE =
    /^\s*(\d+(?:[.,]\d+)?)\s*%\s*(restante|restantes|remaining|left|restant|restantes?\(s\)|verbleibend)/i;

  const USED_WORD = { pt: 'usado', en: 'used', es: 'usado', fr: 'utilisé', de: 'verbraucht' };
  const usedWord = () => USED_WORD[(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase()] || 'used';

  const HIDE_ATTR = 'data-cuf-hidden';
  const style = document.createElement('style');
  style.textContent = `[${HIDE_ATTR}]{opacity:0 !important}`;
  document.documentElement.appendChild(style);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .lbl{position:absolute;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums;}
    .bar{position:absolute;overflow:hidden;border-radius:999px;}
    .fill{height:100%;border-radius:999px;transition:width .3s ease;}
  </style>`;

  // key (elemento original do texto) -> { label, bar, fill, textEl, progEl }
  const items = new Map();

  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

  function usageColor(used, fallback) {
    if (used >= 90) return '#ef4444';
    if (used >= 70) return '#f59e0b';
    return fallback;
  }

  function isTopmost(el, rect) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }

  function scan() {
    const seen = new Set();
    // Textos folha "NN% restante(s)"
    const spans = document.querySelectorAll('span, div, p');
    for (const el of spans) {
      if (el.childElementCount !== 0) continue;
      const m = REMAINING_RE.exec(el.textContent || '');
      if (!m) continue;
      // barra <progress> no mesmo cartão (ancestral próximo)
      let card = el.parentElement, prog = null;
      for (let i = 0; i < 4 && card && !prog; i++, card = card.parentElement) {
        prog = card.querySelector('progress');
      }
      if (!prog) continue;
      seen.add(el);
      if (!items.has(el)) createItem(el, prog);
      items.get(el).remaining = parseFloat(m[1].replace(',', '.'));
    }
    // limpa itens cujo elemento saiu do DOM / mudou
    for (const [el, it] of items) {
      if (!seen.has(el) || !el.isConnected) removeItem(el, it);
    }
  }

  function createItem(textEl, progEl) {
    const label = document.createElement('div');
    label.className = 'lbl';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    root.append(bar, label);
    textEl.setAttribute(HIDE_ATTR, '');
    progEl.setAttribute(HIDE_ATTR, '');
    items.set(textEl, { label, bar, fill, textEl, progEl, remaining: 0 });
  }

  function removeItem(el, it) {
    it.label.remove();
    it.bar.remove();
    el.removeAttribute(HIDE_ATTR);
    it.progEl.removeAttribute(HIDE_ATTR);
    items.delete(el);
  }

  function paint() {
    for (const it of items.values()) {
      const { textEl, progEl, label, bar, fill } = it;
      const tr = textEl.getBoundingClientRect();
      const pr = progEl.getBoundingClientRect();
      const visible = tr.width > 0 && pr.width > 0 && isTopmost(progEl, pr);
      label.style.display = bar.style.display = visible ? '' : 'none';
      if (!visible) continue;

      // valor: prefere o <progress> (preciso); cai para o texto
      const max = progEl.max || 100;
      const rem = progEl.value != null && !isNaN(progEl.value) ? (progEl.value / max) * 100 : it.remaining;
      const used = Math.min(100, Math.max(0, 100 - rem));

      const cs = getComputedStyle(textEl);
      label.textContent = `${fmt(used)}% ${usedWord()}`;
      Object.assign(label.style, {
        left: tr.right - 300 + 'px',
        width: '300px',
        top: tr.top + 'px',
        height: tr.height + 'px',
        lineHeight: tr.height + 'px',
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
      });

      const track = getComputedStyle(progEl, '::-webkit-progress-bar').backgroundColor;
      const base = getComputedStyle(progEl, '::-webkit-progress-value').backgroundColor;
      Object.assign(bar.style, {
        left: pr.left + 'px',
        top: pr.top + 'px',
        width: pr.width + 'px',
        height: pr.height + 'px',
        background: track && track !== 'rgba(0, 0, 0, 0)' ? track : 'rgba(128,128,128,.25)',
      });
      fill.style.width = used + '%';
      fill.style.background = usageColor(used, base && base !== 'rgba(0, 0, 0, 0)' ? base : '#888');
    }
  }

  let lastScan = 0;
  function frame(t) {
    if (t - lastScan > 250) { lastScan = t; scan(); }
    paint();
    requestAnimationFrame(frame);
  }

  (document.body || document.documentElement).appendChild(host);
  requestAnimationFrame(frame);
})();
