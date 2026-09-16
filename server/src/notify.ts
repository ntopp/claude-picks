import { config } from './config.js';

export const notifyEnabled = () => !!config.ntfy.topic;

/**
 * Push a note to the ntfy topic, if configured. Tapping the notification opens the dashboard
 * (on the phone that means the Tailscale / LAN address). Never throws.
 */
export async function notify(title: string, body: string, opts: { priority?: 'high' | 'default' | 'low'; tags?: string } = {}) {
  if (!notifyEnabled()) return;
  try {
    await fetch(`${config.ntfy.server}/${encodeURIComponent(config.ntfy.topic)}`, {
      method: 'POST',
      headers: {
        Title: `Claude Picks: ${title}`,
        Click: config.dashboardUrl,
        Actions: `view, Open picks, ${config.dashboardUrl}, clear=true`,
        Priority: opts.priority ?? 'default',
        Tags: opts.tags ?? 'football',
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error(`ntfy failed: ${(e as Error).message}`);
  }
}

/** Picks-only push for friends following along. Tapping opens the public page. Never throws. */
export async function notifyFriends(title: string, body: string) {
  if (!config.ntfy.friendsTopic) return;
  try {
    await fetch(`${config.ntfy.server}/${encodeURIComponent(config.ntfy.friendsTopic)}`, {
      method: 'POST',
      headers: {
        Title: `Claude Picks: ${title}`,
        ...(config.pagesUrl ? { Click: config.pagesUrl, Actions: `view, Open the page, ${config.pagesUrl}, clear=true` } : {}),
        Tags: 'football',
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error(`ntfy (friends) failed: ${(e as Error).message}`);
  }
}
