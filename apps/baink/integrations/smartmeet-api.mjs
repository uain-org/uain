const MAX_RESPONSE_BYTES = 1024 * 1024;

async function boundedMeetingJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid meeting response');
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
      throw new Error('Meeting response too large');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Meeting response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Server-only adapter for SmartMeet's existing integrator API.
 * Deliberately read-only. Creating meetings can send mail/WhatsApp and invoke
 * providers; summary GET can generate and persist model output upstream.
 * Never import this module with configured credentials into a browser bundle.
 */
export function createSmartMeetClient({
  apiOrigin = '',
  apiKey = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let origin = '';
  if (apiOrigin) {
    let parsed;
    try {
      parsed = new URL(apiOrigin);
    } catch {
      throw new Error('SmartMeet API requires an HTTPS origin');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('SmartMeet API requires an HTTPS origin');
    }
    origin = parsed.origin;
  }
  const configured = Boolean(origin && key);
  return Object.freeze({
    configured,
    async listMeetings({ status = 'all', limit = 20, offset = 0 } = {}) {
      if (!configured) return { status: 'not-configured', meetings: null };
      if (!['all', 'upcoming', 'started', 'ended'].includes(status))
        throw new Error('Invalid SmartMeet status');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid SmartMeet limit');
      if (!Number.isInteger(offset) || offset < 0)
        throw new Error('Invalid SmartMeet offset');
      const url = new URL('/meeting-suite/v1/api/external/meetings', origin);
      url.search = new URLSearchParams({
        status,
        limit: String(limit),
        offset: String(offset),
      }).toString();
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-API-Key': key,
            'X-Platform-Name': 'BAINK',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error('SmartMeet request unavailable');
      }
      if (!response.ok) {
        const error = new Error(
          `SmartMeet request failed (${response.status})`,
        );
        error.status = response.status;
        throw error;
      }
      let data;
      try {
        data = await boundedMeetingJson(response);
      } catch {
        throw new Error('SmartMeet returned an invalid meeting list');
      }
      if (
        data?.ok !== true ||
        !Array.isArray(data.meetings) ||
        data.meetings.length > limit ||
        (data.pagination != null && (
          !Number.isSafeInteger(data.pagination.total) || data.pagination.total < 0 ||
          data.pagination.limit !== limit || data.pagination.offset !== offset ||
          typeof data.pagination.hasMore !== 'boolean'
        )) ||
        data.meetings.some(
          (meeting) => !meeting || typeof meeting.meetingId !== 'string',
        )
      ) {
        throw new Error('SmartMeet returned an invalid meeting list');
      }
      return {
        status: 'available',
        meetings: data.meetings.map((meeting) => ({
          id: meeting.meetingId,
          title: typeof meeting.title === 'string' ? meeting.title : '',
          date: typeof meeting.date === 'string' ? meeting.date : '',
          time: typeof meeting.time === 'string' ? meeting.time : '',
          state: meeting.isMeetingEnded
            ? 'ended'
            : meeting.isMeetingStarted
              ? 'started'
              : 'upcoming',
          url: safeMeetingUrl(meeting.joinUrl, meeting.meetingId),
        })),
        pagination: data.pagination
          ? {
              total: data.pagination.total,
              limit: data.pagination.limit,
              offset: data.pagination.offset,
              hasMore: data.pagination.hasMore,
            }
          : null,
      };
    },
  });
}

function safeMeetingUrl(value, meetingId) {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://smartmeet.org' ||
      url.username ||
      url.password ||
      !/^\/meeting\/[^/]+\/?$/.test(url.pathname) ||
      ![`/meeting/${meetingId}`, `/meeting/${meetingId}/`].includes(url.pathname)
    )
      return null;
    // Listing does not provide join credentials. Do not propagate a changed
    // upstream token or tracking query through BAINK's product navigation.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
