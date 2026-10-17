// A single tooltip, shared by pointer and keyboard. Measure before placing so
// labels near the right rail or window edge remain entirely inside the window.
import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';

interface Tip {
  readonly anchor: HTMLElement;
  readonly text: string;
}

export function Tooltip() {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState({left: 0, top: 0});

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    const anchorOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
    const eventAnchor = (event: Event) => event.composedPath().map(anchorOf).find(Boolean) ?? null;
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const show = (anchor: HTMLElement | null, delay: number) => {
      if (anchor === current) return;
      hide();
      if (!anchor || !anchor.dataset.tip) return;
      current = anchor;
      timer = window.setTimeout(() => {
        if (anchor.isConnected) setTip({anchor, text: anchor.dataset.tip!});
      }, delay);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') show(eventAnchor(event), 320);
    };
    const out = (event: PointerEvent) => {
      if (current && anchorOf(event.relatedTarget) !== current) hide();
    };
    const focus = (event: FocusEvent) => show(eventAnchor(event), 80);
    const blur = (event: FocusEvent) => {
      if (current && anchorOf(event.relatedTarget) !== current) hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerout', out);
    window.addEventListener('focusin', focus);
    window.addEventListener('focusout', blur);
    window.addEventListener('pointerdown', hide);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointerout', out);
      window.removeEventListener('focusin', focus);
      window.removeEventListener('focusout', blur);
      window.removeEventListener('pointerdown', hide);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const anchor = tip.anchor.getBoundingClientRect();
    const box = ref.current.getBoundingClientRect();
    const side = tip.anchor.dataset.tipSide ?? 'bottom';
    let left = anchor.left + (anchor.width - box.width) / 2;
    let top = side === 'top' ? anchor.top - box.height - 9 : anchor.bottom + 9;
    if (side === 'right') {
      left = anchor.right + 9;
      top = anchor.top + (anchor.height - box.height) / 2;
      if (left + box.width > window.innerWidth - 8) left = anchor.left - box.width - 9;
    } else {
      if (top < 8) top = anchor.bottom + 9;
      if (top + box.height > window.innerHeight - 8) top = anchor.top - box.height - 9;
    }
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - box.width - 8, left)),
      top: Math.max(8, Math.min(window.innerHeight - box.height - 8, top)),
    });
    const describedBy = tip.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    tip.anchor.setAttribute('aria-describedby', [...describedBy, id].join(' '));
    return () => {
      const remaining = tip.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(value => value !== id).join(' ');
      if (remaining) tip.anchor.setAttribute('aria-describedby', remaining);
      else tip.anchor.removeAttribute('aria-describedby');
    };
  }, [tip, id]);

  return tip && <div ref={ref} id={id} className="tip" role="tooltip" style={position}>{tip.text}</div>;
}
