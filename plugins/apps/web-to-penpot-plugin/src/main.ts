import './styles.css';
import { H2DParseError, parseH2DClipboardHtml } from './h2d.js';
import type {
  ImportDocument,
  ImportResult,
  PluginToUiMessage,
  UiToPluginMessage,
} from './model.js';
import { normalizeSnapshot } from './normalize.js';

const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing UI element: ${id}`);
  return result as T;
};

const readButton = element<HTMLButtonElement>('read');
const pasteZone = element<HTMLDivElement>('paste-zone');
const status = element<HTMLParagraphElement>('status');
const preview = element<HTMLElement>('preview');
const progressCard = element<HTMLElement>('progress-card');
const progress = element<HTMLProgressElement>('progress');
const resultCard = element<HTMLElement>('result');
const importButton = element<HTMLButtonElement>('import');
let currentDocument: ImportDocument | null = null;
let currentResult: ImportResult | null = null;
let compatible = false;
let preparationId = 0;

function send(message: UiToPluginMessage): void {
  parent.postMessage(message, '*');
}

function errorMessage(error: unknown): string {
  if (error instanceof H2DParseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function prepare(html: string, id = ++preparationId): Promise<void> {
  status.textContent = '正在解析 H2D 数据…';
  try {
    const parsed = parseH2DClipboardHtml(html);
    const nextDocument = await normalizeSnapshot(parsed.snapshot);
    if (id !== preparationId) return;
    currentDocument = nextDocument;
    const root = currentDocument.root.rect;
    element('title').textContent = currentDocument.title;
    element('nodes').textContent = String(currentDocument.stats.nodeCount);
    element('assets').textContent = String(currentDocument.stats.assetCount);
    element('warnings').textContent = String(currentDocument.warnings.length);
    element('size').textContent =
      `${Math.round(root.width)} × ${Math.round(root.height)}`;
    preview.classList.remove('hidden');
    resultCard.classList.add('hidden');
    status.textContent = '数据已在本机解析；导入过程不会访问原网页。';
  } catch (error) {
    if (id !== preparationId) return;
    currentDocument = null;
    preview.classList.add('hidden');
    status.textContent = errorMessage(error);
  }
}

async function readClipboard(): Promise<void> {
  const id = ++preparationId;
  try {
    if (!navigator.clipboard?.read)
      throw new Error('当前环境禁止主动读取，请使用下方粘贴区域。');
    const items = await navigator.clipboard.read();
    if (id !== preparationId) return;
    for (const item of items) {
      if (!item.types.includes('text/html')) continue;
      const html = await (await item.getType('text/html')).text();
      if (id !== preparationId) return;
      await prepare(html, id);
      return;
    }
    throw new Error(
      '剪贴板中没有 HTML/H2D 数据，请重新使用 Copy to Design 复制。',
    );
  } catch (error) {
    if (id !== preparationId) return;
    status.textContent = errorMessage(error);
    pasteZone.focus();
  }
}

readButton.addEventListener('click', () => void readClipboard());
pasteZone.addEventListener('paste', (event) => {
  event.preventDefault();
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (!html) {
    status.textContent = '粘贴内容没有 HTML/H2D 数据。';
    return;
  }
  void prepare(html);
});

element<HTMLButtonElement>('clear').addEventListener('click', () => {
  preparationId += 1;
  currentDocument = null;
  preview.classList.add('hidden');
  status.textContent = '已清除。';
});

importButton.addEventListener('click', () => {
  if (!currentDocument || !compatible) return;
  importButton.disabled = true;
  preview.classList.add('hidden');
  progressCard.classList.remove('hidden');
  progress.max = currentDocument.stats.nodeCount;
  progress.value = 0;
  send({ type: 'import', document: currentDocument });
});

element<HTMLButtonElement>('cancel').addEventListener('click', () =>
  send({ type: 'cancel' }),
);

function showResult(result: ImportResult): void {
  currentResult = result;
  progressCard.classList.add('hidden');
  resultCard.classList.remove('hidden');
  importButton.disabled = !compatible;
  element('result-summary').textContent =
    `${result.createdNodes} 个图层 · ${result.durationMs} ms`;
  element('report').textContent = JSON.stringify(result, null, 2);
  status.textContent = result.warnings.length
    ? `导入完成，有 ${result.warnings.length} 项需要检查。`
    : '导入完成。';
}

element<HTMLButtonElement>('download').addEventListener('click', () => {
  if (!currentResult) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(currentResult, null, 2)], {
      type: 'application/json',
    }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `web-to-penpot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

window.addEventListener('message', (event: MessageEvent<PluginToUiMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'ready') {
    compatible = message.supported;
    const version = element('version');
    version.textContent = `Penpot ${message.penpotVersion}`;
    version.classList.toggle('unsupported', !message.supported);
    if (!message.supported) {
      status.textContent = '此插件仅验证过 Penpot 2.17；当前版本可能不兼容。';
    }
    importButton.disabled = !compatible;
  } else if (message.type === 'progress') {
    progress.value = message.completed;
    element('progress-label').textContent =
      `${message.completed}/${message.total} · ${message.label}`;
  } else if (message.type === 'complete') {
    showResult(message.result);
  } else if (message.type === 'cancelled') {
    progressCard.classList.add('hidden');
    preview.classList.remove('hidden');
    importButton.disabled = !compatible;
    status.textContent = '已取消，创建中的图层已删除。';
  } else if (message.type === 'error') {
    progressCard.classList.add('hidden');
    preview.classList.remove('hidden');
    importButton.disabled = !compatible;
    status.textContent = message.message;
  }
});

send({ type: 'ui-ready' });
