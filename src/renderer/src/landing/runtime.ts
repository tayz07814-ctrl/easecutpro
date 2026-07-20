// Vanilla runtime for the injected landing markup. The design HTML stays
// verbatim; this replicates the few dc-runtime behaviours it relies on
// (scroll-reveal, hero parallax, FAQ accordion, per-element hover styles) and
// wires the CTAs to in-app navigation. Returns a cleanup that removes every
// listener/observer it added.
export interface LandingHandlers {
  onStartFree: () => void
  onNavigate: (path: string) => void
}

export function initLanding(root: HTMLElement, handlers: LandingHandlers): () => void {
  const cleanups: Array<() => void> = []

  // ---- scroll reveal ([data-reveal]) ----
  const reveals = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))
  reveals.forEach((el) => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(26px)'
    el.style.transition = 'opacity .8s cubic-bezier(.16,1,.3,1), transform .8s cubic-bezier(.16,1,.3,1)'
    el.style.willChange = 'opacity, transform'
  })
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const t = e.target as HTMLElement
        t.style.opacity = '1'
        t.style.transform = 'none'
        io.unobserve(t)
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  )
  reveals.forEach((el) => io.observe(el))
  cleanups.push(() => io.disconnect())

  // ---- hero parallax ([data-parallax]) ----
  const px = root.querySelector<HTMLElement>('[data-parallax]')
  if (px) {
    const onScroll = (): void => {
      const r = px.getBoundingClientRect()
      const off = Math.max(-24, Math.min(24, (window.innerHeight / 2 - (r.top + r.height / 2)) * 0.016))
      px.style.transform = `translateY(${off}px)`
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    cleanups.push(() => window.removeEventListener('scroll', onScroll))
  }

  // ---- FAQ accordion (button[data-faq] toggles its item's [data-ans]) ----
  root.querySelectorAll<HTMLElement>('[data-faq]').forEach((btn) => {
    const onClick = (): void => {
      const item = btn.parentElement
      const ans = item?.querySelector<HTMLElement>('[data-ans]')
      const ic = btn.querySelector<HTMLElement>('[data-ic]')
      if (!ans) return
      const open = !!ans.style.maxHeight && ans.style.maxHeight !== '0px'
      ans.style.maxHeight = open ? '0px' : `${ans.scrollHeight}px`
      if (ic) ic.style.transform = open ? 'rotate(0deg)' : 'rotate(45deg)'
    }
    btn.addEventListener('click', onClick)
    cleanups.push(() => btn.removeEventListener('click', onClick))
  })

  // ---- per-element hover styles (style-hover="…") ----
  root.querySelectorAll<HTMLElement>('[style-hover]').forEach((el) => {
    const base = el.getAttribute('style') ?? ''
    const hover = el.getAttribute('style-hover') ?? ''
    const enter = (): void => {
      el.style.cssText = `${base};${hover}`
    }
    const leave = (): void => {
      el.style.cssText = base
    }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    cleanups.push(() => {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
    })
  })

  // ---- CTA + legal-link wiring (markup left verbatim; matched by label) ----
  const onClickRoot = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null
    const a = target?.closest?.('a')
    if (!a) return
    const label = (a.textContent ?? '').trim()
    if (label === 'Start Free') {
      ev.preventDefault()
      handlers.onStartFree()
    } else if (label === 'Terms') {
      ev.preventDefault()
      handlers.onNavigate('/terms')
    } else if (label === 'Privacy') {
      ev.preventDefault()
      handlers.onNavigate('/privacy')
    }
  }
  root.addEventListener('click', onClickRoot)
  cleanups.push(() => root.removeEventListener('click', onClickRoot))

  return () => cleanups.forEach((fn) => fn())
}
