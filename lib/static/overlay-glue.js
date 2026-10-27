/**
 * dsh-whale-overlay — 承载页胶水脚本。
 *
 * 职责（按执行顺序）：
 *  1. 首航播种：若悬浮窗 localStorage 里还没有 dshw-last-seq（挂件用它判定
 *     "新一轮消耗"），先从宿主 seed.json 取当前 seq 写入 —— 避免悬浮窗第一次
 *     启动时把一条陈旧轮次当成新轮次弹泡泡/响提示音。
 *  2. 播种完成后注入 /dsh-whale/widget.js（与 GUI 完全同一份挂件代码）。
 *  3. 命中区域上报 + 像素级探测：只收集"真正可命中"（pointer-events/
 *     visibility/opacity 过滤后）的 dshwv-* 元素矩形上报主进程；主进程
 *     50ms 原生光标轮询做粗判定，激活交互前再发 probe 由本页
 *     elementFromPoint 像素级确认（不使用系统级鼠标钩子，不影响全局输入）。
 */
(function () {
  if (window.__dshOverlayGlue) return
  window.__dshOverlayGlue = true

  var api = window.__dshOverlay || { setInteractive: function () {}, reportRects: function () {}, report: function () {} }

  // ── 1+2. 播种轮次 seq，然后加载挂件 ─────────────────────────────────────

  function loadWidget() {
    try {
      var s = document.createElement('script')
      s.src = '/dsh-whale/widget.js'
      s.onerror = function () {}
      ;(document.body || document.documentElement).appendChild(s)
      // 引导核验：8 秒后挂件主节点仍不存在 → 上报宿主（state.json 可见，便于诊断）
      setTimeout(function () {
        try {
          if (!document.querySelector('.dshwv-root') && !window.__dshWhaleWidget) {
            if (typeof api.report === 'function') api.report('widget-boot-failed: .dshwv-root 未出现（闸门未过或 widget.js 加载失败）')
          }
        } catch (e) {}
      }, 8000)
    } catch (e) {}
  }

  function seedThenLoad() {
    var seeded = false
    try { seeded = localStorage.getItem('dshw-last-seq') !== null } catch (e) {}
    if (seeded) { loadWidget(); return }
    try {
      fetch('/dsh-whale-overlay/seed.json', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (d) {
          if (d && typeof d.seq === 'number' && d.seq > 0) {
            try { localStorage.setItem('dshw-last-seq', String(d.seq)) } catch (e) {}
          }
        })
        .catch(function () {})
        .then(loadWidget, loadWidget)
    } catch (e) {
      loadWidget()
    }
  }
  seedThenLoad()

  // ── 3. 命中区域上报 + 像素级探测（无全局鼠标钩子方案）──────────────────
  //
  // 教训一（v0.1.1）：forward:true 会装 WH_MOUSE_LL 系统级鼠标钩子，
  //   拖慢整个系统输入 → 已移除。
  // 教训二（v0.1.2）：挂件有大量 pointer-events:none 的大尺寸容器
  //   （.dshwv-root 可达 625px 见方、.dshwv-pop、关闭态菜单等），
  //   仅按 getBoundingClientRect 收集会把大片屏幕误判为鲸鱼 → 吞点击。
  //   现在只上报"真正可命中"的元素矩形（computed style 过滤），并且
  //   主进程激活交互前会发来 probe，由本页 elementFromPoint 像素级确认。

  var MASK_SELECTOR = '.dshwv-usage-mask, .dshwv-cropmask, .dshwv-gifmask, .dshwv-confirmmask, .dshwv-snapmask, .dshwv-audiomask'
  var dragging = false
  var lastSentAt = 0

  /** 元素当前是否真正可命中（可点）：pointer-events/visibility/opacity 全过滤。 */
  function hitTestable(el) {
    try {
      var st = window.getComputedStyle(el)
      if (!st) return false
      if (st.display === 'none' || st.visibility !== 'visible') return false
      if (st.pointerEvents === 'none') return false
      var op = parseFloat(st.opacity)
      if (isFinite(op) && op < 0.02) return false
      return true
    } catch (e) {
      return false
    }
  }

  /** 像素级命中判定：elementFromPoint 天然尊重 pointer-events。 */
  function preciseHit(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      return !!(el && el.closest && el.closest('[class*="dshwv-"]'))
    } catch (e) {
      return false
    }
  }

  function collectRects() {
    var out = []
    try {
      // 可见的模态遮罩 → 整个视口可交互
      var masks = document.querySelectorAll(MASK_SELECTOR)
      for (var j = 0; j < masks.length; j++) {
        if (!hitTestable(masks[j])) continue
        var mr = masks[j].getBoundingClientRect()
        if (mr.width > 0 && mr.height > 0) {
          out.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
          return out
        }
      }
      var els = document.querySelectorAll('[class*="dshwv-"]')
      for (var i = 0; i < els.length && out.length < 48; i++) {
        if (!hitTestable(els[i])) continue
        var r
        try { r = els[i].getBoundingClientRect() } catch (e) { continue }
        if (!(r.width > 0 && r.height > 0)) continue
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height })
      }
    } catch (e) {}
    return out
  }

  function report(force) {
    var now = Date.now()
    if (!force && now - lastSentAt < 120) return
    lastSentAt = now
    try {
      if (typeof api.reportRects === 'function') {
        api.reportRects({ dragging: dragging, rects: collectRects() })
      }
    } catch (e) {}
  }

  // 周期上报（挂件出现/移动/菜单开合都会在一个周期内被捕获）
  setInterval(function () { report(true) }, 250)

  // 主进程的像素级探测：确认后才允许窗口进入可交互状态
  try {
    if (typeof api.onProbe === 'function') {
      api.onProbe(function (p) {
        var hit = false
        try { hit = !!(p && preciseHit(p.x, p.y)) } catch (e) {}
        try { api.probeResult({ id: p && p.id, hit: hit }) } catch (e) {}
      })
    }
  } catch (e) {}

  // 窗口可交互期间 mousemove 会真实到达本页：
  //  - 加密上报频率，让拖拽/菜单跟随更顺滑
  //  - 像素级校验：光标其实不在鲸鱼上（bbox 透明角落等）→ 立刻释放穿透
  window.addEventListener('mousemove', function (e) {
    report(false)
    if (dragging) return
    if (!preciseHit(e.clientX, e.clientY)) {
      try { api.setInteractive(false) } catch (err) {}
    }
  }, { passive: true, capture: true })

  window.addEventListener('pointerdown', function (e) {
    if (!preciseHit(e.clientX, e.clientY)) return
    dragging = true
    report(true)
  }, { passive: true, capture: true })

  function endDrag() {
    if (!dragging) return
    dragging = false
    report(true)
  }
  window.addEventListener('pointerup', endDrag, { passive: true, capture: true })
  window.addEventListener('pointercancel', endDrag, { passive: true, capture: true })
  window.addEventListener('blur', endDrag, { capture: true })

  // 挂件 DOM 大变动（菜单/泡泡/模态开合）时立即补报一次
  try {
    var mo = new MutationObserver(function () { report(false) })
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  } catch (e) {}
})()
