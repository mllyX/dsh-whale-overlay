/**
 * dsh-whale-overlay — host half.
 *
 * 把 dsh-whale-widget 的余额小鲸鱼从 DSH 页面里"解放"出来：
 * 由本插件拉起一个独立的 Electron 助手进程，开一个透明、无边框、置顶、
 * 覆盖整个屏幕的悬浮窗，窗内加载一个裸承载页（隐藏假 #root 过挂件闸门），
 * 再加载与 GUI 完全相同的 /dsh-whale/widget.js —— 拖拽、吸附、泡泡、菜单、
 * 音效、余额轮询全部原样工作，视口即屏幕。
 *
 * 职责：
 *  1. 配置持久化（$DSH_HOME/.dshw-overlay.json）与状态汇报（state.json）
 *  2. 悬浮窗子进程生命周期：spawn（带认证 URL）/ 崩溃退避重启 / 退出清理
 *  3. Electron 助手运行时的探测与（可选）安装（$DSH_HOME/whale-overlay）
 *  4. 桌面模式开启时抑制 GUI 内的挂件副本：
 *     - 桌面壳：过滤 `webserver/index-inject` 结构化注入行（重启后生效）
 *     - 浏览器：tapIndex 剥掉 widget.js 的 <script> 标签
 *     两条都要求本 bundle 排在 dsh-whale-widget 之后（后订阅后执行才能"赢"）。
 *
 * 安全：所有 /dsh-whale-overlay/* 路由套与 dsh-whale-widget 同款的信任围栏
 * （回环 Host 自检 + Sec-Fetch-Site/Origin 校验 + connection.requestRejection
 * 委托 + 写请求仅回环，fail-closed）。
 *
 * @module dsh-whale-overlay
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Loader row name. */
export const name = 'dsh-whale-overlay'

// ── 路径与常量 ────────────────────────────────────────────────────────────

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, '.dshw-overlay.json')
const HELPER_DIR = path.join(DSH_HOME, 'whale-overlay')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OVERLAY_APP_DIR = path.join(HERE, 'overlay')
const STATIC_DIR = path.join(HERE, 'static')
const ROUTE_PREFIX = '/dsh-whale-overlay'
const WIDGET_ROUTE_MARK = '/dsh-whale/widget.js'

/** electron 依赖的版本规格（安装助手运行时写入 helper package.json）。 */
const ELECTRON_SPEC = 'latest'
/** npmmirror 的 Electron 二进制镜像（国内网络）。 */
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'

/** 连续快速失败多少次后放弃自动重启（进入 crash-loop 错误态）。 */
const CRASH_LOOP_LIMIT = 5
/** 子进程存活超过该毫秒数视为"正常运行过"，清零失败计数。 */
const STABLE_UPTIME_MS = 60_000

const DEFAULT_CONFIG = Object.freeze({
  /** 桌面模式总开关：开 = 悬浮窗随 DSH 启动、GUI 内副本被抑制（需重启）。 */
  enabled: false,
  /** 桌面模式开启时抑制 DSH 界面内的挂件副本（避免双鲸鱼/双重提示音）。 */
  suppressInApp: true,
  /** 'primary' = 主显示器；'all' = 所有显示器并集（跨屏漫游）。 */
  display: 'primary',
  /** 悬浮窗整体不透明度 0.3~1。 */
  opacity: 1,
  /** 置顶档位：'screen-saver'（高于几乎一切）| 'normal'（普通置顶）| 'off'。 */
  alwaysOnTop: 'screen-saver',
  /** Ctrl+Alt+W 全局显隐热键。 */
  hotkeyEnabled: true,
  /** false = app.disableHardwareAcceleration()（透明窗口黑底时的兜底）。 */
  hardwareAcceleration: true,
})

const DISPLAY_VALUES = new Set(['primary', 'all'])
const TOP_VALUES = new Set(['screen-saver', 'normal', 'off'])

