// Código compartilhado entre o content.js (página de uso) e o popup:
// preferências, padrões de título, montagem do título e desenho do favicon.
// Fica em globalThis.CUF (e não em const) para poder ser reinjetado na mesma aba sem erro.
globalThis.CUF = (() => {
  const DEFAULTS = { favicon: '5h', template: '{5h} · ↻ em {reset5h} — {codex}', value: 'used' };
  const ICON_MODES = ['5h', 'sem', 'both', 'off'];

  // Títulos sugeridos para cada favicon (o primeiro de cada lista é o padrão daquele favicon).
  const PRESETS = {
    '5h': ['{5h} · ↻ em {reset5h} — {codex}', '5h: {5h} · reinicia em {reset5h} — {codex}', '{5h} — {codex}'],
    sem: ['{sem} · ↻ em {resetsem} — {codex}', 'Semanal: {sem} · reinicia em {resetsem} — {codex}', '{sem} — {codex}'],
    both: ['{5h} · {sem} — {codex}', '5h: {5h} · semanal: {sem} — {codex}', '{5h} · {sem} · ↻ em {reset5h} — {codex}'],
  };
  const presetsFor = (favicon) =>
    favicon === 'off' ? [...PRESETS['5h'], ...PRESETS.sem, ...PRESETS.both] : PRESETS[favicon];

  // Aceita preferências antigas (favicon true/false/'max', sem 'value').
  // Só é personalizado o que foi escolhido como "Personalizado…" (custom: true); qualquer outro
  // título salvo que não seja uma sugestão atual volta para a 1ª sugestão do favicon.
  function normalize(s) {
    const favicon = s.favicon === false ? 'off' : ICON_MODES.includes(s.favicon) ? s.favicon : DEFAULTS.favicon;
    const saved = typeof s.template === 'string' && s.template.trim() ? s.template : '';
    const custom = s.custom === true && !!saved;
    const isPreset = Object.values(PRESETS).some((list) => list.includes(saved));
    return {
      favicon,
      custom,
      template: custom || isPreset ? saved : favicon === 'off' ? DEFAULTS.template : PRESETS[favicon][0],
      value: s.value === 'remaining' ? 'remaining' : 'used',
    };
  }

  const ok = (v) => typeof v === 'number' && !isNaN(v);
  const fmt = (n) => {
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
  };
  // Valor exibido: usado, ou restante (100 - usado).
  const shown = (used, value) => (!ok(used) ? NaN : value === 'remaining' ? 100 - used : used);
  // Cor sempre pelo uso (alerta continua valendo no modo "restante").
  const color = (used) => (used >= 90 ? '#ef4444' : used >= 70 ? '#f59e0b' : '#22c55e');

  // Tempo que falta, com unidade em todas as partes para não parecer horário: 3h 53min / 6d 21h / 12min
  function fmtLeft(at) {
    if (!ok(at)) return '–';
    const m = Math.max(0, Math.ceil((at - Date.now()) / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return mm ? `${h}h ${mm}min` : `${h}h`;
    return `${mm}min`;
  }

  // data: { h5, sem } em % USADO, { reset5hAt, resetSemAt } em timestamp, page = título original.
  function renderTitle(template, data, value) {
    const pct = (used) => (ok(used) ? fmt(shown(used, value)) + '%' : '–');
    const dot = (used) => (!ok(used) ? '⚪' : used >= 90 ? '🔴' : used >= 70 ? '🟡' : '🟢');
    const known = [data.h5, data.sem].filter(ok);
    const t = {
      '5h': pct(data.h5), sem: pct(data.sem), max: pct(known.length ? Math.max(...known) : NaN),
      reset5h: fmtLeft(data.reset5hAt), resetsem: fmtLeft(data.resetSemAt),
      codex: value === 'remaining' ? 'Restante no Codex' : 'Uso do Codex',
      cor5h: dot(data.h5), corsem: dot(data.sem),
      pagina: data.page || '',
    };
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in t ? t[k] : m)).trim() || t['5h'];
  }

  // Favicon 64x64. '5h' | 'sem': número grande + barra embaixo; 'both': duas barras (5h | semanal).
  function drawIcon(mode, h5, sem, value) {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const TRACK = 'rgba(255,255,255,.18)';
    g.fillStyle = '#1f2937';
    g.beginPath();
    g.roundRect(0, 0, S, S, mode === 'both' ? 14 : 12);
    g.fill();

    if (mode === 'both') {
      const W = 21, GAP = 8, TOP = 8, H = S - TOP * 2;
      const x0 = (S - W * 2 - GAP) / 2;
      [h5, sem].forEach((used, i) => {
        const x = x0 + i * (W + GAP);
        g.fillStyle = TRACK;
        g.beginPath();
        g.roundRect(x, TOP, W, H, 5);
        g.fill();
        const v = shown(used, value);
        if (ok(v) && v > 0) {
          const h = Math.max(6, (H * Math.min(v, 100)) / 100);
          g.fillStyle = color(used);
          g.beginPath();
          g.roundRect(x, TOP + H - h, W, h, 5);
          g.fill();
        }
      });
      return c.toDataURL('image/png');
    }

    const used = mode === 'sem' ? sem : h5;
    const v = shown(used, value);
    const n = ok(v) ? String(Math.round(v)) : '–';
    const base = n.length >= 3 ? 36 : 50;
    g.fillStyle = '#fff';
    g.font = `bold ${base}px system-ui, sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = '-2px';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const w = g.measureText(n).width;
    if (w > S - 4) g.font = `bold ${Math.floor((base * (S - 4)) / w)}px system-ui, sans-serif`;
    g.fillText(n, S / 2, 44);

    const BX = 5, BY = 50, BW = S - 10, BH = 10;
    g.fillStyle = TRACK;
    g.beginPath();
    g.roundRect(BX, BY, BW, BH, BH / 2);
    g.fill();
    if (ok(v) && v > 0) {
      g.fillStyle = color(used);
      g.beginPath();
      g.roundRect(BX, BY, Math.max(BH, (BW * Math.min(v, 100)) / 100), BH, BH / 2);
      g.fill();
    }
    return c.toDataURL('image/png');
  }

  return { DEFAULTS, ICON_MODES, PRESETS, presetsFor, normalize, renderTitle, drawIcon, fmtLeft };
})();
