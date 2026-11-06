/*
 * Codex Usage Fix
 * Sobrepõe (sem alterar a lógica da página) os indicadores "X% restante(s)" por "Y% usado",
 * onde Y = 100 - X. Os elementos originais ficam transparentes (opacity:0) e uma camada própria,
 * em Shadow DOM fixo no <body>, é desenhada exatamente sobre eles.
 *
 * Desempenho:
 *  - Sem nenhum <progress> na página (ex.: conversas), só roda um querySelector a cada 1 s.
 *  - O DOM não é varrido: a busca parte dos <progress> (poucos) e olha só o cartão ao redor.
 *  - O loop de pintura (rAF) só existe enquanto há barras para acompanhar.
 *  - Estilos computados são cacheados e só relidos na varredura lenta (250 ms).
 */
(() => {
  if (window.__codexUsageFix) return;
  window.__codexUsageFix = true;

  const REMAINING_RE =
    /^\s*(\d+(?:[.,]\d+)?)\s*%\s*(restante|restantes|remaining|left|restant|verbleibend)/i;
  const USED_WORD = { pt: 'usado', en: 'used', es: 'usado', fr: 'utilisé', de: 'verbraucht' };
  const usedWord = () =>
    USED_WORD[(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase()] || 'used';

  const HIDE_ATTR = 'data-cuf-hidden';
  const style = document.createElement('style');
  style.textContent = `[${HIDE_ATTR}]{opacity:0 !important}`;
  document.documentElement.appendChild(style);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .lbl{position:absolute;white-space:nowrap;text-align:right;width:300px;font-variant-numeric:tabular-nums;}
    .bar{position:absolute;overflow:hidden;border-radius:999px;}
    .fill{height:100%;border-radius:999px;transition:width .3s ease;}
  </style>`;

  const items = new Map(); // <progress> -> item
  let hostAttached = false;
  let rafId = 0;

  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
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
    const it = { prog, textEl, label, bar, fill, cs: null, last: {} };
    items.set(prog, it);
    return it;
  }

  function removeItem(it) {
    it.label.remove();
    it.bar.remove();
    it.textEl.removeAttribute(HIDE_ATTR);
    it.prog.removeAttribute(HIDE_ATTR);
    items.delete(it.prog);
  }

  // Varredura lenta: descobre/limpa itens e atualiza estilos cacheados.
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
      it.textRemaining = m ? parseFloat(m[1].replace(',', '.')) : 0;
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

      const max = it.prog.max || 100;
      const rem = isNaN(it.prog.value) ? it.textRemaining : (it.prog.value / max) * 100;
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
  }

  // Só trabalha com a aba visível E a janela em foco.
  const active = () => !document.hidden && document.hasFocus();
  let timerId = 0;

  function frame() {
    rafId = 0;
    if (!items.size || !active()) return;
    paint();
    rafId = requestAnimationFrame(frame);
  }

  function tick() {
    if (!active()) return;
    if (document.querySelector('progress') || items.size) {
      if (!hostAttached && document.body) {
        document.body.appendChild(host);
        hostAttached = true;
      }
      scan();
      if (items.size && !rafId) rafId = requestAnimationFrame(frame);
    }
  }

  // Ocioso: 1 querySelector/s. Ativo (há barras): varredura a cada 250 ms.
  // Sem foco: nenhum timer nem rAF fica agendado. Ao voltar o foco, atualiza na hora.
  function schedule() {
    timerId = 0;
    if (!active()) return;
    tick();
    timerId = setTimeout(schedule, items.size ? 250 : 1000);
  }
  function wake() {
    if (!timerId && active()) schedule();
  }
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  schedule();
})();
