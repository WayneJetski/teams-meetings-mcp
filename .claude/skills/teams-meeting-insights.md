---
name: teams-meeting-insights
description: >
  Retrieve and analyze Microsoft Teams meeting AI insights, summaries, transcripts,
  and action items via the Microsoft Graph API. Ask about meetings, decisions,
  action items, and key discussion points from recent Teams meetings.
triggers:
  - meetings
  - meeting
  - teams
  - action items
  - transcript
  - meeting summary
  - meeting insights
  - meeting recap
  - daily sync
  - standup
  - what happened in
  - decisions from
  - important things
  - calls
  - recording
  - recordings
---

# Teams Meeting Insights Skill

You help users query their Microsoft Teams meeting data including AI-generated
summaries, transcripts, action items, and key decisions using the Microsoft
Graph API.

## Environment Variables

This skill requires the following environment variables. **Check for them first
and clearly tell the user which ones are missing before attempting any API calls.**

### Required

| Variable | Description |
|----------|-------------|
| `TEAMS_CLIENT_ID` | Azure AD app registration Application (client) ID |
| `TEAMS_TENANT_ID` | Azure AD tenant ID (directory ID) |

### Authentication (one of the following)

| Variable | Description |
|----------|-------------|
| `TEAMS_ACCESS_TOKEN` | A valid Microsoft Graph access token (short-lived, ~1 hour) |
| `TEAMS_REFRESH_TOKEN` | An OAuth2 refresh token for automatic token renewal |
| `TEAMS_CLIENT_SECRET` | App client secret for client credentials flow (limited: no delegated permissions) |

### Recommended Scopes

The access token must include these Microsoft Graph permissions:
- `Calendars.Read` - to list meetings from the calendar
- `OnlineMeetings.Read` - to read online meeting details
- `OnlineMeetingTranscript.Read.All` - to read meeting transcripts
- `User.Read` - to get the authenticated user's profile

### Setup Instructions (tell the user if env vars are missing)

If environment variables are not set, provide these setup instructions:

1. **Register an Azure AD App:**
   - Go to https://portal.azure.com → Azure Active Directory → App registrations → New registration
   - Set redirect URI to `http://localhost` (for device code flow) or `https://login.microsoftonline.com/common/oauth2/nativeclient`
   - Note the Application (client) ID and Directory (tenant) ID

2. **Configure API Permissions:**
   - Add Microsoft Graph delegated permissions: `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `User.Read`
   - Grant admin consent if required by your organization

3. **Enable public client flow** (for device code auth):
   - Under Authentication → Advanced settings → Allow public client flows → Yes

4. **Get a token** (device code flow example):
   ```bash
   # Request device code
   curl -X POST "https://login.microsoftonline.com/${TEAMS_TENANT_ID}/oauth2/v2.0/devicecode" \
     -d "client_id=${TEAMS_CLIENT_ID}" \
     -d "scope=https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/OnlineMeetings.Read https://graph.microsoft.com/OnlineMeetingTranscript.Read.All https://graph.microsoft.com/User.Read offline_access"

   # Follow the instructions to sign in, then exchange the device code for tokens:
   curl -X POST "https://login.microsoftonline.com/${TEAMS_TENANT_ID}/oauth2/v2.0/token" \
     -d "client_id=${TEAMS_CLIENT_ID}" \
     -d "grant_type=urn:ietf:params:oauth:grant_type:device_code" \
     -d "device_code=<DEVICE_CODE_FROM_ABOVE>"
   ```

5. **Set environment variables:**
   ```bash
   export TEAMS_CLIENT_ID="your-client-id"
   export TEAMS_TENANT_ID="your-tenant-id"
   export TEAMS_ACCESS_TOKEN="your-access-token"
   # Or for auto-refresh:
   export TEAMS_REFRESH_TOKEN="your-refresh-token"
   ```

## How to Use the Helper Scripts

The repo includes helper scripts in `scripts/`. Use them via Bash:

```bash
# List recent meetings (default: last 7 days)
bash scripts/teams-graph.sh meetings

# List meetings from the last N days
bash scripts/teams-graph.sh meetings 3

# Search meetings by subject
bash scripts/teams-graph.sh search "Daily Sync"
bash scripts/teams-graph.sh search "Project X" 14

# Get transcripts for a meeting (need the online meeting ID)
bash scripts/teams-graph.sh transcripts <meetingId>

# Get transcript content
bash scripts/teams-graph.sh transcript <meetingId> <transcriptId>

# Get AI insights (beta - requires Microsoft 365 Copilot license)
bash scripts/teams-graph.sh insights <meetingId>
```

## Workflow for Answering User Questions

Follow this workflow when a user asks about their meetings:

### Step 1: Check Environment Variables

```bash
echo "CLIENT_ID=${TEAMS_CLIENT_ID:-NOT SET} | TENANT_ID=${TEAMS_TENANT_ID:-NOT SET} | ACCESS_TOKEN=${TEAMS_ACCESS_TOKEN:+SET}${TEAMS_ACCESS_TOKEN:-NOT SET} | REFRESH_TOKEN=${TEAMS_REFRESH_TOKEN:+SET}${TEAMS_REFRESH_TOKEN:-NOT SET} | CLIENT_SECRET=${TEAMS_CLIENT_SECRET:+SET}${TEAMS_CLIENT_SECRET:-NOT SET}"
```

If required vars are missing, show the user the setup instructions above and stop.

### Step 2: Determine the Time Range

- "yesterday" → `meetings 1` (but filter to yesterday's date)
- "today" → `meetings 1` (filter to today)
- "this week" → `meetings 7`
- "last week" → `meetings 14` (filter to last week's dates)
- "last month" → `meetings 30`
- Default to `meetings 7` if no time range specified.

### Step 3: Find Relevant Meetings

- If the user mentions a specific meeting name, use `search "<name>"`.
- Otherwise, list meetings for the relevant time range.
- Parse the JSON response to identify meetings.

### Step 4: Get Meeting Details

For each relevant meeting, determine what data to fetch:

1. **For summaries/recaps:** Try AI insights first (`insights <meetingId>`), fall back to transcript.
2. **For action items:** Try AI insights first, then scan transcript content.
3. **For specific topics/decisions:** Fetch transcript content and search for relevant discussion.
4. **For attendee info:** The calendar event response includes attendees.

To get the online meeting ID from a calendar event:
- The calendar event's `onlineMeeting.joinUrl` can be used with `meeting-detail <joinUrl>` to get the online meeting ID.

### Step 5: Process and Present

- Summarize findings in a clear, organized format.
- Group by meeting if multiple meetings are relevant.
- Highlight action items, decisions, and key discussion points.
- Include meeting date, time, and attendees for context.
- If transcripts/insights are unavailable, let the user know (transcription may not have been enabled, or insights may take up to 4 hours after the meeting).

## Important Notes

- **AI Insights are in beta** and require a Microsoft 365 Copilot license. They may not be available for all users or meeting types. If the insights endpoint returns an error, fall back to transcript data.
- **Transcripts** are only available if transcription was enabled during the meeting.
- **Channel meetings, town halls, and webinars** may not support AI insights yet.
- **Insights can take up to 4 hours** to generate after a meeting ends.
- **Never expose tokens** in output shown to the user. When printing debug info, mask tokens.
- **Rate limiting:** If you get HTTP 429, wait and retry.
- The `calendarView` endpoint is preferred over `/me/events` because it expands recurring meeting instances.
