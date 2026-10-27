'use strict'
/**
 * dsh-whale-overlay — 悬浮窗主进程（Electron, CJS）。
 *
 * 由 DSH 宿主插件 spawn：
 *   electron.exe <lib/overlay 目录> --overlay-url=<带令牌的根URL> --base=<origin>
 *                --icon=<png路径> --config-b64=<公共配置JSON>
 *
 * 窗口形态：覆盖整个屏幕（主显示器或全部显示器并集）的透明、无边框、置顶窗，
 * 默认整窗点击穿透（setIgnoreMouseEvents(true,{forward:true})），glue 脚本命中
 * 挂件元素时通过 IPC 关闭穿透。首航先加载带令根的根路径换取会话 cookie，
 * 再跳到 /dsh-whale-overlay/overlay.html 承载页。
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, shell, nativeImage,
} = require('electron')

// ── 启动参数 ──────────────────────────────────────────────────────────────

function argOf(name) {
  const prefix = '--' + name + '='
  for (const a of process.argv) {
    if (typeof a === 'string' && a.startsWith(prefix)) return a.slice(prefix.length)
  }
  return ''
}

const overlayUrlArg = argOf('overlay-url')
const baseArg = argOf('base')
const iconArg = argOf('icon')

const DEFAULT_CFG = {
  display: 'primary',
  opacity: 1,
  alwaysOnTop: 'screen-saver',
  hotkeyEnabled: true,
  hardwareAcceleration: true,
}
let cfg = { ...DEFAULT_CFG }
try {
  const b64 = argOf('config-b64')
  if (b64) Object.assign(cfg, JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))
} catch {}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const USERDATA_DIR = process.env.DSH_OVERLAY_USERDATA || path.join(DSH_HOME, 'whale-overlay', 'userdata')

if (!baseArg || !overlayUrlArg) {
  // 参数不全无法工作：立刻退出，让宿主记错误并（按退避）重试。
  try { console.error('[dsh-whale-overlay] missing --base/--overlay-url') } catch {}
  app.exit(2)
}

if (cfg.hardwareAcceleration === false) {
  try { app.disableHardwareAcceleration() } catch {}
}
// 任务结束音等非手势触发的音频需要免手势自动播放。
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') } catch {}
try { app.setPath('userData', USERDATA_DIR) } catch {}

// 单实例：宿主已有守护，这里再兜底一层（同一 userData 只允许一个悬浮窗）。
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// 401 若带 WWW-Authenticate，Electron 默认会挂起导航等待登录凭据 → 拒绝之，
// 让 401 按普通响应提交，统一走 did-navigate / did-fail-load 的失败路径
// （退出码 4，宿主会用新签发的令牌重拉）。
app.on('login', (e) => {
  try { e.preventDefault() } catch {}
})

// ── 与宿主插件的 IPC 生命线 ──────────────────────────────────────────────

function tellHost(message) {
  try {
    if (process.connected) process.send(message)
  } catch {}
}
// 宿主（DSH）退出/断开 → 悬浮窗随之退出，不留孤儿。
if (process.connected) {
  process.on('disconnect', () => {
    try { app.exit(0) } catch { process.exit(0) }
  })
}
process.on('message', (m) => {
  try {
    if (!m || typeof m !== 'object') return
    if (m.type === 'quit') {
      quitting = true
      app.quit()
    } else if (m.type === 'config' && m.config) {
      applyConfig(m.config)
    }
  } catch {}
})

// ── 窗口状态 ─────────────────────────────────────────────────────────────

let win = null
let tray = null
let settingsWin = null
let hiddenByUser = false
let authHopDone = false
let overlayLoaded = false
let quitting = false
let interactive = false
let loadRetries = 0

function displayBounds() {
  try {
    const displays = screen.getAllDisplays()
    if (cfg.display !== 'all' || displays.length <= 1) return screen.getPrimaryDisplay().bounds
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity
    for (const d of displays) {
      x1 = Math.min(x1, d.bounds.x)
      y1 = Math.min(y1, d.bounds.y)
      x2 = Math.max(x2, d.bounds.x + d.bounds.width)
      y2 = Math.max(y2, d.bounds.y + d.bounds.height)
    }
    if (!Number.isFinite(x1) || !Number.isFinite(y1)) return screen.getPrimaryDisplay().bounds
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  } catch {
    return { x: 0, y: 0, width: 1920, height: 1080 }
  }
}

function applyAlwaysOnTop() {
  if (!win) return
  try {
    if (cfg.alwaysOnTop === 'off') win.setAlwaysOnTop(false)
    else win.setAlwaysOnTop(true, cfg.alwaysOnTop === 'normal' ? 'normal' : 'screen-saver')
  } catch {}
}

function applyConfig(next) {
  const prev = { ...cfg }
  Object.assign(cfg, next || {})
  try {
    if (!win) return
    if (next && next.opacity !== undefined) {
      const o = Number(next.opacity)
      if (Number.isFinite(o)) win.setOpacity(Math.min(1, Math.max(0.3, o)))
    }
    if ((next && next.display !== undefined) || (prev.display !== cfg.display)) {
      win.setBounds(displayBounds())
    }
    applyAlwaysOnTop()
    if (next && next.hotkeyEnabled !== undefined) syncHotkey()
    rebuildTrayMenu()
    // hardwareAcceleration 需要重启进程才生效：告知宿主（由用户手动重启桌面模式）。
  } catch {}
}

function setInteractive(on) {
  on = !!on
  if (on === interactive || !win) return
  interactive = on
  try {
    // 注意：绝不使用 { forward: true } —— 它会安装系统级低级鼠标钩子
    // (WH_MOUSE_LL)，全屏透明窗 + 钩子会拖慢整个系统的输入响应。
    // 命中判定改为主进程轮询 screen.getCursorScreenPoint()（见 cursorLoop）。
    if (on) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true)
  } catch {}
}

// ── 命中区域：渲染进程上报"真正可点"的鲸鱼矩形 + 探测确认，主进程轮询光标 ──
//
// 教训（v0.1.1）：挂件有大量 pointer-events:none 的全屏/大尺寸容器
// （.dshwv-root 可达 625px 见方），只看 getBoundingClientRect 会把大片
// 屏幕误判为鲸鱼区域 → 窗口吞掉 DSH 的点击。因此：
//   1) 渲染进程只上报"可命中"（pointer-events/visibility/opacity 过滤）的矩形；
//   2) 激活交互前先向渲染进程发 probe，用 elementFromPoint 像素级确认；
//   3) probe 未命中 → 指数退避冷却，杜绝"激活-释放"抖动吃点击。
let hoverRects = []       // 相对窗口的 CSS px 矩形 [{x,y,w,h}]
let rectsDragging = false // 渲染进程报告的拖拽状态（拖拽期间强制可交互）
let lastRectsAt = 0       // 最近一次收到矩形上报的时间（0 = 尚未收到）
let cursorTimer = null
let probeSeq = 0          // 探测序号
let probePending = 0      // 等待回包的探测 id（0 = 无）
let probeTimer = null
let probeMisses = 0       // 连续未命中次数（驱动冷却退避）
let cooldownUntil = 0     // 冷却截止时间戳

function cursorClientPoint() {
  try {
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    return { x: p.x - b.x, y: p.y - b.y }
  } catch {
    return null
  }
}

function pointInRects(x, y) {
  if (hoverRects.length === 0) return false
  const M = 8 // 抓取余量
  for (const r of hoverRects) {
    if (x >= r.x - M && x <= r.x + r.w + M && y >= r.y - M && y <= r.y + r.h + M) return true
  }
  return false
}

function bumpCooldown() {
  probeMisses += 1
  cooldownUntil = Date.now() + Math.min(150 * Math.pow(2, probeMisses - 1), 2000)
}

function sendProbe(x, y) {
  try {
    probePending = ++probeSeq
    win.webContents.send('overlay-probe', { id: probePending, x, y })
    if (probeTimer) clearTimeout(probeTimer)
    probeTimer = setTimeout(() => {
      probeTimer = null
      if (!probePending) return
      probePending = 0
      bumpCooldown() // 渲染进程无响应按未命中处理
    }, 400)
  } catch {
    probePending = 0
  }
}

function evaluateCursor() {
  try {
    if (quitting || !win || win.isDestroyed()) return
    if (hiddenByUser || !win.isVisible()) { setInteractive(false); return }
    if (rectsDragging) { setInteractive(true); return }
    // 渲染进程失联超 5s（挂死/重载中）→ 安全回退为整窗穿透
    if (lastRectsAt !== 0 && Date.now() - lastRectsAt > 5000) { setInteractive(false); return }
    const p = cursorClientPoint()
    if (!p) return
    const over = pointInRects(p.x, p.y)
    if (interactive) {
      // 已交互：离开粗区域才由轮询释放；区域内的像素级误判由渲染进程
      // mousemove 精确校验后主动释放（overlay-interactive false）
      if (!over) { setInteractive(false); probeMisses = 0 }
      return
    }
    if (!over) { probeMisses = 0; return }
    const now = Date.now()
    if (now < cooldownUntil || probePending !== 0) return
    sendProbe(p.x, p.y) // 探测确认后才激活，避免吞掉误判区域的点击
  } catch {}
}

function startCursorLoop() {
  if (cursorTimer) return
  cursorTimer = setInterval(evaluateCursor, 50)
}

function stopCursorLoop() {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
}

// ── 导航流：认证一跳 → 承载页 ────────────────────────────────────────────

function overlayPageUrl() {
  return baseArg.replace(/\/+$/, '') + '/dsh-whale-overlay/overlay.html'
}

function loadOverlayPage() {
  if (!win) return
  try { win.loadURL(overlayPageUrl()) } catch {}
}

function startNavigation() {
  authHopDone = false
  overlayLoaded = false
  try { win.loadURL(overlayUrlArg) } catch {}
}

function bindNavigation() {
  win.webContents.on('did-navigate', (_e, url, httpResponseCode) => {
    try { console.error('[dwo] did-navigate', httpResponseCode, url) } catch {}
    try {
      if (overlayLoaded) return
      const u = new URL(String(url || ''), baseArg)
      const code = Number(httpResponseCode) || 0
      if (u.pathname === '/dsh-whale-overlay/overlay.html') {
        if (code >= 400) {
          loadRetries += 1
          tellHost({ type: 'overlay-error', message: 'overlay-page-http-' + code })
          if (loadRetries <= 3) setTimeout(() => { if (!quitting) loadOverlayPage() }, 3000)
          else setTimeout(() => { try { app.exit(4) } catch {} }, 1000)
        }
        return
      }
      if (!authHopDone && u.pathname === '/' && String(u.origin) === String(new URL(baseArg).origin)) {
        if (code >= 400) {
          // 令牌失效/被拒：退出，宿主会用新签发的令牌重拉
          tellHost({ type: 'overlay-error', message: 'auth-http-' + code })
          setTimeout(() => { try { app.exit(4) } catch {} }, 500)
          return
        }
        // 303 已跟随、cookie 已铸好 → 立刻跳承载页（GUI 引导被取消，无闪烁）
        authHopDone = true
        loadOverlayPage()
      }
    } catch {}
  })
  win.webContents.on('did-finish-load', () => {
    try {
      const u = new URL(win.webContents.getURL(), baseArg)
      if (u.pathname !== '/dsh-whale-overlay/overlay.html') return
      overlayLoaded = true
      loadRetries = 0
      tellHost({ type: 'overlay-ready', pid: process.pid })
      if (!hiddenByUser) {
        setTimeout(() => {
          try { if (!hiddenByUser && win && !win.isDestroyed()) win.showInactive() } catch {}
        }, 400)
      }
    } catch {}
  })
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    try { console.error('[dwo] did-fail-load', errorCode, errorDescription, validatedURL) } catch {}
    try {
      const url = String(validatedURL || '')
      if (errorCode === -3) {
        // ERR_ABORTED：
        //  - 认证一跳之后 → loadOverlayPage 顶掉进行中的导航，属正常取消；
        //  - 认证一跳完成之前 → 令牌被拒（401+WWW-Authenticate 会走 login→abort），
        //    退出（码 4），宿主会用新签发的令牌重拉。
        if (!authHopDone && !overlayLoaded && !quitting) {
          tellHost({ type: 'overlay-error', message: 'auth-aborted url=' + url })
          setTimeout(() => { try { app.exit(4) } catch {} }, 300)
        }
        return
      }
      if (url.indexOf('/dsh-whale-overlay/overlay.html') !== -1 || url === baseArg + '/') {
        loadRetries += 1
        tellHost({ type: 'overlay-error', message: 'load-failed: ' + errorCode + ' ' + String(errorDescription || '') + ' url=' + url })
        if (loadRetries <= 3) {
          setTimeout(() => { if (!quitting) loadOverlayPage() }, 5000)
        } else {
          // 反复失败（多为宿主重启/令牌失效）：退出，让宿主用新令牌重拉。
          setTimeout(() => { try { app.exit(3) } catch {} }, 2000)
        }
      }
    } catch {}
  })
  // 挂件里的超链接泡泡等外链：不进悬浮窗，交给系统浏览器。
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const s = String(url || '')
      if (s.startsWith(baseArg)) return // 自己的认证跳/承载页
      e.preventDefault()
      if (/^https?:\/\//i.test(s)) shell.openExternal(s)
    } catch {}
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const s = String(url || '')
      if (s.indexOf('/dsh-whale-overlay/settings.html') !== -1) {
        openSettings()
        return { action: 'deny' }
      }
      if (/^https?:\/\//i.test(s)) shell.openExternal(s)
    } catch {}
    return { action: 'deny' }
  })
  win.webContents.on('render-process-gone', () => {
    try { if (!quitting) setTimeout(() => { if (!quitting) startNavigation() }, 1500) } catch {}
  })
}

// ── 窗口创建 ─────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    ...displayBounds(),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      zoomFactor: 1,
    },
  })
  applyAlwaysOnTop()
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
  try {
    const o = Number(cfg.opacity)
    if (Number.isFinite(o) && o > 0 && o < 1) win.setOpacity(o)
  } catch {}
  // 初始整窗穿透；命中判定由主进程光标轮询 + 渲染进程矩形上报完成（无全局钩子）。
  try { win.setIgnoreMouseEvents(true) } catch {}
  bindNavigation()
  startNavigation()
}

// ── 托盘 ─────────────────────────────────────────────────────────────────

function trayImage() {
  try {
    if (iconArg && fs.existsSync(iconArg)) {
      const img = nativeImage.createFromPath(iconArg)
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
    }
  } catch {}
  // 兜底：程序化画一个 16x16 的鲸鱼蓝圆点（BGRA）。
  try {
    const size = 16
    const buf = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const dx = x - 7.5; const dy = y - 7.5
        const inside = (dx * dx + dy * dy) <= 49
        buf[i] = inside ? 0xE8 : 0x00     // B
        buf[i + 1] = inside ? 0x8B : 0x00 // G
        buf[i + 2] = inside ? 0x4D : 0x00 // R
        buf[i + 3] = inside ? 0xFF : 0x00 // A
      }
    }
    return nativeImage.createFromBitmap(buf, { width: size, height: size })
  } catch {
    return nativeImage.createEmpty()
  }
}

function toggleVisible() {
  if (!win) return
  try {
    if (win.isVisible()) {
      hiddenByUser = true
      win.hide()
    } else {
      hiddenByUser = false
      win.showInactive()
    }
  } catch {}
  rebuildTrayMenu()
}

/** 经悬浮窗渲染进程代发（带会话 cookie）的配置写入。 */
function putConfigViaRenderer(patch) {
  try {
    if (!win || win.isDestroyed()) return
    const js = "fetch('/dsh-whale-overlay/config.json',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(" +
      JSON.stringify(JSON.stringify(patch)) + ")}).then(function(r){return r.status}).catch(function(){return 0})"
    win.webContents.executeJavaScript(js, true).catch(() => {})
  } catch {}
}