// ── 小工具 ────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 读配置：缺省值兜底 + 字段校验（坏字段回退默认，不抛错）。 */
function readConfig() {
  const cfg = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (isPlainObject(raw)) {
      if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled
      if (typeof raw.suppressInApp === 'boolean') cfg.suppressInApp = raw.suppressInApp
      if (DISPLAY_VALUES.has(raw.display)) cfg.display = raw.display
      if (raw.opacity !== undefined) cfg.opacity = clampNumber(raw.opacity, 0.3, 1, DEFAULT_CONFIG.opacity)
      if (TOP_VALUES.has(raw.alwaysOnTop)) cfg.alwaysOnTop = raw.alwaysOnTop
      if (typeof raw.hotkeyEnabled === 'boolean') cfg.hotkeyEnabled = raw.hotkeyEnabled
      if (typeof raw.hardwareAcceleration === 'boolean') cfg.hardwareAcceleration = raw.hardwareAcceleration
    }
  } catch {}
  return cfg
}

/** 写配置：临时文件 + rename 原子替换。 */
function writeConfigAtomic(next) {
  const body = JSON.stringify(next, null, 2)
  const tmp = CONFIG_FILE + '.tmp'
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, CONFIG_FILE)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    return false
  }
}

/** 探测已安装的 dsh-whale-widget 包目录（遍历所有 profile 的 node_modules）。 */
function whalePackageDir() {
  const roots = []
  try {
    const profilesRoot = path.join(DSH_HOME, 'profiles')
    for (const p of fs.readdirSync(profilesRoot)) roots.push(path.join(profilesRoot, p, 'node_modules', 'dsh-whale-widget'))
  } catch {}
  for (const d of roots) {
    try {
      if (fs.statSync(path.join(d, 'package.json')).isFile()) return d
    } catch {}
  }
  return null
}

/** helper 目录里的 Electron 可执行文件；未安装返回 null。 */
function electronExe() {
  const pkgDir = path.join(HELPER_DIR, 'node_modules', 'electron')
  try {
    const rel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim()
    const exe = path.join(pkgDir, 'dist', rel)
    if (fs.existsSync(exe)) return exe
  } catch {}
  return null
}

/** helper 目录里 Electron 的版本号；未安装返回 null。 */
function electronVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HELPER_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 读 dsh-whale-widget 的轮次序号（.dshw-turn.json 的 seq），供悬浮窗首航播种。 */
function readTurnSeq() {
  const candidates = [
    path.join(DSH_HOME, '.dshw-turn.json'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
  ]
  try {
    const profilesRoot = path.join(DSH_HOME, 'profiles')
    for (const p of fs.readdirSync(profilesRoot)) candidates.push(path.join(profilesRoot, p, '.dshw-turn.json'))
  } catch {}
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed.seq === 'number' && parsed.seq >= 0) return parsed.seq
    } catch {}
  }
  return 0
}

