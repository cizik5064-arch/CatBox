const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseChannels } = require('../lib/channels');

describe('potocs.json (real file)', () => {
  const jsonPath = path.join(__dirname, '..', 'potocs.json');

  it('file exists', () => {
    assert.equal(fs.existsSync(jsonPath), true);
  });

  it('parses into sorted channels with expected ids', () => {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const list = parseChannels(raw);

    assert.ok(list.length >= 6);
    const ids = list.map((c) => c.id);
    for (const expected of [1, 4, 12, 15, 19, 20]) {
      assert.ok(ids.includes(expected), `missing channel id ${expected}`);
    }

    // Must be sorted ascending
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].id > list[i - 1].id);
    }
  });

  it('ytdlp channels have source flag', () => {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const list = parseChannels(raw);
    const ytdlp = list.filter((c) => c.source === 'ytdlp');
    assert.ok(ytdlp.length >= 2);
    ytdlp.forEach((c) => {
      assert.match(c.link, /^https?:\/\//);
    });
  });

  it('first channel is the one with smallest id', () => {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const list = parseChannels(raw);
    assert.equal(list[0].id, Math.min(...list.map((c) => c.id)));
  });
});
