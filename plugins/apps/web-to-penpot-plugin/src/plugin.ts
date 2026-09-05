import type { PluginToUiMessage, UiToPluginMessage } from './model.js';
import { ImportCancelledError, renderDocument } from './renderer.js';

let cancelled = false;
let importing = false;

penpot.flags.naturalChildOrdering = true;

function send(message: PluginToUiMessage): void {
  penpot.ui.sendMessage(message, true);
}

penpot.ui.open('WEB TO PENPOT', 'index.html', { width: 520, height: 680 });

penpot.ui.onMessage<UiToPluginMessage>((message) => {
  if (message.type === 'ui-ready') {
    send({
      type: 'ready',
      penpotVersion: penpot.version,
      supported: /^2\.17(?:\.|$)/.test(penpot.version),
    });
    return;
  }
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (message.type !== 'import' || importing) return;
  importing = true;
  cancelled = false;
  void renderDocument(message.document, {
    isCancelled: () => cancelled,
    onProgress: (completed, total, label) =>
      send({ type: 'progress', completed, total, label }),
  })
    .then((result) => send({ type: 'complete', result }))
    .catch((error: unknown) => {
      if (error instanceof ImportCancelledError) send({ type: 'cancelled' });
      else
        send({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
    })
    .finally(() => {
      importing = false;
      cancelled = false;
    });
});
