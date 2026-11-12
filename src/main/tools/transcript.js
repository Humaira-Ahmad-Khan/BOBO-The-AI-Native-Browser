'use strict';

/**
 * BOBO YouTube Transcript Extractor Service.
 *
 * Detects YouTube video pages, extracts caption/transcript cues, supports
 * interactive seeking, and exports in TXT, SRT, VTT, CSV, and PDF formats.
 */

const { cleanText, escapeHtmlText } = require('./lib');
const { formatCsv } = require('./export');

/**
 * Extract YouTube Video ID from any valid YouTube URL format.
 */
function parseYouTubeVideoId(urlStr) {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        return url.searchParams.get('v') || null;
      }
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/')[2] || null;
      }
      if (url.pathname.startsWith('/embed/')) {
        return url.pathname.split('/')[2] || null;
      }
    } else if (host === 'youtu.be') {
      return url.pathname.slice(1) || null;
    }
  } catch {}
  return null;
}

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 */
function toSrtTimestamp(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  const millis = Math.floor((sec % 1) * 1000);

  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
}

/**
 * Format seconds to WebVTT timestamp: HH:MM:SS.mmm
 */
function toVttTimestamp(seconds) {
  return toSrtTimestamp(seconds).replace(',', '.');
}

/**
 * Format seconds to human display: MM:SS or HH:MM:SS
 */
