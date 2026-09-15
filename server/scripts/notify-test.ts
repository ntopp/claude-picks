/** Send a test push to the configured ntfy topic so you can confirm the phone is subscribed. */
import { config } from '../src/config.js';
import { notify, notifyEnabled } from '../src/notify.js';

if (!notifyEnabled()) {
  console.error('NTFY_TOPIC is not set in .env');
  process.exit(1);
}
await notify('test push', `If you can read this, notifications work. Tapping opens ${config.dashboardUrl}`, { tags: 'white_check_mark' });
console.log(`sent to ${config.ntfy.server}/${config.ntfy.topic} (click -> ${config.dashboardUrl})`);
