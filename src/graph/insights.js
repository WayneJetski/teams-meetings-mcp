import { graphGet } from './client.js';
import { getCurrentUserId } from './auth.js';

/**
 * Fetch AI insights for a meeting (requires M365 Copilot license).
 * Returns structured meeting notes, action items, and mentions.
 */
export async function fetchAiInsights(onlineMeetingId) {
  const userId = getCurrentUserId();
  try {
    const result = await graphGet(
      `/beta/copilot/users/${userId}/onlineMeetings/${onlineMeetingId}/aiInsights`
    );

    const meetingNotes = [];
    const actionItems = [];
    const decisions = [];
    const topics = [];

    if (result.value) {
      for (const insight of result.value) {
        if (insight['@odata.type'] === '#microsoft.graph.meetingNotes' || insight.contentType === 'meetingNotes') {
          meetingNotes.push({
            title: insight.title || '',
            text: insight.content || insight.text || '',
            subpoints: insight.subpoints || [],
          });
        }

        if (insight['@odata.type'] === '#microsoft.graph.actionItem' || insight.contentType === 'actionItem') {
          actionItems.push({
            title: insight.title || '',
            text: insight.content || insight.text || '',
            owner: insight.ownerDisplayName || insight.owner || 'Unassigned',
          });
        }
      }
    }

    // Also check top-level fields if present
    if (result.meetingNotes) {
      for (const note of result.meetingNotes) {
        meetingNotes.push({
          title: note.title || '',
          text: note.text || note.content || '',
          subpoints: note.subpoints || [],
        });
      }
    }

    if (result.actionItems) {
      for (const item of result.actionItems) {
        actionItems.push({
          title: item.title || '',
          text: item.text || item.content || '',
          owner: item.ownerDisplayName || 'Unassigned',
        });
      }
    }

    // Extract topics from notes titles
    for (const note of meetingNotes) {
      if (note.title) topics.push(note.title);
    }

    // Build summary from notes
    const summary = meetingNotes.map((n) => n.text).filter(Boolean).join(' ');

    return {
      meetingNotes,
      actionItems,
      decisions,
      topics,
      summary: summary || null,
      raw: result,
    };
  } catch (err) {
    if (err.message?.includes('404') || err.message?.includes('NotFound')) {
      return null; // Insights not available
    }
    throw err;
  }
}
