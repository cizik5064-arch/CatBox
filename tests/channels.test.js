const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseChannels,
  findChannelIndexById,
  wrapIndex,
  navigateIndex,
  appendDigit,
  resolveNumberBuffer,
  isHlsUrl,
  safeParseChannelsJson,
  MAX_DIGIT_BUFFER_LENGTH,
} = require('../lib/channels');

describe('parseChannels', () => {
  const sample = {
    '1': {
      name: 'Первый канал (пример)',
      description: 'Тестовый поток',
      link: 'https://example.com/stream1.m3u8',
    },
    '4': {
      name: 'НТВ',
      link: 'https://rutube.ru/video/c37cd74192c6bc3d6cd6077c0c4fd686/?r=plwd',
      source: 'ytdlp',
    },
    '12': {
      name: 'Спас',
      link: 'https://tvspas.mediacdn.ru/cdn/spas/playlist.m3u8',
    },
    '15': {
      name: 'Бобёр',
      link: 'https://tvcdnpotok.com/0kd5-xImgCR8NDqM2eizNw/189/1791792289/index.m3u8',
    },
    '19': {
      name: 'ТНТ',
      link: 'https://rutube.ru/video/546602986e6a424d74d594876ddb3f04/?r=wd',
      source: 'ytdlp',
    },
    '20': {
      name: 'Союз',
      description: 'Православный канал - Союз.',
      link: 'https://hls-tvsoyuz.cdnvideo.ru/tvsoyuz/soyuz/playlist.m3u8',
    },
  };

  it('parses and sorts channels by numeric id', () => {
    const list = parseChannels(sample);
    assert.equal(list.length, 6);
    assert.deepEqual(list.map((c) => c.id), [1, 4, 12, 15, 19, 20]);
  });

  it('preserves name, description, link, source', () => {
    const list = parseChannels(sample);
    const ntv = list.find((c) => c.id === 4);
    assert.equal(ntv.name, 'НТВ');
    assert.equal(ntv.source, 'ytdlp');
    assert.ok(ntv.link.includes('rutube.ru'));

    const soyuz = list.find((c) => c.id === 20);
    assert.ok(soyuz.description.includes('Союз'));
    assert.equal(soyuz.source, null);
  });

  it('skips entries without link', () => {
    const raw = {
      '1': { name: 'OK', link: 'http://x' },
      '2': { name: 'No link' },
      '3': { name: 'Empty link', link: '' },
    };
    const list = parseChannels(raw);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 1);
  });

  it('skips non-numeric keys', () => {
    const raw = {
      foo: { name: 'Bad', link: 'http://x' },
      '5': { name: 'Good', link: 'http://y' },
    };
    const list = parseChannels(raw);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 5);
  });

  it('returns empty array for invalid input', () => {
    assert.deepEqual(parseChannels(null), []);
    assert.deepEqual(parseChannels(undefined), []);
    assert.deepEqual(parseChannels([]), []);
    assert.deepEqual(parseChannels('string'), []);
    assert.deepEqual(parseChannels(42), []);
  });

  it('default name when missing', () => {
    const list = parseChannels({ '7': { link: 'http://z' } });
    assert.equal(list[0].name, 'Channel 7');
    assert.equal(list[0].description, '');
    assert.equal(list[0].source, null);
  });
});

describe('findChannelIndexById', () => {
  const channels = parseChannels({
    '1': { name: 'A', link: 'http://a' },
    '10': { name: 'B', link: 'http://b' },
    '99': { name: 'C', link: 'http://c' },
  });

  it('finds existing id', () => {
    assert.equal(findChannelIndexById(channels, 1), 0);
    assert.equal(findChannelIndexById(channels, 10), 1);
    assert.equal(findChannelIndexById(channels, 99), 2);
  });

  it('returns -1 for missing id', () => {
    assert.equal(findChannelIndexById(channels, 5), -1);
    assert.equal(findChannelIndexById(channels, 0), -1);
  });

  it('handles bad channels array', () => {
    assert.equal(findChannelIndexById(null, 1), -1);
    assert.equal(findChannelIndexById(undefined, 1), -1);
  });
});

describe('wrapIndex / navigateIndex', () => {
  it('wrapIndex boundaries', () => {
    assert.equal(wrapIndex(0, 5), 0);
    assert.equal(wrapIndex(4, 5), 4);
    assert.equal(wrapIndex(-1, 5), 4);
    assert.equal(wrapIndex(5, 5), 0);
    assert.equal(wrapIndex(100, 5), 0);
    assert.equal(wrapIndex(-10, 5), 4);
  });

  it('wrapIndex empty list', () => {
    assert.equal(wrapIndex(0, 0), 0);
    assert.equal(wrapIndex(-1, 0), 0);
  });

  it('navigate up (previous)', () => {
    assert.equal(navigateIndex(0, 4, 'up'), 3);
    assert.equal(navigateIndex(2, 4, 'up'), 1);
  });

  it('navigate down (next)', () => {
    assert.equal(navigateIndex(3, 4, 'down'), 0);
    assert.equal(navigateIndex(0, 4, 'down'), 1);
  });
});

