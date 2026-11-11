// Popup: favicon -> título (sugestões que combinam com o favicon) -> usado/restante.
// Salva em chrome.storage.sync; o content.js escuta a mudança e aplica na hora.
// Padrões, montagem do título e desenho do favicon vêm de shared.js (CUF).

const CUSTOM = '__custom__';
const GROUP_NAMES = { '5h': '5 horas', sem: 'Semanal', both: '5 horas e semanal' };
const TOKENS = {
  '{5h}': '% da janela de 5 horas',
  '{sem}': '% semanal',
  '{reset5h}': 'quanto falta para a janela de 5 h reiniciar',
  '{resetsem}': 'quanto falta para o limite semanal reiniciar',
  '{codex}': '"Uso do Codex" ou "Restante no Codex"',
  '{pagina}': 'título original da página',
};

const $ = (id) => document.getElementById(id);
let settings = CUF.normalize({});
let data = {
  h5: 13, sem: 5, page: 'Configurações',
  reset5hAt: Date.now() + (3 * 60 + 19) * 60000,
  resetSemAt: Date.now() + (6 * 1440 + 21 * 60) * 60000,
};
let real = false;

const render = (tpl) => CUF.renderTitle(tpl, data, settings.value);

// Favicon real do ChatGPT, do cache de favicons do Chrome (permissão "favicon").
const ORIGINAL_ICON = chrome.runtime.getURL('/_favicon/?pageUrl=https%3A%2F%2Fchatgpt.com%2F&size=32');
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
// Se o favicon original falhar, mostra um círculo tracejado em vez de imagem quebrada.
let originalFailed = false;
document.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG' || e.target.src !== ORIGINAL_ICON) return;
  originalFailed = true;
  for (const img of document.querySelectorAll('img')) {
    if (img.src === ORIGINAL_ICON) { img.classList.add('missing'); img.src = BLANK; }
  }
}, true);
const iconFor = (mode) =>
  mode !== 'off' ? CUF.drawIcon(mode, data.h5, data.sem, settings.value) : originalFailed ? BLANK : ORIGINAL_ICON;

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set(patch);
  paint();
}

// Opções do seletor de título: só as que combinam com o favicon (todas, agrupadas, se for o original).
function fillTitles() {
  const sel = $('title');
  sel.textContent = '';
  const add = (parent, tpl) => {
    const o = document.createElement('option');
    o.value = tpl;
    o.textContent = render(tpl);
    parent.append(o);
  };
  if (settings.favicon === 'off') {
    for (const [k, list] of Object.entries(CUF.PRESETS)) {
      const g = document.createElement('optgroup');
      g.label = GROUP_NAMES[k];
      list.forEach((t) => add(g, t));
      sel.append(g);
    }
  } else {
    CUF.presetsFor(settings.favicon).forEach((t) => add(sel, t));
  }
  const o = document.createElement('option');
  o.value = CUSTOM;
  o.textContent = 'Personalizado…';
  sel.append(o);
  sel.value = settings.custom ? CUSTOM : settings.template;
}

function paint() {
  const title = render(settings.template);
  const icon = iconFor(settings.favicon);
  for (const id of ['pv-title', 'pv-title2']) $(id).textContent = title;
  const setImg = (img, src) => {
    if (img.getAttribute('src') !== src) img.src = src;
    img.classList.toggle('missing', src === BLANK);
  };
  for (const id of ['pv-icon', 'pv-icon2']) setImg($(id), icon);
  $('pv-title').parentElement.title = title;

  for (const r of document.querySelectorAll('input[name=favicon]')) {
    r.checked = r.value === settings.favicon;
    setImg(r.parentElement.querySelector('img'), iconFor(r.value));
  }
  $('value').value = settings.value;
  fillTitles();
  $('custom').hidden = !settings.custom;

  $('hint').textContent = real
    ? 'Prévia com os seus valores mais recentes. À direita, como fica numa aba estreita.'
    : 'Prévia com valores de exemplo. Abra a página de uso para ver os seus.';
}

$('favicon').addEventListener('change', (e) => {
  if (e.target.name !== 'favicon') return;
  const favicon = e.target.value;
  const patch = { favicon };
  // Título sugerido que não combina com o novo favicon => troca pela 1ª sugestão dele.
  if (!settings.custom && !CUF.presetsFor(favicon).includes(settings.template)) {
    patch.template = CUF.presetsFor(favicon)[0];
  }
  save(patch);
});

$('title').addEventListener('change', (e) => {
  if (e.target.value !== CUSTOM) return save({ custom: false, template: e.target.value });
  $('template').value = settings.template; // começa do título atual
  save({ custom: true, template: settings.template });
  $('template').focus();
});

let timer = 0;
$('template').addEventListener('input', (e) => {
  // Prévia imediata; grava com debounce (o storage.sync limita escritas por minuto).
  settings.template = e.target.value || CUF.DEFAULTS.template;
  paint();
  clearTimeout(timer);
  timer = setTimeout(() => chrome.storage.sync.set({ custom: true, template: settings.template }), 400);
});

$('value').addEventListener('change', (e) => save({ value: e.target.value }));

for (const [tok, desc] of Object.entries(TOKENS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = tok;
  b.title = desc;
  b.addEventListener('click', () => {
    const el = $('template');
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + tok + el.value.slice(e);
    el.focus();
    el.setSelectionRange(s + tok.length, s + tok.length);
    el.dispatchEvent(new Event('input'));
  });
  $('tokens').append(b);
}

Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get('lastValues')]).then(([s, l]) => {
  settings = CUF.normalize(s);
  if (l.lastValues) { data = { ...data, ...l.lastValues }; real = true; }
  if (settings.custom) $('template').value = settings.template;
  paint();
});
