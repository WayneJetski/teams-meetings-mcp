import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dependency-free: vttParser imports nothing, so this runs under `npm test`
// without installing node_modules (matching the repo's test style).
import { parseVtt } from '../src/utils/vttParser.js';

test('parses speaker-attributed WebVTT (text/vtt)', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:03.663 --> 00:00:07.903',
    '<v Sarah>We need to finalize the auth migration by Friday.</v>',
    '',
    '00:00:08.100 --> 00:00:10.200',
    "<v Braden>Agreed, I'll take the first pass.</v>",
    '',
  ].join('\n');

  const { utterances, full_text } = parseVtt(vtt);

  assert.equal(utterances.length, 2);
  assert.deepEqual(utterances[0], {
    speaker: 'Sarah',
    text: 'We need to finalize the auth migration by Friday.',
    start: '00:00:03.663',
    end: '00:00:07.903',
  });
  assert.equal(utterances[1].speaker, 'Braden');
  assert.equal(full_text.split('\n').length, 2);
});

test('parses unattributed transcript+text (speaker attribution disabled)', () => {
  // application/vnd.microsoft.graph.transcript+text: no WEBVTT header, no
  // <v Speaker> tags, and a blank line between each timestamp and its text.
  const plain = [
    '00:00:01.500 --> 00:00:04.000 ',
    '',
    'Hello, thanks for joining. ',
    '',
    '00:00:04.000 --> 00:00:07.200 ',
    '',
    'Glad to be here. ',
    '',
  ].join('\n');

  const { utterances, full_text } = parseVtt(plain);

  assert.equal(utterances.length, 2);
  assert.deepEqual(utterances[0], {
    speaker: 'Unknown',
    text: 'Hello, thanks for joining.',
    start: '00:00:01.500',
    end: '00:00:04.000',
  });
  assert.equal(utterances[1].text, 'Glad to be here.');
  assert.equal(full_text, 'Unknown: Hello, thanks for joining.\nUnknown: Glad to be here.');
});
