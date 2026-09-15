import { config } from './config.js';

export const notifyEnabled = () => !!config.ntfy.topic;

/** Push a note to the ntfy topic, if configured. Never throws. */
export async function notify(title: string, body: string) {
  if (!notifyEnabled()) return;
  try {
    await fetch(`${config.ntfy.server}/${encodeURIComponent(config.ntfy.topic)}`, {
      method: 'POST',
      headers: { Title: `claude-picks: ${title}` },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error(`ntfy failed: ${(e as Error).message}`);
  }
}
