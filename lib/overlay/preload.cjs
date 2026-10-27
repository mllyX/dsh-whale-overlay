'use strict'
/**
 * dsh-whale-overlay — 悬浮窗 preload（CJS，兼容 sandbox:true）。
 *
 * 只暴露一个受控桥：glue 脚本用它上报"鼠标当前是否命中挂件"，
 * 主进程据此切换整窗的点击穿透（setIgnoreMouseEvents）。
 */
const { contextBridge, ipcRenderer } = require('electron')

try {
  contextBridge.exposeInMainWorld('__dshOverlay', {
    /** 命中挂件 → true（窗口可交互）；空白处 → false（点击穿透到桌面）。 */
    setInteractive(on) {
      try { ipcRenderer.send('overlay-interactive', !!on) } catch {}
    },
    /** 承载页向宿主上报诊断信息（如挂件引导失败）。 */
    report(msg) {
      try { ipcRenderer.send('overlay-report', String(msg || '').slice(0, 400)) } catch {}
    },
    /**
     * 周期上报鲸鱼元素的屏幕矩形（相对窗口，CSS px）与拖拽状态。
     * 主进程用 50ms 光标轮询做粗判定 —— 无系统级鼠标钩子，不影响全局输入。
     * payload: { dragging: boolean, rects: [{x,y,w,h}] }
     */
    reportRects(payload) {
      try { ipcRenderer.send('overlay-rects', payload) } catch {}
    },
    /**
     * 注册命中探测回调：主进程在"光标进入粗区域"时发来 {id,x,y}，
     * 页面用 elementFromPoint 做像素级确认后经 probeResult 回包。
     */
    onProbe(handler) {
      try {
        ipcRenderer.on('overlay-probe', (_e, payload) => {
          try { handler(payload) } catch {}
        })
      } catch {}
    },
    /** 探测回包：{id, hit}。 */
    probeResult(payload) {
      try { ipcRenderer.send('overlay-probe-result', payload) } catch {}
    },
    /** 悬浮窗自己的标识，便于挂件/glue 区分运行环境。 */
    overlay: true,
    version: '0.1.2',
  })
} catch {}
