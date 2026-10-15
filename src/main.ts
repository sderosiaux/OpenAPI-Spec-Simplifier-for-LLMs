import './styles.css';
import '@fontsource-variable/dm-sans';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import example from '../example-large-spec.json?raw';
import { PRESETS, DEFAULT_PRESET, MAX_BYTES } from './model.ts';
import type { Options, OutputFormat, Preset, Result } from './model.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};
const paths: Record<string, string> = {
  settings:
    '<path d="m9.5 3-.6 2.2-1.8 1.1-2.2-.6-2.5 4.6L4 12v2l-1.6 1.7 2.5 4.3 2.2-.6 1.8 1.1.6 2.2h5l.6-2.2 1.8-1.1 2.2.6 2.5-4.3L20 14v-2l1.6-1.7-2.5-4.6-2.2.6-1.8-1.1-.6-2.2z" transform="translate(0 -1) scale(1 .95)"/><circle cx="12" cy="11.5" r="3"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
};
for (const element of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  // Only this static icon dictionary is rendered as markup; spec content is always text.
  element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[element.dataset.icon!] || ''}</svg>`;
}

const source = $<HTMLTextAreaElement>('source');
const output = $('output');
const copyButton = $<HTMLButtonElement>('copy-button');
const downloadButton = $<HTMLButtonElement>('download-button');
const formatButton = $<HTMLButtonElement>('format-button');
const dialog = $<HTMLDialogElement>('settings-dialog');
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const storageKey = 'spec-slim:preferences:v2';
let options: Options = { ...PRESETS[DEFAULT_PRESET], format: 'text', filter: '' };
let result: Result | null = null;
let revision = 0;
let processTimer: ReturnType<typeof setTimeout>;
let copyTimer: ReturnType<typeof setTimeout>;
let fileRevision = 0;
let loadedName = 'untitled';

try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (saved && Object.hasOwn(PRESETS, saved.preset)) {
    options = { ...options, ...PRESETS[saved.preset as Preset] };
    if (saved.format === 'json' || saved.format === 'text') options.format = saved.format;
    if (
      Number.isFinite(saved.descriptionLength) &&
      saved.descriptionLength >= 0 &&
      saved.descriptionLength <= 300
    )
      options.descriptionLength = saved.descriptionLength;
    for (const key of ['compactSchemas', 'referencedOnly', 'includeExamples'] as const)
      if (typeof saved[key] === 'boolean') options[key] = saved[key];
  }
} catch {
  /* Preferences are optional in private browsing or restricted storage. */
}

function savePreferences() {
  try {
    const { filter: _filter, ...preferences } = options;
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    /* Storage may be disabled. */
  }
}
function setText(id: string, text: string) {
  $(id).textContent = text;
}
function showError(message: string, id = 'error-message') {
  const element = $(dialog.open ? 'settings-error' : id);
  element.textContent = message;
  element.hidden = false;
}
function syncControls() {
  document
    .querySelectorAll<HTMLButtonElement>('[data-preset]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.preset === options.preset)),
    );
  document
    .querySelectorAll<HTMLButtonElement>('[data-format]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.format === options.format)),
    );
  $<HTMLInputElement>('description-length').value = String(options.descriptionLength);
  setText(
    'description-value',
    options.descriptionLength ? `${options.descriptionLength} chars` : 'Off',
  );
  $<HTMLInputElement>('compact-schemas').checked = options.compactSchemas;
  $<HTMLInputElement>('compact-schemas').disabled = options.format === 'json';
  $<HTMLInputElement>('referenced-only').checked = options.referencedOnly;
  $<HTMLInputElement>('include-examples').checked = options.includeExamples;
  const custom = (
    ['descriptionLength', 'compactSchemas', 'referencedOnly', 'includeExamples'] as const
  ).some((key) => options[key] !== PRESETS[options.preset][key]);
  $('custom-indicator').hidden = !custom;
  savePreferences();
}
function showEmpty() {
  output.textContent = '';
  output.hidden = true;
  $('output-empty').hidden = false;
  $('warnings').hidden = true;
  $('filter-notice').hidden = true;
  $('reduction').hidden = true;
}
function renderOutput(text: string) {
  const fragment = document.createDocumentFragment();
  const lines = text.split('\n');
  // Highlight structural lines only; never interpret imported text as markup.
  lines.forEach((line, index) => {
    const span = document.createElement('span');
    span.className = line.startsWith('## ')
      ? 'code-section'
      : line.startsWith('#')
        ? 'code-heading'
        : /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE) /.test(line)
          ? 'code-method'
          : /^(servers|security|securitySchemes):/.test(line)
            ? 'code-key'
            : line.startsWith('  →')
              ? 'code-dim'
              : '';
    span.textContent = line + (index < lines.length - 1 ? '\n' : '');
    fragment.append(span);
  });
  output.replaceChildren(fragment);
  output.hidden = false;
  $('output-empty').hidden = true;
}
function updateReduction(data: Result) {
  const reduction = (1 - data.outputBytes / data.inputBytes) * 100;
  setText(
    'reduction',
    `${Math.abs(reduction).toFixed(1)}% ${reduction >= 0 ? 'smaller' : 'larger'}`,
  );
  $('reduction').hidden = false;
}
function processNow() {
  clearTimeout(processTimer);
  if (source.value.trim()) worker.postMessage({ id: revision, text: source.value, options });
}
function schedule(delay = 250) {
  revision++;
  result = null;
  clearTimeout(processTimer);
  clearTimeout(copyTimer);
  setText('copy-label', 'Copy');
  setText('announcement', '');
  copyButton.disabled = true;
  downloadButton.disabled = true;
  formatButton.disabled = !source.value.trim();
  $('clear-button').hidden = !source.value;
  for (const id of ['error-message', 'action-error', 'settings-error', 'warnings', 'reduction'])
    $(id).hidden = true;
  source.removeAttribute('aria-invalid');
  $('output-scroll').setAttribute('aria-busy', String(Boolean(source.value.trim())));
  if (!source.value.trim()) {
    showEmpty();
    return;
  }
  processTimer = setTimeout(processNow, delay);
}
worker.onmessage = ({
  data,
}: MessageEvent<{
  id: number;
  action?: 'format';
  formatted?: string;
  result?: Result;
  error?: string;
}>) => {
  if (data.id !== revision) return;
  if (data.action === 'format') {
    if (data.error) showError(data.error);
    else if (data.formatted !== undefined) setSource(data.formatted, loadedName);
    return;
  }
  $('output-scroll').setAttribute('aria-busy', 'false');
  if (data.error || !data.result) {
    result = null;
    showEmpty();
    setText('error-message', data.error || 'Could not process this spec.');
    $('error-message').hidden = false;
    source.setAttribute('aria-invalid', 'true');
    return;
  }
  result = data.result;
  renderOutput(result.output);
  updateReduction(result);
  $('filter-notice').hidden = !options.filter.trim();
  setText(
    'filter-summary',
    `${result.document.operations.length} of ${result.totalOperations} operations`,
  );
  setText('announcement', `Output ready. ${$('reduction').textContent}.`);
  copyButton.disabled = false;
  downloadButton.disabled = false;
  const warningList = $('warnings-list');
  warningList.replaceChildren();
  for (const message of result.warnings) {
    const li = document.createElement('li');
    li.textContent = message;
    warningList.append(li);
  }
  $('warnings').hidden = result.warnings.length === 0;
  setText(
    'warnings-summary',
    `${result.warnings.length} conversion note${result.warnings.length === 1 ? '' : 's'}`,
  );
};
worker.onerror = () => {
  revision++;
  result = null;
  clearTimeout(processTimer);
  showEmpty();
  $('output-scroll').setAttribute('aria-busy', 'false');
  copyButton.disabled = true;
  downloadButton.disabled = true;
  showError('The processing worker could not start. Reload this page and try again.');
};
function setSource(text: string, filename: string) {
  fileRevision++;
  loadedName = filename;
  source.value = text;
  source.scrollTop = 0;
  source.scrollLeft = 0;
  $('output-scroll').scrollTop = 0;
  $('output-scroll').scrollLeft = 0;
  schedule(0);
}
function resetFilter() {
  options.filter = '';
  $<HTMLInputElement>('operation-filter').value = '';
}
source.addEventListener('input', () => {
  fileRevision++;
  loadedName = 'untitled';
  schedule();
});
$('clear-button').addEventListener('click', () => {
  resetFilter();
  setSource('', 'untitled');
  source.focus();
});
$('clear-filter').addEventListener('click', () => {
  resetFilter();
  schedule(0);
});
$('example-button').addEventListener('click', () => {
  resetFilter();
  setSource(example, 'ecommerce.openapi.json');
});
formatButton.addEventListener('click', () => {
  if (!source.value.trim()) return;
  $('settings-error').hidden = true;
  worker.postMessage({ id: revision, action: 'format', text: source.value });
});
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) =>
  button.addEventListener('click', () => {
    options = { ...options, ...PRESETS[button.dataset.preset as Preset] };
    syncControls();
    schedule(0);
  }),
);
document.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((button) =>
  button.addEventListener('click', () => {
    options.format = button.dataset.format as OutputFormat;
    syncControls();
    schedule(0);
  }),
);
$('settings-button').addEventListener('click', () => dialog.showModal());
$('close-settings').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  if (
    event.target === dialog &&
    (event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom)
  )
    dialog.close();
});
$('description-length').addEventListener('input', (event) => {
  options.descriptionLength = Number((event.target as HTMLInputElement).value);
  syncControls();
  schedule();
});
for (const [id, key] of [
  ['compact-schemas', 'compactSchemas'],
  ['referenced-only', 'referencedOnly'],
  ['include-examples', 'includeExamples'],
] as const) {
  $(id).addEventListener('change', (event) => {
    options[key] = (event.target as HTMLInputElement).checked;
    syncControls();
    schedule(0);
  });
}
$('operation-filter').addEventListener('input', (event) => {
  options.filter = (event.target as HTMLInputElement).value;
  schedule();
});

const fileInput = $<HTMLInputElement>('file-input');
$('import-button').addEventListener('click', () => fileInput.click());
async function importFile(file: File) {
  if (file.size > MAX_BYTES) {
    showError('Choose a JSON or YAML file under 5 MB.');
    return;
  }
  const current = ++fileRevision;
  try {
    const text = await file.text();
    if (current !== fileRevision) return;
    resetFilter();
    setSource(text, file.name);
  } catch {
    showError('This file could not be read. Try importing it again.');
  }
}
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void importFile(file);
  fileInput.value = '';
});
const dropZone = $('drop-zone');
let dragDepth = 0;
dropZone.addEventListener('dragenter', (event) => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    dragDepth++;
    dropZone.classList.add('drag-over');
  }
});
dropZone.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
dropZone.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropZone.classList.remove('drag-over');
  }
});
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
  if (event.dataTransfer?.files.length !== 1) {
    showError('Import one specification at a time.');
    return;
  }
  void importFile(event.dataTransfer.files[0]);
});
// Keep a file dropped outside the editor from navigating away from the workbench.
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
copyButton.addEventListener('click', async () => {
  if (!result) return;
  const current = revision;
  $('action-error').hidden = true;
  try {
    await navigator.clipboard.writeText(result.output);
    if (current !== revision) return;
    setText('copy-label', 'Copied!');
    setText('announcement', 'Copied to clipboard.');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setText('copy-label', 'Copy'), 2000);
  } catch {
    if (current !== revision) return;
    showError(
      'Clipboard access is unavailable. Select the output to copy, or download it from Settings.',
      'action-error',
    );
  }
});
downloadButton.addEventListener('click', () => {
  if (!result) return;
  const json = options.format === 'json';
  const blob = new Blob([result.output], {
    type: json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${
    loadedName
      .replace(/\.(json|ya?ml)$/i, '')
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 100) || 'openapi'
  }.slim.${json ? 'json' : 'txt'}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    schedule(0);
  }
});
syncControls();
setSource('', 'untitled');
if (matchMedia('(min-width: 760px) and (pointer: fine)').matches)
  source.focus({ preventScroll: true });