/** 捆绑运行时的 node/pnpm 路径（宿主进程自带的 Electron-as-node 作兜底）。 */
function runtimeTools() {
  const base = path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  const nodeExe = path.join(base, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpmMjs = path.join(base, 'pnpm', 'bin', 'pnpm.mjs')
  return {
    node: fs.existsSync(nodeExe) ? nodeExe : (process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath),
    pnpm: fs.existsSync(pnpmMjs) ? pnpmMjs : null,
  }
}

function isLoopbackHostname(h) {
  const s = String(h || '').toLowerCase()
  if (s === 'localhost' || s === '[::1]' || s === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (m) return m[1] === '127'
  return false
}

/** 静态文件读取（mtime 缓存热重载，模式与 dsh-whale-widget 相同）。 */
const staticCache = new Map() // file -> { text|buffer, mtimeMs }
function readStatic(file, binary) {
  try {
    const st = fs.statSync(file)
    const hit = staticCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs) return binary ? hit.buffer : hit.text
    if (binary) {
      const buffer = fs.readFileSync(file)
      staticCache.set(file, { buffer, mtimeMs: st.mtimeMs })
      return buffer
    }
    const text = fs.readFileSync(file, 'utf8')
    staticCache.set(file, { text, mtimeMs: st.mtimeMs })
    return text
  } catch {
    return null
  }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

export function apply(root) {
  // 启动时的抑制状态快照：桌面壳的注入表是宿主启动时一次性收集的，
  // 运行期改 suppressInApp/enabled 不会重收集 → 用这个快照告诉前端"需重启"。
  const bootConfig = readConfig()
  const suppressAppliedAtBoot = !!(bootConfig.enabled && bootConfig.suppressInApp)

  // 悬浮窗子进程状态（模块级单例语义：一个宿主进程只养一个悬浮窗）。
  const overlay = {
    child: null,
    pid: 0,
    startedAt: 0,
    ready: false,
    stopping: false,
    failCount: 0,
    lastError: '',
    retryTimer: null,
    killTimer: null,
    logTail: '',
  }
  const installJob = { status: 'idle', logTail: '', startedAt: 0 }

  // ── ① 尽早注册：桌面壳结构化注入行的过滤（不依赖任何服务） ──────────────
  const rowDisposers = []
  root.effect(() => () => {
    for (const d of rowDisposers) {
      try { d() } catch {}
    }
  })
  rowDisposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const cfg = readConfig()
      if (!(cfg.enabled && cfg.suppressInApp)) return
      for (let i = table.length - 1; i >= 0; i--) {
        const row = table[i]
        if (!row) continue
        if (row.kind === 'script-src' && row.src === WIDGET_ROUTE_MARK) {
          table.splice(i, 1)
          continue
        }
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_ROUTE_MARK) >= 0) {
          table.splice(i, 1)
        }
      }
    } catch {}
  }))

  // ── ② 服务就绪后：路由 + tapIndex 抑制 + 自动拉起 ─────────────────────
  // 依赖集与 dsh-whale-widget 完全一致（webServer/credentials/connection），
  // 保证 inject 回调触发顺序 = bundle 顺序 → 本插件排在 whale 之后时，
  // 它的 tap 在 whale 的 tap 之后注册、之后执行（剥除才能赢）。
  root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
    const disposers = []

    const getConnection = () => {
      try {
        return ctx.get('connection') || ctx.connection || null
      } catch {
        return null
      }
    }

    // —— 信任围栏（照 dsh-whale-widget 的 fail-closed 模式收敛版）——
    function selfRejection(req) {
      try {
        const headers = (req && req.headers) || {}
        const rawHost = String(headers.host || '')
        if (!rawHost) return 403
        let hostUrl
        try { hostUrl = new URL('http://' + rawHost) } catch { return 403 }
        if (!isLoopbackHostname(hostUrl.hostname)) return 403
        if (String(headers['sec-fetch-site'] || '') === 'cross-site') return 403
        const origin = headers.origin
        if (origin !== undefined && origin !== null && origin !== '') {
          let o
          try { o = new URL(String(origin)) } catch { return 403 }
          if (!isLoopbackHostname(o.hostname)) return 403
          if (o.host !== hostUrl.host) return 403
        }
        return null
      } catch {
        return 403
      }
    }

    function writeRejection(req) {
      const method = String((req && req.method) || 'GET').toUpperCase()
      if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return null
      try {
        const hostUrl = new URL('http://' + String(((req && req.headers) || {}).host || ''))
        if (isLoopbackHostname(hostUrl.hostname)) return null
        return 403
      } catch {
        return 403
      }
    }

    function rejected(req, res) {
      const deny = (code) => {
        try {
          res.statusCode = typeof code === 'number' ? code : 403
          res.end()
        } catch {}
        return true
      }
      const self = selfRejection(req)
      if (self !== null) return deny(self)
      const write = writeRejection(req)
      if (write !== null) return deny(write)
      const conn = getConnection()
      if (!conn || typeof conn.requestRejection !== 'function') return false // 无栅栏可委托：已过回环自检
      let code
      try {
        code = conn.requestRejection(req)
      } catch {
        return deny(403) // 栅栏自身抛错 → fail-closed
      }
      if (code === undefined || code === null || code === false) return false
      return deny(typeof code === 'number' ? code : 403)
    }

    // —— 悬浮窗生命周期 ——

    function origin() {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return null
      }
    }

    function appendLog(chunk) {
      const s = String(chunk || '')
      if (!s) return
      overlay.logTail = (overlay.logTail + s).slice(-4000)
    }

    function overlayRunning() {
      return !!(overlay.child && !overlay.stopping)
    }

    function scheduleRetry() {
      if (overlay.retryTimer) return
      const cfg = readConfig()
      if (!cfg.enabled) return
      if (overlay.failCount >= CRASH_LOOP_LIMIT) {
        overlay.lastError = 'crash-loop: 悬浮窗连续 ' + overlay.failCount + ' 次快速退出，已暂停自动重启（可在设置里重新开启桌面模式）'
        return
      }
      const delay = overlay.failCount <= 1 ? 2000 : overlay.failCount <= 3 ? 10_000 : 60_000
      overlay.retryTimer = setTimeout(() => {
        overlay.retryTimer = null
        startOverlay('retry')
      }, delay)
    }

    function stopOverlay(reason, sync) {
      if (overlay.retryTimer) {
        clearTimeout(overlay.retryTimer)
        overlay.retryTimer = null
      }
      const child = overlay.child
      overlay.stopping = true
      if (!child) return
      const kill = () => {
        try { child.kill() } catch {}
      }
      if (sync) {
        kill()
        overlay.child = null
        return
      }
      try {
        if (child.connected) child.send({ type: 'quit' })
      } catch {}
      if (overlay.killTimer) clearTimeout(overlay.killTimer)
      overlay.killTimer = setTimeout(() => {
        overlay.killTimer = null
        kill()
      }, 2500)
      void reason
    }

    function startOverlay(reason) {
      try {
        if (overlayRunning()) return { ok: true, already: true }
        const cfg = readConfig()
        if (!cfg.enabled) return { ok: false, error: 'disabled' }
        const exe = electronExe()
        if (!exe) {
          overlay.lastError = 'helper-missing: 未找到 Electron 桌面组件（' + HELPER_DIR + '），请先安装'
          return { ok: false, error: 'helper-missing' }
        }
        if (!whalePackageDir()) {
          overlay.lastError = 'widget-missing: 未找到 dsh-whale-widget 插件包，悬浮窗将没有挂件可加载'
          return { ok: false, error: 'widget-missing' }
        }
        const base = origin()
        if (!base) {
          overlay.lastError = 'origin-unavailable: web 服务尚未绑定端口'
          return { ok: false, error: 'origin-unavailable' }
        }
        let authUrl = null
        try {
          const conn = getConnection()
          if (conn && typeof conn.authenticatedUrl === 'function') authUrl = conn.authenticatedUrl(base + '/')
        } catch {}
        if (!authUrl) {
          overlay.lastError = 'auth-unavailable: connection.authenticatedUrl 不可用，无法为悬浮窗签发认证 URL'
          return { ok: false, error: 'auth-unavailable' }
        }
        let iconPath = ''
        try {
          const p = path.join(whalePackageDir(), 'icon.png')
          if (fs.existsSync(p)) iconPath = p
        } catch {}

        const publicConfig = {
          display: cfg.display,
          opacity: cfg.opacity,
          alwaysOnTop: cfg.alwaysOnTop,
          hotkeyEnabled: cfg.hotkeyEnabled,
          hardwareAcceleration: cfg.hardwareAcceleration,
        }
        const args = [
          OVERLAY_APP_DIR,
          '--overlay-url=' + authUrl,
          '--base=' + base,
          '--icon=' + iconPath,
          '--config-b64=' + Buffer.from(JSON.stringify(publicConfig), 'utf8').toString('base64'),
        ]
        // 宿主进程本身多为 Electron-as-node：ELECTRON_RUN_AS_NODE 一旦泄漏给
        // 助手进程，Electron 会退化成纯 node → 无窗口崩溃循环。必须显式删除。
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        delete env.NODE_OPTIONS
        env.DSH_OVERLAY_USERDATA = path.join(HELPER_DIR, 'userdata')

        fs.mkdirSync(path.join(HELPER_DIR, 'userdata'), { recursive: true })

        const child = spawn(exe, args, {
          cwd: fs.existsSync(HELPER_DIR) ? HELPER_DIR : os.tmpdir(),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env,
          windowsHide: true,
        })
        overlay.child = child
        overlay.pid = child.pid || 0
        overlay.startedAt = Date.now()
        overlay.ready = false
        overlay.stopping = false
        overlay.logTail = ''

        try { child.stdout.on('data', appendLog) } catch {}
        try { child.stderr.on('data', (d) => { appendLog(d); overlay.lastError = overlay.logTail.slice(-800) }) } catch {}
        child.on('message', (m) => {
          try {
            if (m && m.type === 'overlay-ready') overlay.ready = true
            if (m && m.type === 'overlay-error') overlay.lastError = String(m.message || 'overlay-error')
          } catch {}
        })
        child.on('error', (err) => {
          overlay.lastError = 'spawn-error: ' + String((err && err.message) || err)
        })
        child.on('exit', (code, signal) => {
          if (overlay.killTimer) {
            clearTimeout(overlay.killTimer)
            overlay.killTimer = null
          }
          const uptime = Date.now() - (overlay.startedAt || Date.now())
          const wasStopping = overlay.stopping
          overlay.child = null
          overlay.pid = 0
          overlay.ready = false
          overlay.stopping = false
          if (wasStopping) {
            // 主动停止（关桌面模式 / 宿主 dispose）：不清零计数也不重启
            return
          }
          if (uptime >= STABLE_UPTIME_MS) overlay.failCount = 0
          overlay.failCount += 1
          overlay.lastError = 'exit: code=' + code + ' signal=' + String(signal || '') + ' uptime=' + Math.round(uptime / 1000) + 's'
            + (overlay.logTail ? ' | ' + overlay.logTail.slice(-400) : '')
          scheduleRetry()
        })
        void reason
        return { ok: true, pid: overlay.pid }
      } catch (err) {
        overlay.lastError = 'start-error: ' + String((err && err.message) || err)
        return { ok: false, error: overlay.lastError }
      }
    }

    function sendConfigToOverlay(cfg) {
      const child = overlay.child
      if (!child || overlay.stopping) return
      try {
        if (child.connected) {
          child.send({
            type: 'config',
            config: {
              display: cfg.display,
              opacity: cfg.opacity,
              alwaysOnTop: cfg.alwaysOnTop,
              hotkeyEnabled: cfg.hotkeyEnabled,
              hardwareAcceleration: cfg.hardwareAcceleration,
            },
          })
        }
      } catch {}
    }

    // —— 助手运行时安装（POST /install-helper）——
    function startInstall() {
      if (installJob.status === 'running') return { ok: true, already: true }
      try {
        fs.mkdirSync(HELPER_DIR, { recursive: true })
        const pkgPath = path.join(HELPER_DIR, 'package.json')
        let pkg = null
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch {}
        if (!isPlainObject(pkg)) pkg = { name: 'dsh-whale-overlay-helper', private: true, version: '0.1.0' }
        pkg.dependencies = { ...(pkg.dependencies || {}), electron: ELECTRON_SPEC }
        delete pkg.pnpm // pnpm 11+ 不再读 package.json 的 pnpm 字段
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
        // pnpm 10/11 的构建脚本放行清单（新版位置：pnpm-workspace.yaml）
        const wsPath = path.join(HELPER_DIR, 'pnpm-workspace.yaml')
        try {
          if (!fs.existsSync(wsPath)) fs.writeFileSync(wsPath, 'onlyBuiltDependencies:\n  - electron\n', 'utf8')
        } catch {}

        const tools = runtimeTools()
        if (!tools.pnpm) {
          installJob.status = 'error'
          installJob.logTail = '未找到捆绑 pnpm（' + path.join(DSH_HOME, 'dsh-runtimes') + '），无法自动安装'
          return { ok: false, error: installJob.logTail }
        }
        installJob.status = 'running'
        installJob.logTail = ''
        installJob.startedAt = Date.now()
        const env = {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_MIRROR,
          npm_config_registry: process.env.npm_config_registry || NPM_REGISTRY_MIRROR,
        }
        const collect = (d) => {
          installJob.logTail = (installJob.logTail + String(d || '')).slice(-2500)
        }
        // pnpm 11 的供应链策略仍可能拦掉 electron 的 postinstall（二进制下载）——
        // 装完后若 dist 缺失，直接以 node 运行 install.js 兜底（与 postinstall 等效）。
        const finish = (child) => {
          child.on('exit', (code) => {
            if (electronExe()) {
              installJob.status = 'done'
              installJob.logTail += '\n✔ Electron ' + String(electronVersion() || '') + ' 就绪'
              const cfg = readConfig()
              if (cfg.enabled) {
                overlay.failCount = 0
                startOverlay('post-install')
              }
              return
            }
            const installJs = path.join(HELPER_DIR, 'node_modules', 'electron', 'install.js')
            if (code === 0 && fs.existsSync(installJs)) {
              installJob.logTail += '\npostinstall 被 pnpm 拦截，直接运行 electron install.js …'
              const fallback = spawn(tools.node, [installJs], {
                cwd: path.dirname(installJs),
                stdio: ['ignore', 'pipe', 'pipe'],
                env,
                windowsHide: true,
              })
              try { fallback.stdout.on('data', collect) } catch {}
              try { fallback.stderr.on('data', collect) } catch {}
              fallback.on('error', (err) => {
                installJob.status = 'error'
                installJob.logTail += '\nspawn error: ' + String((err && err.message) || err)
              })
              fallback.on('exit', (code2) => {
                if (code2 === 0 && electronExe()) {
                  installJob.status = 'done'
                  installJob.logTail += '\n✔ Electron ' + String(electronVersion() || '') + ' 就绪（install.js 兜底）'
                  const cfg = readConfig()
                  if (cfg.enabled) {
                    overlay.failCount = 0
                    startOverlay('post-install')
                  }
                } else {
                  installJob.status = 'error'
                  installJob.logTail += '\n✘ Electron 二进制下载失败（exit=' + code2 + '）'
                }
              })
              return
            }
            installJob.status = 'error'
            installJob.logTail += '\n✘ 安装失败（exit=' + code + '）'
          })
        }
        const child = spawn(tools.node, [tools.pnpm, 'install', '--no-frozen-lockfile'], {
          cwd: HELPER_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          windowsHide: true,
        })
        try { child.stdout.on('data', collect) } catch {}
        try { child.stderr.on('data', collect) } catch {}
        child.on('error', (err) => {
          installJob.status = 'error'
          installJob.logTail += '\nspawn error: ' + String((err && err.message) || err)
        })
        finish(child)
        return { ok: true }
      } catch (err) {
        installJob.status = 'error'
        installJob.logTail = String((err && err.message) || err)
        return { ok: false, error: installJob.logTail }
      }
    }

    // —— 状态汇报 ——
    function statePayload() {
      const cfg = readConfig()
      const suppressActiveNow = !!(cfg.enabled && cfg.suppressInApp)
      return {
        ok: true,
        config: cfg,
        suppressAppliedAtBoot,
        restartNeededForSuppress: suppressActiveNow !== suppressAppliedAtBoot,
        overlay: {
          running: overlayRunning(),
          ready: overlay.ready,
          pid: overlay.pid,
          startedAt: overlay.startedAt || null,
          uptimeMs: overlay.child ? Date.now() - overlay.startedAt : 0,
          failCount: overlay.failCount,
          lastError: overlay.lastError,
          logTail: overlay.logTail.slice(-1200),
        },
        helper: { installed: !!electronExe(), dir: HELPER_DIR, electronVersion: electronVersion() },
        widget: { detected: !!whalePackageDir() },
        install: { status: installJob.status, startedAt: installJob.startedAt, logTail: installJob.logTail.slice(-1200) },
        base: origin(),
      }
    }

    // —— HTTP 路由（单一 prefix，内部 dispatch）——
    function sendJson(res, code, payload) {
      const body = JSON.stringify(payload)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    function sendStatic(res, file, contentType) {
      const binary = contentType.startsWith('image/')
      const body = readStatic(file, binary)
      if (body === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
      res.end(body)
    }

    function readBody(req, limit) {
      return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > limit) {
            reject(new Error('body-too-large'))
            try { req.destroy() } catch {}
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    function handleConfigPut(req, res) {
      readBody(req, 64 * 1024).then((text) => {
        let patch
        try { patch = JSON.parse(text) } catch { return sendJson(res, 400, { ok: false, error: 'invalid-json' }) }
        if (!isPlainObject(patch)) return sendJson(res, 400, { ok: false, error: 'invalid-payload' })
        const prev = readConfig()
        const next = { ...prev }
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
        if (typeof patch.suppressInApp === 'boolean') next.suppressInApp = patch.suppressInApp
        if (DISPLAY_VALUES.has(patch.display)) next.display = patch.display
        if (patch.opacity !== undefined) next.opacity = clampNumber(patch.opacity, 0.3, 1, prev.opacity)
        if (TOP_VALUES.has(patch.alwaysOnTop)) next.alwaysOnTop = patch.alwaysOnTop
        if (typeof patch.hotkeyEnabled === 'boolean') next.hotkeyEnabled = patch.hotkeyEnabled
        if (typeof patch.hardwareAcceleration === 'boolean') next.hardwareAcceleration = patch.hardwareAcceleration
        if (!writeConfigAtomic(next)) return sendJson(res, 500, { ok: false, error: 'write-failed' })

        // 即时应用
        if (next.enabled && !prev.enabled) {
          overlay.failCount = 0
          overlay.lastError = ''
          const r = startOverlay('config-on')
          sendJson(res, 200, { ok: true, config: next, start: r })
          return
        }
        if (!next.enabled && prev.enabled) {
          stopOverlay('config-off')
          sendJson(res, 200, { ok: true, config: next })
          return
        }
        sendConfigToOverlay(next)
        sendJson(res, 200, { ok: true, config: next })
      }).catch((err) => {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      })
    }

    async function overlayRouter(req, res) {
      let sub = ''
      try {
        sub = new URL(req.url || '/', 'http://x').pathname.slice(ROUTE_PREFIX.length)
      } catch {
        sub = ''
      }
      if (sub === '' || sub === '/') sub = '/state.json'
      const method = String((req && req.method) || 'GET').toUpperCase()

      if (sub === '/state.json' && method === 'GET') return sendJson(res, 200, statePayload())

      if (sub === '/config.json') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, config: readConfig() })
        if (method === 'PUT' || method === 'POST') return handleConfigPut(req, res)
      }

      if (sub === '/seed.json' && method === 'GET') return sendJson(res, 200, { ok: true, seq: readTurnSeq() })

      if (sub === '/install-helper' && (method === 'POST' || method === 'GET')) {
        const r = startInstall()
        return sendJson(res, 200, { ok: !!r.ok, ...r })
      }

      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }

      if (sub === '/overlay.html') return sendStatic(res, path.join(STATIC_DIR, 'overlay.html'), 'text/html; charset=utf-8')
      if (sub === '/overlay-glue.js') return sendStatic(res, path.join(STATIC_DIR, 'overlay-glue.js'), 'application/javascript; charset=utf-8')
      if (sub === '/settings.html') return sendStatic(res, path.join(STATIC_DIR, 'settings.html'), 'text/html; charset=utf-8')
      if (sub === '/icon.png') {
        const own = path.join(HERE, '..', 'assets', 'icon.png')
        if (fs.existsSync(own)) return sendStatic(res, own, 'image/png')
        const whale = whalePackageDir()
        if (whale && fs.existsSync(path.join(whale, 'icon.png'))) return sendStatic(res, path.join(whale, 'icon.png'), 'image/png')
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }

    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return overlayRouter(req, res)
      },
    }))

    // —— 浏览器侧抑制：剥掉 index.html 里的 widget.js script 标签 ——
    disposers.push(ctx.webServer.tapIndex((html) => {
      try {
        const cfg = readConfig()
        if (!(cfg.enabled && cfg.suppressInApp)) return html
        if (typeof html !== 'string' || html.indexOf(WIDGET_ROUTE_MARK) === -1) return html
        return html
          .replace(/<script[^>]*src="[^"]*\/dsh-whale\/widget\.js[^"]*"[^>]*>\s*<\/script>/gi, '')
          .replace(/<script[^>]*src="[^"]*\/dsh-whale\/widget\.js[^"]*"[^>]*\/>/gi, '')
      } catch {
        return html
      }
    }))

    // —— 自动拉起 ——
    if (bootConfig.enabled) startOverlay('boot')

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch {}
      }
      stopOverlay('dispose', true)
    })
  })
}
