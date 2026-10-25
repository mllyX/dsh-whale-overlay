/**
 * dsh-whale-overlay — 承载页胶水脚本。
 *
 * 职责（按执行顺序）：
 *  1. 首航播种：若悬浮窗 localStorage 里还没有 dshw-last-seq（挂件用它判定
 *     "新一轮消耗"），先从宿主 seed.json 取当前 seq 写入 —— 避免悬浮窗第一次
 *     启动时把一条陈旧轮次当成新轮次弹泡泡/响提示音。
 *  2. 播种完成后注入 /dsh-whale/widget.js（与 GUI 完全同一份挂件代码）。
 *  3. 命中测试桥：mousemove（点击穿透 forward 模式仍会投递）→ elementFromPoint
 *     → 是否落在 dshwv-* 挂件元素上 → __dshOverlay.setInteractive(bool)
 *     → 主进程切换整窗穿透。拖拽期间（pointerdown 在挂件上）强制保持交互。
 */
(function () {
  if (window.__dshOverlayGlue) return
  window.__dshOverlayGlue = true

  var api = window.__dshOverlay || { setInteractive: function () {} }

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

  // ── 3. 命中测试 → 点击穿透切换 ─────────────────────────────────────────

  var interactive = null
  function setInteractive(on) {
    on = !!on
    if (on === interactive) return
    interactive = on
    try { api.setInteractive(on) } catch (e) {}
  }

  function isWhaleElement(el) {
    try {
      if (!el || el.nodeType !== 1) return false
      if (el.closest && el.closest('[class*="dshwv-"]')) return true
      // 兜底：向上走祖先链查 dshwv- 前缀类名（极老 WebView 无 closest 时）
      while (el && el.nodeType === 1) {
        var cls = el.classList
        if (cls) {
          for (var i = 0; i < cls.length; i++) {
            if (String(cls[i]).indexOf('dshwv-') === 0) return true
          }
        }
        el = el.parentElement
      }
    } catch (e) {}
    return false
  }

  function hitTest(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      return isWhaleElement(el)
    } catch (e) {
      return false
    }
  }

  var dragging = false
  var lastMoveAt = 0
  var lastX = -1
  var lastY = -1

  window.addEventListener('mousemove', function (e) {
    lastX = e.clientX
    lastY = e.clientY
    var now = Date.now()
    if (now - lastMoveAt < 40) return
    lastMoveAt = now
    setInteractive(dragging || hitTest(e.clientX, e.clientY))
  }, { passive: true, capture: true })

  window.addEventListener('pointerdown', function (e) {
    if (hitTest(e.clientX, e.clientY)) {
      dragging = true
      setInteractive(true)
    }
  }, { passive: true, capture: true })

  function endDrag() { dragging = false }
  window.addEventListener('pointerup', endDrag, { passive: true, capture: true })
  window.addEventListener('pointercancel', endDrag, { passive: true, capture: true })
  window.addEventListener('blur', function () { dragging = false }, { capture: true })

  // 光标滑出窗口边界（多屏边缘）：立刻恢复穿透，避免屏幕边缘留下"隐形可点区"。
  window.addEventListener('mouseout', function (e) {
    try {
      if (!e.relatedTarget && !e.toElement) { dragging = false; setInteractive(false) }
    } catch (err) {}
  }, { capture: true })

  // 兜底巡检：挂件模态遮罩打开时（覆盖全屏的 dshwv- 遮罩）保持可交互；
  // 遮罩关闭且鼠标停在原地不动时，也能按最后已知位置恢复穿透。
  var MASK_SELECTOR = '.dshwv-usage-mask, .dshwv-cropmask, .dshwv-gifmask, .dshwv-confirmmask, .dshwv-snapmask, .dshwv-audiomask'
  setInterval(function () {
    try {
      if (dragging) { setInteractive(true); return }
      if (document.querySelector(MASK_SELECTOR)) { setInteractive(true); return }
      if (lastX >= 0 && lastY >= 0) setInteractive(hitTest(lastX, lastY))
    } catch (e) {}
  }, 700)
})()
