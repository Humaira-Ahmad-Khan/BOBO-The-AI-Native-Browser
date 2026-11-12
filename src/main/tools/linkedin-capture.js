'use strict';

const activeCaptures = new WeakSet();
const WORLD = 1102;

function linkedin(url) {
  try {
    return ['https://www.linkedin.com', 'https://linkedin.com'].includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function selectPost() {
  return new Promise((resolve) => {
    const selectors = '.feed-shared-update-v2, article[data-urn*="activity"], .occludable-update[data-urn*="activity"], main article';
    const original = { x: scrollX, y: scrollY };
    const controller = new AbortController();
    let hovered;
    let outline;
    function highlight(post) {
      if (post === hovered) return;
      if (hovered) hovered.style.outline = outline;
      hovered = post;
      if (post) {
        outline = post.style.outline;
        post.style.outline = '3px solid #36a9e1';
      }
    }
    function finish(post) {
      clearTimeout(timer);
      controller.abort();
      highlight(null);
      if (post) globalThis.boboSelectedPost = { post, original };
      resolve(Boolean(post));
    }
    function find(target) {
      if (!(target instanceof Element)) return null;
      const post = target.closest(selectors);
      if (post) return post;
      const item = target.closest('[role="listitem"]');
      return item && [...item.querySelectorAll('h2')].some((h) =>
        h.textContent.trim().toLowerCase() === 'feed post') ? item : null;
    }
    const options = { capture: true, signal: controller.signal };
    const timer = setTimeout(() => finish(null), 30000);
    document.addEventListener('pointermove', (event) => highlight(find(event.target)), options);
    document.addEventListener('click', (event) => {
      const post = find(event.target);
      if (!event.isTrusted || !post) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(post);
    }, options);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
    }, options);
  });
}

async function preparePost() {
  const post = globalThis.boboSelectedPost?.post;
  if (!post?.isConnected) throw new Error('The selected post is no longer available.');
  const scrollParents = [];
  for (let parent = post.parentElement; parent && parent !== document.scrollingElement; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
      scrollParents.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
    }
  }
  globalThis.boboSelectedPost.scrollParents = scrollParents;
  for (const button of [...post.querySelectorAll('button, [role="button"]')].slice(0, 80)) {
    if (!/^(?:see more|(?:…|\.\.\.)\s*more)$/i.test((button.innerText || button.getAttribute('aria-label') || '').trim())) continue;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const blocks = [...post.querySelectorAll('[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description')];
  const text = [...new Set(blocks.map((node) => node.innerText.trim()).filter(Boolean))].join('\n\n');
  const rect = post.getBoundingClientRect();
  return { text: (text || post.innerText.trim()).slice(0, 100000), width: Math.floor(rect.width), height: Math.floor(rect.height) };
}

async function captureLinkedIn(contents, mode) {
  if (!['image', 'text'].includes(mode)) throw new Error('Choose image or text capture.');
  if (!contents || contents.isDestroyed() || !linkedin(contents.getURL())) throw new Error('Open a LinkedIn tab first.');
  if (activeCaptures.has(contents)) throw new Error('A LinkedIn capture is already in progress.');
  activeCaptures.add(contents);
  const frame = contents.mainFrame;
  const run = (code) => {
    if (contents.isDestroyed() || contents.mainFrame !== frame || !linkedin(contents.getURL())) {
      throw new Error('The LinkedIn page changed during capture.');
    }
    return contents.executeJavaScriptInIsolatedWorld(WORLD, [{
      code: `if (!(${linkedin.toString()})(location.href)) throw new Error('LinkedIn page required'); ${code}`,
    }]);
  };
  try {
    if (!await run(`(${selectPost.toString()})()`)) return { canceled: true };
    const { text, width, height } = await run(`(${preparePost.toString()})()`);
    if (mode === 'text') return { text };
    if (width < 1 || height < 1 || height > 12000 || width * height > 10000000) {
      throw new Error('This post is too large for image capture. Try copying its text.');
    }
    const slices = [];
    for (let y = 0; y < height;) {
      const rect = await run(`(async () => {
        const { post, scrollParents } = globalThis.boboSelectedPost;
        if (!post.isConnected) throw new Error('The selected post is no longer available.');
        for (const { node } of scrollParents) {
          const top = Math.max(0, node.getBoundingClientRect().top) + 12;
          node.scrollBy({ top: post.getBoundingClientRect().top + ${y} - top, behavior: 'instant' });
        }
        if (!scrollParents.length) {
          scrollBy({ top: post.getBoundingClientRect().top + ${y} - 90, behavior: 'instant' });
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
        const rect = post.getBoundingClientRect();
        const bottom = Math.min(innerHeight, ...scrollParents.map(({ node }) => node.getBoundingClientRect().bottom));
        return { x: rect.left, y: rect.top + ${y}, w: innerWidth, h: innerHeight, bottom };
      })()`);
      const top = Math.round(rect.y);
      const left = Math.max(0, Math.floor(rect.x));
      const count = Math.min(height - y, Math.floor(rect.bottom) - top);
      if (top < -1 || rect.x < -1 || left + width > rect.w || count < 1 || slices.length >= 30) {
        throw new Error('The post does not fit the available viewport. Enlarge the window and try again.');
      }
      const image = await contents.capturePage();
      await run('true');
      const size = image.getSize();
      if (image.isEmpty()) throw new Error('LinkedIn returned an empty image.');
      const sx = size.width / rect.w;
      const sy = size.height / rect.h;
      const crop = image.crop({ x: Math.round(left * sx), y: Math.max(0, Math.round(top * sy)),
        width: Math.floor(width * sx), height: Math.floor(count * sy) });
      slices.push({ y, height: count, dataUrl: crop.toDataURL() });
      y += count;
    }
    return { width, height, slices };
  } finally {
    try {
      await run(`(() => {
        const selected = globalThis.boboSelectedPost;
        for (const { node, top, left } of selected?.scrollParents || []) node.scrollTo({ top, left, behavior: 'instant' });
        if (selected) scrollTo({ left: selected.original.x, top: selected.original.y, behavior: 'instant' });
        delete globalThis.boboSelectedPost;
      })()`);
    } catch {}
    activeCaptures.delete(contents);
  }
}

module.exports = { captureLinkedIn };