function openSettings() {
  try {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show()
      settingsWin.focus()
      return
    }
    settingsWin = new BrowserWindow({
      width: 680,
      height: 760,
      title: '桌面鲸鱼 · 设置',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
    })
    settingsWin.loadURL(baseArg.replace(/\/+$/, '') + '/dsh-whale-overlay/settings.html')
    settingsWin.once('ready-to-show', () => { try { settingsWin.show() } catch {} })
    settingsWin.on('closed', () => { settingsWin = null })
  } catch {}
}

let trayAlwaysOnTopChecked = true
function rebuildTrayMenu() {
  if (!tray) return
  try {
    trayAlwaysOnTopChecked = cfg.alwaysOnTop !== 'off'
    const visible = !!(win && win.isVisible() && !hiddenByUser)
    const menu = Menu.buildFromTemplate([
      { label: visible ? '隐藏鲸鱼 (Ctrl+Alt+W)' : '显示鲸鱼 (Ctrl+Alt+W)', click: () => toggleVisible() },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: trayAlwaysOnTopChecked,
        click: (item) => {
          cfg.alwaysOnTop = item.checked ? 'screen-saver' : 'off'
          applyAlwaysOnTop()
          putConfigViaRenderer({ alwaysOnTop: cfg.alwaysOnTop })
        },
      },
      { type: 'separator' },
      { label: '重新加载挂件', click: () => { try { if (win) { hiddenByUser = false; startNavigation() } } catch {} } },
      { label: '设置…', click: () => openSettings() },
      { type: 'separator' },
      {
        label: '退出桌面模式（鲸鱼回到 DSH 界面内）',
        click: () => { putConfigViaRenderer({ enabled: false }) },
      },
      { label: '退出悬浮窗', click: () => { quitting = true; app.quit() } },
    ])
    tray.setContextMenu(menu)
  } catch {}
}

