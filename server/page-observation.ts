import type {Page} from 'playwright-core';

/** Bounded rendered landmarks for the coordinator; never expose field values. */
export async function observePage(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const selector = (target: Element) => {
      for (const attribute of ['aria-label', 'data-testid', 'alt', 'title']) {
        const value = target.getAttribute(attribute);
        if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) continue;
        const semantic = `${target.tagName.toLowerCase()}[${attribute}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(semantic).length === 1) return semantic;
      }
      const parts: string[] = [];
      for (let element: Element | null = target; element; element = element.parentElement) {
        if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(element.id)}`); break;
        }
        if (!element.parentElement) {parts.unshift(element.tagName.toLowerCase()); break;}
        const siblings = [...element.parentElement.children].filter(sibling => sibling.tagName === element!.tagName);
        parts.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`);
      }
      const value = parts.join(' > ');
      return value.length <= 600 && document.querySelectorAll(value).length === 1 ? value : undefined;
    };
    const describe = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {selector: selector(element), tag: element.tagName.toLowerCase(),
        label: (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || (element as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height)};
    };
    const collect = (query: string, limit: number) => [...document.querySelectorAll(query)].filter(visible).slice(0, limit).map(describe);
    const media = [...document.querySelectorAll('img,video,canvas,svg,iframe')].filter(element => {
      const box = element.getBoundingClientRect();
      return visible(element) && box.width >= 64 && box.height >= 64;
    }).slice(0, 24).map(element => ({...describe(element),
      ready: element instanceof HTMLImageElement ? element.complete && element.naturalWidth > 0 : element instanceof HTMLVideoElement ? element.readyState >= 2 : undefined}));
    const links = [...document.querySelectorAll('a[href]')].filter(visible).filter(element =>
      /^https?:/i.test((element as HTMLAnchorElement).href)).sort((a, b) =>
      Number(Boolean(a.closest('nav,header,footer'))) - Number(Boolean(b.closest('nav,header,footer')))).slice(0, 24)
      .map(element => ({text: ((element as HTMLElement).innerText || element.getAttribute('aria-label') || '').trim().slice(0, 120), href: (element as HTMLAnchorElement).href}));
    return {viewport: {width: innerWidth, height: innerHeight}, scroll: {x: scrollX, y: scrollY},
      landmarks: collect('h1,h2,h3,[role=heading]', 24), media,
      controls: collect('button,[role=button],input[type=color],input[type=range],select', 20), links,
      text: (document.body?.innerText ?? '').slice(0, 10000),
      contract: 'Selectors and positions are observed on this page. Use an exact selector in captureTarget for visual regions without a text label. Values, passwords and hidden fields are not read.'};
  });
}
