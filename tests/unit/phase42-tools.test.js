'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../../src/main/db');
const { formatCsv, escapeCsvCell, parseCsvLine, mergeCsvFiles, buildPdfHtml } = require('../../src/main/tools/export');
const { BillsExtractionService, BILLS_COLUMNS } = require('../../src/main/tools/bills');
const {
  YouTubeTranscriptService,
  parseYouTubeVideoId,
  toSrtTimestamp,
  toVttTimestamp,
  toDisplayTimestamp,
} = require('../../src/main/tools/transcript');

test('CSV Export: RFC 4180 escaping and formula injection protection', () => {
  // Formula injection defense: cells starting with =, +, -, @, \t, \r are prepended with '
  assert.equal(escapeCsvCell('=SUM(A1:A10)'), `"\'=SUM(A1:A10)"`);
  assert.equal(escapeCsvCell('+12345'), `"\'\+12345"`);
  assert.equal(escapeCsvCell('-calc()'), `"\'\-calc()"`);
  assert.equal(escapeCsvCell('@cmd'), `"\'\@cmd"`);

  // Literal identifiers preserve their digits without introducing spreadsheet formulas.
  assert.equal(escapeCsvCell('03001234567'), '"03001234567"');
  assert.equal(escapeCsvCell('081010001'), '"081010001"');
  assert.deepEqual(parseCsvLine('="09010199",Test'), ['09010199', 'Test']);

  // Quotes and commas
  assert.equal(escapeCsvCell('Hello, World'), '"Hello, World"');
  assert.equal(escapeCsvCell('Quote "Test"'), '"Quote ""Test"""');

  // formatCsv produces valid UTF-8 BOM string
  const cols = ['Consumer Name', 'Mobile', 'Amount'];
  const rows = [
    ['Muhammad Ali', '03001234567', '1500'],
    ['Ahmed Khan', '03217654321', '=2000+500'],
  ];
  const csv = formatCsv(cols, rows);
  assert.equal(csv.charCodeAt(0), 0xfeff); // Has BOM
  assert.ok(csv.includes('Muhammad Ali'));
  assert.ok(csv.includes('"03001234567"'));
  assert.ok(csv.includes(`\'=2000+500`));
});

