import { Router } from 'express';
import { indexMeeting, listMeetings, getMeeting, searchMeetings, meetingStats, deduplicateMeetings } from '../elasticsearch.js';
import { buildMeetingDoc, manualTimes } from '../meetingDoc.js';
import { runSync, getSyncStatus } from '../sync/engine.js';

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