// ── 全局热键 ─────────────────────────────────────────────────────────────

const HOTKEY_ACCEL = 'CommandOrControl+Alt+W'
function syncHotkey() {
  try { globalShortcut.unregister(HOTKEY_ACCEL) } catch {}
  if (cfg.hotkeyEnabled) {
    try { globalShortcut.register(HOTKEY_ACCEL, () => toggleVisible()) } catch {}
  }
}

// ── 启动 ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  try {
    try { console.error('[dwo] ready') } catch {}
    createWindow()
    try { console.error('[dwo] window created') } catch {}

    ipcMain.on('overlay-interactive', (_e, on) => {
      setInteractive(on)
      // 渲染进程的像素级校验说"光标不在鲸鱼上" → 释放并短暂冷却，
      // 防止 50ms 轮询立刻重新激活造成抖动吃点击。
      if (!on) cooldownUntil = Math.max(cooldownUntil, Date.now() + 250)
    })
    ipcMain.on('overlay-probe-result', (_e, payload) => {
      try {
        if (!payload || payload.id !== probePending) return
        probePending = 0
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
        if (payload.hit) {
          probeMisses = 0
          setInteractive(true)
        } else {
          bumpCooldown()
        }
      } catch {}
    })
    ipcMain.on('overlay-report', (_e, msg) => tellHost({ type: 'overlay-error', message: 'page: ' + String(msg || '').slice(0, 400) }))
    ipcMain.on('overlay-rects', (_e, payload) => {
      try {
        if (!payload || typeof payload !== 'object') return
        lastRectsAt = Date.now()
        rectsDragging = !!payload.dragging
        const rects = Array.isArray(payload.rects) ? payload.rects.slice(0, 48) : []
        hoverRects = rects.filter((r) => r && typeof r.x === 'number' && r.w > 0 && r.h > 0)
        evaluateCursor() // 收到新矩形立即评估，降低响应延迟
      } catch {}
    })

    tray = new Tray(trayImage())
    try { tray.setToolTip('桌面鲸鱼 · DSH 余额挂件') } catch {}
    rebuildTrayMenu()
    try { tray.on('click', () => toggleVisible()) } catch {}

    syncHotkey()
    startCursorLoop()
    try { console.error('[dwo] tray+hotkey+cursorloop ok') } catch {}

    // 引导看门狗：25s 内没能到达承载页（令牌失效/宿主异常/导航静默失败）
    // → 以码 5 退出，交给宿主退避重拉，绝不滞留为僵尸悬浮窗。
    setTimeout(() => {
      if (!overlayLoaded && !quitting) {
        tellHost({ type: 'overlay-error', message: 'boot-timeout' })
        try { app.exit(5) } catch {}
      }
    }, 25000)

    const reposition = () => {
      try { if (win && !win.isDestroyed()) win.setBounds(displayBounds()) } catch {}
    }
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
      try { screen.on(ev, reposition) } catch {}
    }

    tellHost({ type: 'overlay-ready', pid: process.pid })
  } catch (err) {
    try { console.error('[dwo] whenReady failed:', (err && err.stack) || err) } catch {}
    tellHost({ type: 'overlay-error', message: String((err && err.stack) || err) })
  }
})

// 悬浮窗常驻：没有可见窗口也不退出（托盘控制生命周期）。
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  stopCursorLoop()
  try { globalShortcut.unregisterAll() } catch {}
})

process.on('uncaughtException', (err) => {
  try { console.error('[dwo] uncaught:', (err && err.stack) || err) } catch {}
  tellHost({ type: 'overlay-error', message: 'uncaught: ' + String((err && err.message) || err) })
})