function toDisplayTimestamp(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * In-page script to extract video metadata and transcript cues.
 */
const EXTRACT_TRANSCRIPT_SCRIPT = `
(async () => {
  try {
    const sourceUrl = window.location.href;
    const video = document.querySelector('video');
    const titleEl = document.querySelector('h1.ytd-watch-metadata, #title h1, h1');
    const title = titleEl ? titleEl.textContent.trim() : document.title.replace(/- YouTube$/i, '').trim();

    // 1. Check player caption tracks
    const tracks = video ? Array.from(video.textTracks || []).filter(
      (track) => track.kind === 'captions' || track.kind === 'subtitles'
    ) : [];
    const availableLanguages = tracks.map((t, idx) => ({
      index: idx,
      label: t.label || t.language || ('Track ' + (idx + 1)),
      language: t.language || 'en'
    }));
    const requestedLanguage = typeof window.__boboTranscriptLanguage === 'string'
      ? window.__boboTranscriptLanguage : 'auto';

    const readPanel = () => {
      const segments = [];
      const timestamp = /^((?:\\d{1,3}:)?\\d{1,3}:\\d{2})(?![\\d:])\\s*(.*)$/;
      const makeCue = (startText, text) => ({
        start: startText.split(':').reduce((sum, part) => sum * 60 + Number(part), 0),
        startText,
        text: text.trim(),
      });
      for (const el of document.querySelectorAll('ytd-transcript-segment-renderer, yt-transcript-segment-view-model, transcript-segment-view-model')) {
        const timeEl = el.querySelector('.segment-timestamp, [class*="timestamp" i]');
        const textEl = el.querySelector('.segment-text, [class*="segment-text" i], [class*="segmentText" i]');
        const combined = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().match(timestamp);
        const startText = timeEl?.textContent.trim().match(timestamp)?.[1] || combined?.[1];
        const text = textEl?.textContent.trim() || combined?.[2];
        if (startText && text) segments.push(makeCue(startText, text));
      }
      if (!segments.length) {
        const search = document.querySelector('[placeholder*="Search transcript" i], [aria-label*="Search transcript" i]');
        const panel = document.querySelector('[target-id*="transcript" i]:not([hidden]), ytd-transcript-renderer:not([hidden]), yt-transcript-renderer:not([hidden])')
          || search?.closest('ytd-engagement-panel-section-list-renderer, [role="dialog"], [class*="transcript" i][class*="panel" i]');
        // New layouts can render transcript rows without stable element names.
        // Only parse text within the transcript panel or the search box's section.
        const readText = (container) => {
          const cues = [];
          let cue;
          for (const line of (container?.innerText || '').split(/\\r?\\n/)) {
            const match = line.trim().match(timestamp);
            if (match) {
              cue = makeCue(match[1], match[2]);
              cues.push(cue);
            } else if (cue && line.trim()) cue.text += ' ' + line.trim();
          }
          return cues.filter((entry) => entry.text.trim()).map((entry) => ({ ...entry, text: entry.text.trim() }));
        };
        const panelCues = readText(panel);
        if (panelCues.length) return panelCues;
        for (let container = search?.parentElement, depth = 0;
          container && container !== document.body && depth < 7;
          container = container.parentElement, depth++) {
          const cues = readText(container);
          if (cues.length) return cues;
        }
      }
      return segments;
    };

    let segments = readPanel();
    if (!segments.length) {
      const requested = requestedLanguage === 'auto' ? null
        : tracks.find((item) => item.language === requestedLanguage);
      const track = requested
        || tracks.find((item) => item.mode === 'showing' && item.cues?.length)
        || tracks.find((item) => item.cues?.length);
      for (const cue of Array.from(track?.cues || [])) {
        if (cue.text?.trim()) segments.push({ start: cue.startTime, text: cue.text.trim() });
      }
    }

    if (!segments.length) {
      const findButton = () => Array.from(document.querySelectorAll('button')).find((button) =>
        !button.disabled && !button.closest('[hidden], [aria-hidden="true"]') &&
        [button.getAttribute('aria-label'), button.textContent].some((label) =>
          label?.trim().toLowerCase() === 'show transcript'));
      const wait = () => new Promise((resolve) => setTimeout(resolve, 200));
      let button = findButton();
      const expand = button ? null : document.querySelector('#description-inline-expander #expand');
      if (expand?.getClientRects().length) {
        expand.click();
        for (let i = 0; i < 10 && !button && window.location.href === sourceUrl; i++) {
          await wait();
          button = findButton();
        }
      }
      if (button && window.location.href === sourceUrl) {
        button.click();
        for (let i = 0; i < 40 && !segments.length && window.location.href === sourceUrl; i++) {
          await wait();
          segments = readPanel();
        }
      }
    }
    if (window.location.href !== sourceUrl) return { ok: false, error: 'The video changed during extraction.' };

    return {
      ok: true,
      title,
      url: window.location.href,
      hasVideo: !!video,
      language: requestedLanguage,
      availableLanguages,
      segments
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})()
`;

/**
 * Seek active YouTube video player to given seconds.
 */
function makeSeekScript(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  return `
(() => {
  const v = document.querySelector('video');
  if (v) {
    v.currentTime = ${s};
    v.play().catch(() => {});
  }
})()
`;
}

const LANGUAGE = /^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/;

class YouTubeTranscriptService {
  async detectAndExtract(webContents, { language = 'auto' } = {}) {
    if (!webContents || webContents.isDestroyed()) {
      throw new Error('BOBO: Active tab web contents unavailable');
    }
    const currentUrl = webContents.getURL() || '';
    const videoId = parseYouTubeVideoId(currentUrl);

    if (!videoId) {
      return {
        ok: true,
        isYouTube: false,
        message: 'Active tab is not a supported YouTube video page.',
      };
    }

    const targetLanguage = LANGUAGE.test(String(language)) ? String(language) : 'auto';
    const script = targetLanguage === 'auto'
      ? EXTRACT_TRANSCRIPT_SCRIPT
      : `window.__boboTranscriptLanguage = ${JSON.stringify(targetLanguage)};\n${EXTRACT_TRANSCRIPT_SCRIPT}`;
    const inPageData = await webContents.executeJavaScript(script);
    if (!inPageData?.ok) throw new Error('BOBO: Could not read captions from the active YouTube page.');
    return {
      ok: true,
      isYouTube: true,
      videoId,
      title: inPageData.title || 'YouTube Video',
      url: currentUrl,
      language: targetLanguage,
      segments: (inPageData.segments || []).map((segment) => ({
        ...segment,
        startText: segment.startText || toDisplayTimestamp(segment.start),
      })),
      availableLanguages: inPageData.availableLanguages || [],
    };
  }

  async seek(webContents, seconds) {
    if (!webContents || webContents.isDestroyed()) return { ok: false };
    await webContents.executeJavaScript(makeSeekScript(seconds));
    return { ok: true, seeked: seconds };
  }

  formatTranscript(segments, format = 'txt', metadata = {}) {
    if (!Array.isArray(segments) || !segments.length) {
      throw new Error('BOBO: No transcript segments available');
    }

    const title = metadata.title || 'YouTube Video';
    const url = metadata.url || '';

    switch (format.toLowerCase()) {
      case 'srt': {
        return segments
          .map((seg, idx) => {
            const nextStart = segments[idx + 1]?.start || seg.start + 3;
            return `${idx + 1}\r\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(nextStart)}\r\n${seg.text}\r\n`;
          })
          .join('\r\n');
      }
      case 'vtt': {
        const body = segments
          .map((seg, idx) => {
            const nextStart = segments[idx + 1]?.start || seg.start + 3;
            return `${toVttTimestamp(seg.start)} --> ${toVttTimestamp(nextStart)}\r\n${seg.text}`;
          })
          .join('\r\n\r\n');
        return `WEBVTT\r\n\r\nNOTE Title: ${title}\r\nNOTE URL: ${url}\r\n\r\n${body}\r\n`;
      }
      case 'csv': {
        const columns = ['Start Time', 'End Time', 'Transcript Text'];
        const rows = segments.map((seg, idx) => {
          const nextStart = segments[idx + 1]?.start || seg.start + 3;
          return [toDisplayTimestamp(seg.start), toDisplayTimestamp(nextStart), seg.text];
        });
        return formatCsv(columns, rows);
      }
      case 'pdf': {
        return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtmlText(cleanText(title, 80))}</title>
  <style>
    @page { margin: 15mm 12mm; }
    body { font-family: -apple-system, system-ui, sans-serif; font-size: 11px; color: #192734; line-height: 1.5; margin: 0; }
    .header { border-bottom: 2px solid #5c8aa6; padding-bottom: 8px; margin-bottom: 14px; }
    h1 { margin: 0 0 4px; font-size: 16px; }
    .meta { color: #5c8aa6; font-size: 9.5px; }
    .item { margin-bottom: 8px; page-break-inside: avoid; }
    .time { font-weight: 700; color: #2b6684; font-family: monospace; margin-right: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtmlText(cleanText(title, 100))}</h1>
    <div class="meta">${escapeHtmlText(cleanText(url, 150))} &bull; Exported on ${new Date().toLocaleString()}</div>
  </div>
  <div class="content">
    ${segments.map((s) => `<div class="item"><span class="time">${toDisplayTimestamp(s.start)}</span><span>${escapeHtmlText(s.text)}</span></div>`).join('')}
  </div>
</body>
</html>`;
      }
      case 'txt':
      default: {
        return segments.map((seg) => `[${toDisplayTimestamp(seg.start)}] ${seg.text}`).join('\r\n');
      }
    }
  }
}

module.exports = {
  YouTubeTranscriptService,
  parseYouTubeVideoId,
  toSrtTimestamp,
  toVttTimestamp,
  toDisplayTimestamp,
};
