// Renders a channel-neutral message (see messages.mjs) for the notifyUrl's host:
//   ntfy.sh                               phone push, plain-text body, one-tap http action buttons
//   hooks.slack.com                       Slack Block Kit with a link button
//   discord(app).com/api/webhooks/...     Discord embed
//   anything else                         generic JSON
// Builders are pure: they return {method, headers, body} and never touch the network.

const NTFY_MAX_ACTIONS = 3; // ntfy rejects more than three actions per message

export function detectPreset(notifyUrl) {
  const url = new URL(notifyUrl);
  const host = url.hostname.toLowerCase();
  if (host === 'hooks.slack.com') return 'slack';
  const isDiscordHost = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host);
  if (isDiscordHost && url.pathname.startsWith('/api/webhooks/')) return 'discord';
  if (host === 'ntfy.sh') return 'ntfy';
  return 'generic';
}

/** The event `channel` name for a preset. */
export const channelOf = (preset) => (preset === 'generic' ? 'webhook' : preset);

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * @param {string} notifyUrl
 * @param {object} message  {kind, planId, title, body, priority, tags, click, actions}
 */
export function buildNotification(notifyUrl, message) {
  const preset = detectPreset(notifyUrl);
  const builders = { slack: slackPayload, discord: discordPayload, ntfy: ntfyPayload, generic: genericPayload };
  return { preset, ...builders[preset](message) };
}

/** HTTP header values must be Latin-1; ntfy decodes RFC 2047 encoded words. */
export function encodeHeaderValue(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

// ntfy treats a quote as the start of a quoted value and commas/semicolons as
// separators, so labels like "I'm safe" are wrapped in double quotes.
const ntfyLabel = (label) => (/[,;'"]/.test(label) ? `"${label.replace(/"/g, '')}"` : label);

/**
 * ntfy Actions header: "<action>, <label>, <url>[, key=value...]" joined by "; ".
 * http actions POST straight to the API, so the person can answer from the lock screen.
 */
export function ntfyActions(actions) {
  return actions.slice(0, NTFY_MAX_ACTIONS).map((a) => (a.type === 'http'
    ? `http, ${ntfyLabel(a.label)}, ${a.url}, method=POST, clear=true`
    : `view, ${ntfyLabel(a.label)}, ${a.url}`)).join('; ');
}

const NTFY_PRIORITY = { default: 'default', high: 'high', urgent: 'urgent' };

export function ntfyPayload(message) {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    Title: encodeHeaderValue(truncate(message.title, 200)),
    Priority: NTFY_PRIORITY[message.priority] ?? 'default',
    Click: message.click,
  };
  if (message.tags?.length) headers.Tags = message.tags.join(',');
  if (message.actions?.length) headers.Actions = ntfyActions(message.actions);
  return { method: 'POST', headers, body: truncate(message.body, 4000) };
}

// Slack mrkdwn needs &, < and > escaped or it parses them as links and mentions.
const slackEscape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackPayload(message) {
  // Incoming webhooks cannot POST back, so the one button opens the page instead.
  const button = { type: 'button', action_id: `lastcall_${message.kind}`, text: { type: 'plain_text', text: 'Open Last Call' }, url: message.click };
  if (message.priority === 'urgent') button.style = 'danger';
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: message.title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: truncate(message.title, 150), emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: truncate(slackEscape(message.body), 2900) } },
        { type: 'actions', elements: [button] },
      ],
    }),
  };
}

const DISCORD_COLORS = { urgent: 0xdc2626, high: 0xd97706, default: 0x16a34a };

export function discordPayload(message) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'Last Call',
      content: truncate(`${message.title}: ${message.click}`, 2000),
      embeds: [{
        title: truncate(message.title, 256),
        url: message.click,
        description: truncate(message.body, 4000),
        color: DISCORD_COLORS[message.priority] ?? DISCORD_COLORS.default,
      }],
      // Names and activities are user-controlled: never let them ping @everyone or roles.
      allowed_mentions: { parse: [] },
    }),
  };
}

export function genericPayload(message) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: `lastcall.${message.kind}`,
      planId: message.planId,
      title: message.title,
      message: message.body,
      priority: message.priority,
      url: message.click,
    }),
  };
}
