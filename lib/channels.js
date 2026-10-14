/**
 * Pure channel parsing & navigation helpers for CatBox.
 * No Electron / DOM / network — fully unit-testable.
 */

/**
 * Parse raw potocs.json object into sorted channel list.
 * @param {object} raw - Object with string keys ("1", "4", ...) and channel objects
 * @returns {Array<{id: number, name: string, description: string, link: string, source: string|null}>}
 */
function parseChannels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  return Object.keys(raw)
    .map((key) => {
      const entry = raw[key];
      if (!entry || typeof entry !== 'object') return null;
      const id = parseInt(key, 10);
      if (isNaN(id) || !entry.link) return null;
      return {
        id,
        name: entry.name || `Channel ${key}`,
        description: entry.description || '',
        link: entry.link,
        source: entry.source || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

/**
 * Find index of channel by its numeric id.
 * @param {Array} channels
 * @param {number} id
 * @returns {number} index or -1
 */
function findChannelIndexById(channels, id) {
  if (!Array.isArray(channels)) return -1;
  return channels.findIndex((c) => c.id === id);
}

/**
 * Wrap index into [0, length).
 * @param {number} index
 * @param {number} length
 * @returns {number}
 */
function wrapIndex(index, length) {
  if (!length || length <= 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

/**
 * Next / previous channel index.
 * @param {number} currentIndex
 * @param {number} length
 * @param {'up'|'down'} direction - up = previous, down = next
 */
function navigateIndex(currentIndex, length, direction) {
  if (direction === 'up') {
    return wrapIndex(currentIndex - 1, length);
  }
  return wrapIndex(currentIndex + 1, length);
}

/**
 * Number-input state machine (pure).
 * Appends digit, returns new buffer. Caller decides when to commit (after timeout).
 * @param {string} buffer - current digits string
 * @param {string} digit - single char '0'-'9'
 * @returns {string} new buffer
 */
function appendDigit(buffer, digit) {
  if (!/^[0-9]$/.test(digit)) return buffer || '';
  return String(buffer || '') + digit;
}

/**
 * Try to resolve number buffer to a channel index.
 * @param {Array} channels
 * @param {string} buffer
 * @returns {number} index or -1 if not found / invalid
 */
function resolveNumberBuffer(channels, buffer) {
  if (!buffer || !/^\d+$/.test(buffer)) return -1;
  const num = parseInt(buffer, 10);
  if (isNaN(num)) return -1;
  return findChannelIndexById(channels, num);
}

/**
 * Decide whether a stream URL looks like HLS.
 * @param {string} url
 * @returns {boolean}
 */
function isHlsUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('.m3u8') ||
    lower.includes('m3u8') ||
    lower.includes('application/vnd.apple.mpegurl')
  );
}

module.exports = {
  parseChannels,
  findChannelIndexById,
  wrapIndex,
  navigateIndex,
  appendDigit,
  resolveNumberBuffer,
  isHlsUrl,
};
