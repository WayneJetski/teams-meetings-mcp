/**
 * Parse a WebVTT transcript into structured JSON.
 *
 * Expected format:
 *   WEBVTT
 *
 *   00:00:03.663 --> 00:00:07.903
 *   <v Sarah>We need to finalize the auth migration by Friday.</v>
 */
export function parseVtt(vttContent) {
  const utterances = [];
  const lines = vttContent.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Match timestamp line: 00:00:03.663 --> 00:00:07.903
    const tsMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})$/);
    if (tsMatch) {
      const start = tsMatch[1];
      const end = tsMatch[2];
      i++;

      // Collect all text lines until the next blank line
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      const rawText = textLines.join(' ');

      // Extract speaker from <v Name>text</v> format
      const speakerMatch = rawText.match(/^<v\s+([^>]+)>(.*?)<\/v>$/s);
      const speaker = speakerMatch ? speakerMatch[1].trim() : 'Unknown';
      const text = speakerMatch ? speakerMatch[2].trim() : rawText.replace(/<[^>]*>/g, '').trim();

      if (text) {
        utterances.push({ speaker, text, start, end });
      }
    }

    i++;
  }

  const fullText = utterances.map((u) => `${u.speaker}: ${u.text}`).join('\n');

  return { utterances, full_text: fullText };
}
