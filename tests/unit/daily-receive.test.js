'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reportDate } = require('../../src/main/tools/daily-receive');
const { STAFF_REPORT_URL, isStaffPage, isStaffSummaryUrl } = require('../../src/main/tools/daily-staff-summary');

test('receipt reports use Pakistan date across UTC midnight and year rollover', () => {
  assert.deepEqual(reportDate(new Date('2026-11-04T20:00:00Z')), {
    display: '05/11/2026', iso: '2026-11-05', name: '05-11-26 Daily Receive Amount',
  });
  assert.equal(reportDate(new Date('2026-12-31T20:00:00Z')).name, '01-01-27 Daily Receive Amount');
});

test('staff report automation accepts only the exact HTTPS destination and path', () => {
  assert.equal(isStaffPage(STAFF_REPORT_URL), true);
  assert.equal(isStaffPage(STAFF_REPORT_URL + '/'), true);
  for (const value of [STAFF_REPORT_URL.replace('https:', 'http:'), STAFF_REPORT_URL + '-phishing',
    'https://water-supply-reports.vercel.app.evil.test/daily-staff-receive',
    'https://user:secret@water-supply-reports.vercel.app/daily-staff-receive',
    'https://water-supply-reports.vercel.app/login', 'file:///daily-staff-receive']) {
    assert.equal(isStaffPage(value), false);
  }
});

test('only the exact same-site summary PDF endpoint is a permitted download target', () => {
  const route = STAFF_REPORT_URL + '/export/summary-pdf';
  assert.equal(isStaffSummaryUrl(route + '?cols=staffName%2Camount'), true);
  for (const value of [route.replace('https:', 'http:'), route.replace('summary-pdf', 'pdf'),
    route.replace('.vercel.app/', '.vercel.app.evil.test/'),
    route.replace('https://', 'https://user:secret@'), STAFF_REPORT_URL, 'file:///summary.pdf']) {
    assert.equal(isStaffSummaryUrl(value), false);
  }
});
