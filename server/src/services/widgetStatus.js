const THEME_SETTINGS_QUERY = /* GraphQL */ `
  query ChatWithUssEmbedStatus {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
        }
      }
    }
  }
`;

/**
 * Is the ChatWithUss app embed switched on in the live theme?
 * App embeds are stored in settings_data.json → current.blocks:
 *   { "type": "shopify://apps/<app>/blocks/chat-widget/<uuid>", "disabled": false }
 * Returns true / false, or null when it can't be determined.
 */
export function embedEnabledFromSettings(raw, blockHandle = 'chat-widget') {
  let json;
  try {
    json = JSON.parse(String(raw).replace(/^﻿/, '').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  } catch {
    return null;
  }
  let current = json?.current;
  if (typeof current === 'string') current = json?.presets?.[current];
  const blocks = current?.blocks;
  if (!blocks || typeof blocks !== 'object') return false;
  const needle = `/blocks/${blockHandle}/`;
  return Object.values(blocks).some((b) => typeof b?.type === 'string' && b.type.startsWith('shopify://apps/') && b.type.includes(needle) && b.disabled !== true);
}

export async function getEmbedStatus(admin, blockHandle) {
  const data = await admin.graphql(THEME_SETTINGS_QUERY);
  const theme = data?.themes?.nodes?.[0];
  const content = theme?.files?.nodes?.[0]?.body?.content;
  return { theme: theme?.name || null, enabled: content ? embedEnabledFromSettings(content, blockHandle) : null };
}
