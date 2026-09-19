import { Router } from 'express';
import { indexMeeting, listMeetings, getMeeting, searchMeetings, meetingStats, deduplicateMeetings, saveLastSyncTimestamp } from '../elasticsearch.js';
import { buildMeetingDoc, manualTimes } from '../meetingDoc.js';
import { runSync, getSyncStatus } from '../sync/engine.js';
import { exportMeetings, importMeetings } from '../exportImport.js';
import { now } from '../utils/timestamps.js';

const router = Router();

// Note: /health is mounted directly in index.js (public, no auth required)

router.post('/sync', async (req, res) => {
  const lookbackDays = req.body?.lookback_days;
  try {
    const result = await runSync(lookbackDays);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/sync/status', async (req, res) => {
  res.json(await getSyncStatus());
});

// Manual override for a watermark stuck behind a real, since-resolved outage
// (see classifyUncaptured in sync/syncWindow.js) — drops whatever backlog it
// was holding and starts the next incremental sync fresh from now.
router.post('/sync/reset-watermark', async (req, res) => {
  try {
    const lastSync = now();
    await saveLastSyncTimestamp(lastSync);
    res.json({ status: 'ok', lastSync });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.post('/ingest', async (req, res) => {
  const meetings = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];

  for (const meeting of meetings) {
    if (!meeting.meeting_id) {
      results.push({ error: 'meeting_id is required' });
      continue;
    }
    try {
      await indexMeeting(buildMeetingDoc({
        meetingId: meeting.meeting_id,
        onlineMeetingId: meeting.online_meeting_id || null,
        title: meeting.title,
        organizer: meeting.organizer || '',
        attendees: meeting.attendees || [],
        times: manualTimes({
          start: meeting.start_time || null,
          end: meeting.end_time || null,
          duration: meeting.duration_minutes ?? null,
        }),
        summary: meeting.summary || null,
        meetingNotes: meeting.meeting_notes || [],
        actionItems: meeting.action_items || [],
        decisions: meeting.decisions || [],
        topics: meeting.topics || [],
        transcriptText: meeting.transcript_text || null,
        dataSource: meeting.data_source || 'manual',
      }));
      results.push({ meeting_id: meeting.meeting_id, status: 'indexed' });
    } catch (err) {
      results.push({ meeting_id: meeting.meeting_id, error: err.message });
    }
  }

  res.json({ results });
});

// Dashboard API endpoints
router.get('/api/meetings', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const result = await listMeetings({ limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/meetings/:id', async (req, res) => {
  try {
    const meeting = await getMeeting(req.params.id, req.query.transcript === 'true');
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/meetings/:id/export', async (req, res) => {
  try {
    const envelope = await exportMeetings([req.params.id], {
      exportedBy: req.session?.user?.email || null,
      timeZone: req.query.tz,
    });
    if (!envelope.meetings.length) return res.status(404).json({ error: 'Meeting not found' });
    const filename = envelope.meetings[0].export_filename || `${req.params.id}.json`;
    const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/meetings/import', async (req, res) => {
  try {
    const result = await importMeetings(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/search', async (req, res) => {
  try {
    const results = await searchMeetings({
      query: req.query.q,
      attendee: req.query.attendee,
      dateFrom: req.query.from,
      dateTo: req.query.to,
      limit: parseInt(req.query.limit || '20', 10),
    });
    res.json({ meetings: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/stats', async (req, res) => {
  try {
    const stats = await meetingStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/deduplicate', async (req, res) => {
  try {
    const result = await deduplicateMeetings();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

export default router;