describe('number input (appendDigit / resolveNumberBuffer)', () => {
  const channels = parseChannels({
    '1': { name: 'A', link: 'http://a' },
    '12': { name: 'B', link: 'http://b' },
    '79': { name: 'C', link: 'http://c' },
  });

  it('appendDigit builds multi-digit number', () => {
    let buf = '';
    buf = appendDigit(buf, '7');
    assert.equal(buf, '7');
    buf = appendDigit(buf, '9');
    assert.equal(buf, '79');
  });

  it('appendDigit ignores non-digits', () => {
    assert.equal(appendDigit('1', 'a'), '1');
    assert.equal(appendDigit('', 'x'), '');
    assert.equal(appendDigit('12', ' '), '12');
  });

  it('appendDigit enforces MAX_DIGIT_BUFFER_LENGTH (4) digit cap', () => {
    assert.equal(MAX_DIGIT_BUFFER_LENGTH, 4);

    let buf = '';
    for (const d of ['1', '2', '3', '4']) {
      buf = appendDigit(buf, d);
    }
    assert.equal(buf, '1234');

    // A 5th digit must be rejected — buffer stays exactly at 4 digits.
    buf = appendDigit(buf, '5');
    assert.equal(buf, '1234');
    assert.equal(buf.length, 4);

    // Further digits also keep being rejected.
    buf = appendDigit(buf, '9');
    assert.equal(buf, '1234');
  });

  it('appendDigit cap applies independently of digit values', () => {
    let buf = appendDigit(appendDigit(appendDigit(appendDigit('', '9'), '9'), '9'), '9');
    assert.equal(buf, '9999');
    assert.equal(appendDigit(buf, '0'), '9999');
  });

  it('resolveNumberBuffer finds channel', () => {
    assert.equal(resolveNumberBuffer(channels, '1'), 0);
    assert.equal(resolveNumberBuffer(channels, '12'), 1);
    assert.equal(resolveNumberBuffer(channels, '79'), 2);
  });

  it('resolveNumberBuffer returns -1 for unknown / invalid', () => {
    assert.equal(resolveNumberBuffer(channels, '99'), -1);
    assert.equal(resolveNumberBuffer(channels, ''), -1);
    assert.equal(resolveNumberBuffer(channels, 'abc'), -1);
    assert.equal(resolveNumberBuffer(channels, null), -1);
  });
});

describe('isHlsUrl', () => {
  it('detects m3u8', () => {
    assert.equal(isHlsUrl('https://cdn.example.com/live/playlist.m3u8'), true);
    assert.equal(isHlsUrl('https://x.com/index.M3U8?token=1'), true);
    assert.equal(isHlsUrl('http://a/b?fmt=m3u8'), true);
  });

  it('rejects non-hls', () => {
    assert.equal(isHlsUrl('https://example.com/video.mp4'), false);
    assert.equal(isHlsUrl('https://rutube.ru/video/abc'), false);
    assert.equal(isHlsUrl(''), false);
    assert.equal(isHlsUrl(null), false);
  });
});

describe('safeParseChannelsJson (potocs.json hot-reload safety)', () => {
  it('parses valid JSON into a sorted channel list', () => {
    const text = JSON.stringify({
      '2': { name: 'B', link: 'http://b' },
      '1': { name: 'A', link: 'http://a' },
    });
    const list = safeParseChannelsJson(text);
    assert.notEqual(list, null);
    assert.deepEqual(list.map((c) => c.id), [1, 2]);
  });

  it('returns null (not throw, not empty array) for invalid JSON', () => {
    // Simulates an editor mid-write: truncated/broken JSON.
    const brokenSamples = [
      '{ "1": { "name": "A", "link": "http://a"',   // truncated, unclosed
      '{ "1": { "name": "A" "link": "http://a" } }', // missing comma
      'not even json',
      '',
      '{ "1": { "name": "A", "link": "http://a", } }', // trailing comma
    ];
    for (const text of brokenSamples) {
      let threw = false;
      let result;
      try {
        result = safeParseChannelsJson(text);
      } catch (_) {
        threw = true;
      }
      assert.equal(threw, false, `safeParseChannelsJson must never throw for: ${JSON.stringify(text)}`);
      assert.equal(result, null, `expected null for invalid JSON: ${JSON.stringify(text)}`);
    }
  });

  it('null result is distinguishable from a legitimately empty channel list', () => {
    // Valid JSON that just has no usable channels → real empty array, not null.
    const emptyButValid = safeParseChannelsJson('{}');
    assert.notEqual(emptyButValid, null);
    assert.deepEqual(emptyButValid, []);

    // Invalid JSON → null, meaning "ignore this reload, keep old channels".
    const invalid = safeParseChannelsJson('{ broken');
    assert.equal(invalid, null);
  });

  it('valid JSON with non-object root still returns an array, not null', () => {
    // parseChannels() itself defends against these inputs; safeParseChannelsJson
    // should pass that behavior through rather than treating them as a parse failure.
    assert.deepEqual(safeParseChannelsJson('[]'), []);
    assert.deepEqual(safeParseChannelsJson('42'), []);
    assert.deepEqual(safeParseChannelsJson('"just a string"'), []);
  });
});