test('CSV Merge: combines files and deduplicates by key column', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobo-csv-test-'));
  const file1 = path.join(tmpDir, 'page1.csv');
  const file2 = path.join(tmpDir, 'page2.csv');

  const headers = ['Connection No', 'Consumer Name', 'Bill'];
  const p1 = formatCsv(headers, [
    ['81010001', 'Ali', '500'],
    ['81010002', 'Basit', '600'],
  ]);
  const p2 = formatCsv(headers, [
    ['81010002', 'Basit', '600'], // Duplicate
    ['81010003', 'Chaudhry', '700'],
  ]);

  await fs.writeFile(file1, p1, 'utf8');
  await fs.writeFile(file2, p2, 'utf8');

  const merged = await mergeCsvFiles([file1, file2], { dedupeKey: 'Connection No' });
  assert.equal(merged.ok, true);
  assert.equal(merged.fileCount, 2);
  assert.equal(merged.rowCount, 3); // Deduplicated to 3 rows
  assert.ok(merged.csv.includes('81010001'));
  assert.ok(merged.csv.includes('81010002'));
  assert.ok(merged.csv.includes('81010003'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Bills History Service: Queue persistence, transactional update & CSV export', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobo-bills-test-'));
  const dbFile = path.join(tmpDir, 'bobo-test.db');
  const store = new Store({ file: dbFile });

  const bills = new BillsExtractionService({ store });

  // 1. Create job with connection numbers (including duplicates and whitespace)
  const job = bills.createJob({
    name: 'eLGCDD Lahore West',
    connectionNumbers: ['081010001', '  081010002  ', '081010001', ''],
  });

  assert.equal(job.total, 2); // 2 unique numbers
  assert.equal(job.pending, 2);

  // 2. Fetch queue items
  const queue = bills.getQueue(job.id);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].connectionNo, '081010001');
  assert.equal(queue[1].connectionNo, '081010002');

  // 3. Simulate simulated completion for item 1
  const db = store.open();
  db.prepare(
    `UPDATE bills_queue
     SET status = 'completed',
         consumer_info = ?,
         bills_data = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    JSON.stringify({ consumerName: 'Tariq Mehmood', fhName: 'Abdul Rehman', sector: 'Sector B', locality: 'Lahore' }),
    JSON.stringify([
      ['1', 'B-1001', 'Water', 'Jan 2026', '0', '350', '150', '50', '20', '570', '0', '650', '15-Jan-2026', 'Paid', '570', '12-Jan-2026'],
    ]),
    Date.now(),
    queue[0].id
  );

  // Check updated job status
  const updatedJob = bills.getJob(job.id);
  assert.equal(updatedJob.completed, 1);
  assert.equal(updatedJob.pending, 1);

  // 4. Export combined CSV
  const combinedCsv = bills.exportCombinedCsv(job.id);
  assert.ok(combinedCsv.includes('081010001'));
  assert.ok(combinedCsv.includes('Tariq Mehmood'));
  assert.ok(combinedCsv.includes('B-1001'));

  // 5. Export individual CSV
  const indCsv = bills.exportIndividualCsv(job.id, '081010001');
  assert.ok(indCsv.includes('081010001'));
  assert.ok(indCsv.includes('Sector B'));

  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('YouTube Transcript Extractor: URL parsing and subtitle format conversions', () => {
  // Video ID parsing
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'dQw4w9WgXcQ'
  );
  assert.equal(
    parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ'
  );
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/shorts/3xyz123'),
    '3xyz123'
  );
  assert.equal(parseYouTubeVideoId('https://example.com/'), null);

  // Timestamps
  assert.equal(toSrtTimestamp(75.5), '00:01:15,500');
  assert.equal(toVttTimestamp(75.5), '00:01:15.500');
  assert.equal(toDisplayTimestamp(75), '01:15');
  assert.equal(toDisplayTimestamp(3665), '1:01:05');

  // Formatter
  const service = new YouTubeTranscriptService();
  const segments = [
    { start: 0, text: 'Welcome to this demonstration.' },
    { start: 3.5, text: 'Today we explore browser technologies.' },
  ];

  const txt = service.formatTranscript(segments, 'txt');
  assert.ok(txt.includes('[00:00] Welcome to this demonstration.'));

  const srt = service.formatTranscript(segments, 'srt');
  assert.ok(srt.includes('00:00:00,000 --> 00:00:03,500'));
  assert.ok(srt.includes('Welcome to this demonstration.'));

  const vtt = service.formatTranscript(segments, 'vtt', { title: 'Test Video' });
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:00.000 --> 00:00:03.500'));

  const csv = service.formatTranscript(segments, 'csv');
  assert.ok(csv.includes('"Start Time","End Time","Transcript Text"'));
  assert.ok(csv.includes('00:00'));
});

test('YouTube transcript reads loaded caption cues and handles an empty track', async () => {
  const { runInNewContext } = require('node:vm');
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const track = { kind: 'captions', mode: 'showing', language: 'en', cues: [] };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScript: (script) => runInNewContext(script, {
      window: { location: { href: url } },
      document: {
        title: 'Test video - YouTube',
        querySelector: (selector) => selector === 'video' ? { textTracks: [track] } : null,
        querySelectorAll: () => [],
      },
    }),
  };
  const service = new YouTubeTranscriptService();
  assert.equal((await service.detectAndExtract(webContents)).segments.length, 0);
  track.cues.push({ startTime: 65, text: ' Caption text ' });
  const { segments } = await service.detectAndExtract(webContents);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startText, '01:05');
  assert.equal(service.formatTranscript(segments, 'txt'), '[01:05] Caption text');
});

test('YouTube transcript opens the description and waits for transcript rows', async () => {
  const { runInNewContext } = require('node:vm');
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  let expanded = false;
  let opened = false;
  const expand = { getClientRects: () => [{}], click: () => { expanded = true; } };
  const button = {
    closest: () => null, getAttribute: () => 'Show transcript',
    click: () => { opened = true; },
  };
  const row = { querySelector: (selector) => ({
    textContent: selector.startsWith('.segment-timestamp') ? '1:05' : 'Fixture caption',
  }) };
  const contents = {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScript: (script) => runInNewContext(script, {
      window: { location: { href: url } },
      setTimeout: (callback) => queueMicrotask(callback),
      document: {
        title: 'Fixture',
        querySelector: (selector) => selector.includes('#expand') ? expand : null,
        querySelectorAll: (selector) => selector === 'button'
          ? expanded ? [button] : []
          : opened ? [row] : [],
      },
    }),
  };
  const { segments } = await new YouTubeTranscriptService().detectAndExtract(contents);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 65);
  assert.equal(segments[0].text, 'Fixture caption');
});

test('Transcript PDF markup escapes page-supplied captions and metadata', () => {
  const text = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const html = new YouTubeTranscriptService().formatTranscript([{ start: 0, text }], 'pdf', {
    title: '</title><script>alert(1)</script>',
    url: 'https://example.test/?a=1&b=2',
  });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;quoted&#39;/);
  assert.match(html, /a=1&amp;b=2/);
});
