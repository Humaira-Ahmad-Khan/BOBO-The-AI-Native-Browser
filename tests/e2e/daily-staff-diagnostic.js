'use strict';
// Used only inside the explicitly approved, dummy-only live diagnostic session.
async function run(action, { wc, filename }) {
  const { frameTree } = await wc.debugger.sendCommand('Page.getFrameTree');
  const { executionContextId } = await wc.debugger.sendCommand('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'BOBO dummy report inspection',
  });
  const evaluate = expression => wc.debugger.sendCommand('Runtime.evaluate', {
    expression, contextId: executionContextId, returnByValue: true, userGesture: action === 'export',
  });
  delete require.cache[require.resolve('../../src/main/tools/daily-staff-summary')];
  const { staffScript, isStaffSummaryUrl } = require('../../src/main/tools/daily-staff-summary');
  if (action === 'inspect') {
    const status = await evaluate(staffScript('report-status', filename));
    console.log('Dummy report status:', JSON.stringify(status.result.value));
    const controls = await evaluate(`JSON.stringify({body:!!document.body,readyState:document.readyState,
      links:[...document.querySelectorAll('a')].filter(x=>/Summary Page Only|Download PDF/.test(x.textContent)).map(x=>({
        label:x.textContent.trim(),hasHref:!!x.getAttribute('href'),scheme:(x.getAttribute('href')||'').split(':')[0],
        download:x.hasAttribute('download'),target:x.target,disabled:x.getAttribute('aria-disabled')})),
      fileCounts:[...document.querySelectorAll('input[type=file]')].map(x=>x.files.length)})`);
    console.log('Dummy PDF controls:', controls.result.value);
  }
  if (action === 'export') {
    const response = await evaluate(staffScript('summary-target', filename));
    const target = response.result.value;
    if (target?.kind === 'url' && isStaffSummaryUrl(target.url)) {
      wc.downloadURL(target.url);
      console.log('Dummy export: requested verified summary attachment route.');
    } else if (target?.kind === 'button') {
      const clicked = await evaluate(staffScript('summary', filename));
      console.log('Dummy export invocation:', JSON.stringify(clicked.result.value));
    } else console.log('Dummy export blocked: no matching approved summary route.');
  }
}
module.exports = { run };
