import { stringify } from 'yaml';
import { simplify, parseSpec } from './simplifier.ts';
import type { Options } from './model.ts';

type Request = { id: number; text: string } & (
  { action: 'format' } | { action?: 'simplify'; options: Options }
);

self.onmessage = ({ data }: MessageEvent<Request>) => {
  try {
    if (data.action === 'format') {
      const { spec, format } = parseSpec(data.text);
      self.postMessage({
        id: data.id,
        action: 'format',
        formatted: format === 'JSON' ? JSON.stringify(spec, null, 2) : stringify(spec),
      });
    } else self.postMessage({ id: data.id, result: simplify(data.text, data.options) });
  } catch (error) {
    self.postMessage({
      id: data.id,
      action: data.action,
      error: error instanceof Error ? error.message : 'Could not process this spec.',
    });
  }
};
