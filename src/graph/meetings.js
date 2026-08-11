import { graphGet, graphGetAll } from './client.js';
import { getCurrentUserId } from './auth.js';
import { daysAgo } from '../utils/timestamps.js';

/**
 * Discover meetings from the user's calendar within a date range.
 * Returns calendar events that have online meeting data.
 *
 * Paged: a busy 30-day window runs close to 100 events, so an unpaged request
 * would drop the oldest days of the range without any error.
 */
export async function discoverMeetings(lookbackDays) {
  const userId = getCurrentUserId();
  const startDateTime = daysAgo(lookbackDays);
  const endDateTime = new Date().toISOString();

  const events = await graphGetAll(`/v1.0/users/${userId}/calendarView`, {
    startDateTime,
    endDateTime,
    $select: 'id,subject,organizer,attendees,start,end,isOnlineMeeting,onlineMeeting,bodyPreview',
    $orderby: 'start/dateTime desc',
    $top: '100',
  });

  return events.filter((event) => event.isOnlineMeeting);
}

/**
 * Get the online meeting ID from a join URL.
 */
export async function getOnlineMeetingByJoinUrl(joinWebUrl) {
  const userId = getCurrentUserId();
  const result = await graphGet(`/v1.0/users/${userId}/onlineMeetings`, {
    $filter: `JoinWebUrl eq '${joinWebUrl}'`,
  });
  const meetings = result.value || [];
  return meetings[0] || null;
}

/**
 * Extract attendee emails from a calendar event.
 */
export function extractAttendees(event) {
  const attendees = [];
  if (event.organizer?.emailAddress?.address) {
    attendees.push(event.organizer.emailAddress.address.toLowerCase());
  }
  if (event.attendees) {
    for (const a of event.attendees) {
      if (a.emailAddress?.address) {
        attendees.push(a.emailAddress.address.toLowerCase());
      }
    }
  }
  return [...new Set(attendees)];
}
