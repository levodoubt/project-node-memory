/**
 * project-node-memory —— 浏览器侧入口（非 ESM；由 DSH 模块加载器执行）。
 *
 * 结构：
 *   1. 调 window.__ModuleLoader__.load({ id, factory })
 *      id 必须是 package.json 的 name（写成 cordis 行 id 会报 loaded without registering）
 *   2. factory(require) 拿到 React，建出 { apply, inject }
 *   3. apply(ctx) 注册两个槽位：
 *      - sidebar.panellist  id=nodekb     左栏齿轮里的图标
 *      - main               key=nodekb    图标点开后的中栏面板
 *
 * 面板数据全部来自宿主侧路由 /nodekb/api/*（读写都是 md，面板只读）。
 * 刻意不用 JSX / TS：工厂体没有编译步骤，写 JSX 会在页面加载时直接语法错误。
 */
;(function () {
  var g = typeof window !== 'undefined' ? window : globalThis
  var PKG_ID = 'project-node-memory'
  var SIDEBAR_LABEL = '项目节点知识库'
  var loader = g && g.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') {
    throw new Error(PKG_ID + ' client: 缺少 window.__ModuleLoader__（本文件只能由 DSH 模块加载器执行）')
  }
  loader.load({ id: PKG_ID, factory: makePlugin })

  function makePlugin(require) {
    var React = null
    try {
      React = require('react')
    } catch (e) {
      /* 加载器没给 react 时退回全局 */
    }
    if (!React) React = g.React
    if (!React) throw new Error('project-node-memory client: 取不到 react')

    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useCallback = React.useCallback
    var useRef = React.useRef

    var API = '/nodekb/api'
    var WS_KEY = 'project-node-memory.ws'
    var WS_KEY_OLD = 'dsh-nodekb.ws'

    // 客户端自证：把"加载到哪一步"报给宿主（GET /nodekb/api/client-report 可读），
    // 这样排查"图标不见了"不用人肉开 DevTools。
    function report(obj) {
      try {
        // 每条报告都带上「这个客户端构建是谁」，用来确认热载后跑的是哪一版
        var payload = { id: PKG_ID, label: SIDEBAR_LABEL }
        for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) payload[k] = obj[k]
        fetch(API + '/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () { /* 报告失败无所谓 */ })
      } catch (e) {
        /* 报告失败无所谓 */
      }
    }

    report({ phase: 'factory', hasReact: !!React })

    // 面板拿不到会话上下文，所以工作区由人指定一次、记在 localStorage
    function readWs() {
      try {
        if (!g.localStorage) return ''
        // 迁移：改名前的旧键还能读到
        return g.localStorage.getItem(WS_KEY) || g.localStorage.getItem(WS_KEY_OLD) || ''
      } catch (e) {
        return ''
      }
    }
    var WS = readWs()

    function writeWs(v) {
      WS = v || ''
      try {
        if (g.localStorage) {
          if (WS) g.localStorage.setItem(WS_KEY, WS)
          else g.localStorage.removeItem(WS_KEY)
        }
      } catch (e) {
        /* 隐私模式：只在本页生效 */
      }
    }

    // ── 数据层 ────────────────────────────────────────────────────────────
    function qs(params) {
      var parts = []
      for (var k in params) {
        var v = params[k]
        if (v === undefined || v === null || v === '') continue
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
      }
      return parts.length ? '?' + parts.join('&') : ''
    }

    function get(path, params) {
      var p = {}
      for (var k in params || {}) p[k] = params[k]
      if (WS && p.ws === undefined) p.ws = WS
      return fetch(API + path + qs(p), { headers: { accept: 'application/json' } }).then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || 'HTTP ' + r.status)
          return body
        })
      })
    }

    // 写端点只收同源 POST（宿主用 Sec-Fetch-Site/Origin 校验），所以改名走这里而不是 get()
    function post(path, params, body) {
      var p = {}
      for (var k in params || {}) p[k] = params[k]
      if (WS && p.ws === undefined) p.ws = WS
      return fetch(API + path + qs(p), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().then(function (res) {
          if (!r.ok) throw new Error((res && res.error) || 'HTTP ' + r.status)
          return res
        })
      })
    }

    // ── 样式：内容变了就替换（客户端热更新时常拿到旧 <style>，早退会让新类名全体失效）──
    function ensureStyle() {
      if (typeof document === 'undefined') return
      var css = [
        '.nkb-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:inherit}',
        '.nkb-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.25);flex:0 0 auto}',
        '.nkb-title{font-weight:600;letter-spacing:.02em}',
        '.nkb-head select,.nkb-head input,.nkb-head button{font:inherit;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:3px 7px}',
        '.nkb-head input{min-width:180px}',
        // 检索框 + 右侧「×」：只有它退出检索（Esc 等价），点命中条目不退出
        '.nkb-qbox{display:inline-flex;align-items:center;position:relative}',
        '.nkb-qbox input{padding-right:20px}',
        '.nkb-qclear{position:absolute;right:1px;border:0!important;background:transparent!important;border-radius:999px!important;padding:0 6px!important;line-height:1!important;font-size:13px!important;opacity:.55;cursor:pointer}',
        '.nkb-qclear:hover{opacity:1;background:rgba(128,128,128,.22)!important}',
        'mark.nkb-hl{background:rgba(255,196,0,.34);color:inherit;border-radius:3px;padding:0 1px}',
        '.nkb-head button{cursor:pointer}',
        '.nkb-head button:hover{background:rgba(128,128,128,.14)}',
        '.nkb-body{display:flex;flex:1 1 auto;min-height:0}',
        '.nkb-left{width:272px;flex:0 0 272px;border-right:1px solid rgba(128,128,128,.25);display:flex;flex-direction:column;min-height:0}',
        '.nkb-tree{flex:1 1 auto;overflow:auto;padding:6px 4px;min-height:0}',
        '.nkb-settings{flex:0 0 auto;border-top:1px solid rgba(128,128,128,.22);padding:8px 10px;font-size:12px;max-height:46%;overflow:auto}',
        '.nkb-settings .lbl{opacity:.55;margin:8px 0 3px}',
        '.nkb-settings .lbl:first-child{margin-top:0}',
        '.nkb-chip{display:inline-block;font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:1px 8px;margin:0 4px 4px 0;cursor:pointer;opacity:.75;user-select:none}',
        '.nkb-chip.on{background:rgba(80,140,255,.18);border-color:rgba(80,140,255,.6);opacity:1}',
        '.nkb-main{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;overflow:hidden}',
        '.nkb-main svg{display:block;width:100%;height:100%;cursor:grab;touch-action:none}',
        '.nkb-main svg.drag{cursor:grabbing}',
        '.nkb-gbar{position:absolute;right:10px;bottom:10px;display:flex;gap:4px;background:rgba(20,20,20,.55);border-radius:8px;padding:3px;backdrop-filter:blur(4px)}',
        '.nkb-gbar button{font:inherit;font-size:12px;color:inherit;background:transparent;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.8}',
        '.nkb-gbar button:hover{background:rgba(128,128,128,.2);opacity:1}',
        '.nkb-node rect{fill:rgba(128,128,128,.10);stroke-width:1.3;rx:6}',
        '.nkb-node:hover rect{fill:rgba(128,128,128,.20)}',
        '.nkb-node.sel rect{fill:rgba(80,140,255,.22);stroke:#5b9dff;stroke-width:2}',
        '.nkb-node text{fill:currentColor;font-size:11.5px;pointer-events:none}',
        '.nkb-node.folder rect{stroke-dasharray:3 2}',
        '.nkb-edge{stroke:rgba(128,128,128,.45);stroke-width:1;fill:none}',
        '.nkb-edge.on{stroke:#5b9dff;stroke-width:2}',
        // 电路板：板底、走线、模块、芯片、焊盘、丝印、面包屑
        '.nkb-bboard{fill:rgba(96,150,120,.07);stroke:rgba(120,170,140,.42);stroke-width:1.2}',
        '.nkb-btrace{fill:none;stroke:rgba(128,128,128,.22);stroke-width:1;stroke-linecap:round}',
        '.nkb-btrace.bus{stroke:rgba(128,128,128,.32);stroke-width:1.4}',
        '.nkb-bmod rect{fill:rgba(128,128,128,.05);stroke-width:1.1;cursor:pointer}',
        '.nkb-bmod:hover rect{fill:rgba(128,128,128,.12)}',
        '.nkb-bmod.sel rect{fill:rgba(80,140,255,.10);stroke:#5b9dff;stroke-width:2}',
        '.nkb-bchip rect{fill:rgba(128,128,128,.10);stroke-width:.8;cursor:pointer}',
        '.nkb-bchip:hover rect{fill:rgba(128,128,128,.20)}',
        '.nkb-bchip.sel rect{fill:rgba(80,140,255,.28);stroke:#5b9dff;stroke-width:1.6}',
        '.nkb-bpad circle{fill:rgba(128,128,128,.5);cursor:pointer}',
        '.nkb-bpad circle.ring{fill:none;stroke:rgba(128,128,128,.45);stroke-width:1}',
        '.nkb-bpad:hover circle{fill:#5b9dff}',
        '.nkb-bpad.sel circle{fill:#5b9dff;stroke:#5b9dff}',
        '.nkb-blab text{fill:currentColor;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;opacity:.92}',
        '.nkb-blab text.cnt{opacity:.42;font-size:9.5px}',
        '.nkb-bbadge{fill:currentColor;opacity:.45;font-size:9px;pointer-events:none}',
        '.nkb-crumb{position:absolute;left:10px;top:8px;display:flex;flex-wrap:wrap;gap:2px;max-width:72%;align-items:center;background:rgba(20,20,20,.5);border-radius:8px;padding:3px 4px;backdrop-filter:blur(4px)}',
        '.nkb-crumb-i{font-size:11.5px;padding:1px 6px;border-radius:6px;cursor:pointer;opacity:.7;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}',
        '.nkb-crumb-i:hover{background:rgba(128,128,128,.2);opacity:1}',
        '.nkb-crumb-i.on{opacity:1;background:rgba(80,140,255,.22)}',
        '.nkb-crumb-i + .nkb-crumb-i::before{content:"›";opacity:.4;margin-right:3px}',
        '.nkb-right{width:460px;flex:0 0 460px;min-width:320px;max-width:52vw;border-left:1px solid rgba(128,128,128,.25);display:flex;flex-direction:column;min-height:0}',
        '.nkb-content{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
        '.nkb-props{flex:0 0 auto;max-height:40%;overflow:auto;border-top:1px solid rgba(128,128,128,.25);padding:8px 12px;font-size:12px;line-height:1.65}',
        '.nkb-meta{width:280px;flex:0 0 280px;overflow:auto;border-left:1px solid rgba(128,128,128,.25);padding:10px 12px;font-size:12px;line-height:1.7}',
        '.nkb-tabs{display:flex;gap:4px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.18);flex:0 0 auto}',
        '.nkb-tabs button{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.7}',
        '.nkb-tabs button.on{background:rgba(128,128,128,.18);opacity:1}',
        '.nkb-text{flex:1 1 auto;overflow:auto;margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65}',
        '.nkb-md{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:10px 16px 24px;font-size:13px;line-height:1.72;word-break:break-word}',
        '.nkb-md h1,.nkb-md h2,.nkb-md h3,.nkb-md h4,.nkb-md h5,.nkb-md h6{margin:14px 0 6px;line-height:1.35;font-weight:650}',
        '.nkb-md h1{font-size:19px;border-bottom:1px solid rgba(128,128,128,.25);padding-bottom:4px}',
        '.nkb-md h2{font-size:16.5px;border-bottom:1px solid rgba(128,128,128,.16);padding-bottom:3px}',
        '.nkb-md h3{font-size:14.5px}.nkb-md h4,.nkb-md h5,.nkb-md h6{font-size:13px}',
        '.nkb-md p{margin:6px 0;white-space:pre-wrap}',
        '.nkb-md ul,.nkb-md ol{margin:6px 0 6px 0;padding-left:22px}',
        '.nkb-md li{margin:2px 0;white-space:pre-wrap}',
        '.nkb-md blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid rgba(128,128,128,.4);opacity:.85}',
        '.nkb-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:rgba(128,128,128,.16);border-radius:4px;padding:1px 4px}',
        '.nkb-md pre{margin:8px 0;padding:10px 12px;background:rgba(128,128,128,.12);border-radius:8px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6}',
        '.nkb-md pre code{background:none;padding:0;font-size:12px}',
        '.nkb-md a{color:#5b9dff;text-decoration:none}.nkb-md a:hover{text-decoration:underline}',
        '.nkb-md hr{border:none;border-top:1px solid rgba(128,128,128,.3);margin:14px 0}',
        '.nkb-md table{border-collapse:collapse;margin:0;font-size:12.5px}',
        '.nkb-tablewrap{overflow-x:auto;max-width:100%;margin:8px 0}',
        '.nkb-cut{flex:0 0 auto;font-size:11.5px;opacity:.75;padding:5px 14px;border-bottom:1px solid rgba(128,128,128,.18);background:rgba(180,140,40,.10)}',
        '.nkb-md th,.nkb-md td{border:1px solid rgba(128,128,128,.3);padding:3px 8px;text-align:left;vertical-align:top}',
        '.nkb-md th{background:rgba(128,128,128,.12);font-weight:600}',
        '.nkb-md math{font-size:1.06em;font-family:"Cambria Math","Latin Modern Math",Symbol,serif}',
        '.nkb-md .nkb-math{white-space:normal;display:inline-block;vertical-align:middle;max-width:100%;overflow-x:auto;overflow-y:hidden}',
        '.nkb-md .nkb-math-block{display:block;text-align:center;margin:10px 0}',
        '.nkb-row{display:flex;align-items:center;gap:2px;border-radius:6px;cursor:pointer;padding:1px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.nkb-row:hover{background:rgba(128,128,128,.14)}',
        '.nkb-row.on{background:rgba(80,140,255,.20)}',
        '.nkb-row .t{opacity:.85;overflow:hidden;text-overflow:ellipsis}',
        '.nkb-row .n{opacity:.45;font-size:11px;margin-left:6px}',
        '.nkb-caret{width:12px;flex:0 0 12px;opacity:.55;text-align:center;user-select:none}',
        '.nkb-tag{font-size:10.5px;opacity:.6;border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:0 4px;margin-left:6px}',
        '.nkb-hit{padding:6px 6px;border-radius:6px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.12)}',
        '.nkb-hit:hover{background:rgba(128,128,128,.12)}',
        '.nkb-hit.on{background:rgba(80,140,255,.18)}',
        '.nkb-hit .tt{font-weight:600}',
        '.nkb-hit .sn{opacity:.7;white-space:pre-wrap;margin-top:2px;font-size:11.5px;line-height:1.5;max-height:5.2em;overflow:hidden}',
        '.nkb-muted{opacity:.55}',
        '.nkb-err{color:#d9534f;white-space:pre-wrap}',
        '.nkb-link{color:#3b82f6;cursor:pointer;text-decoration:underline dotted}',
      '.nkb-macro{color:#b45309;cursor:help;text-decoration:underline dashed}',
        '.nkb-kv{display:flex;gap:6px}',
        '.nkb-kv .k{opacity:.5;flex:0 0 58px}',
        '.nkb-kv .v{word-break:break-all}',
        '.nkb-sec{margin:10px 0 2px;font-weight:600;opacity:.7}',
        '.nkb-diag{padding:10px 14px;overflow:auto;flex:1 1 auto;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}'
      ].join('\n')
      var el = document.getElementById('project-node-memory-style')
      if (el) {
        if (el.textContent !== css) el.textContent = css
        return
      }
      el = document.createElement('style')
      el.id = 'project-node-memory-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    // ── 小组件 ────────────────────────────────────────────────────────────
    /** 把 [[node="x"]] / [[tscl="x"]] / [[x]] 变成可点条目（点击跳到节点；宏点击跳到定义所在处） */
    function Rich(props) {
      var text = props.text || ''
      var terms = props.terms || null
      var box = useRef(null)
      useEffect(function () {
        if (!props.focus) return
        var el = box.current
        if (!el) return
        var mk = el.querySelector('mark.nkb-hl')
        if (mk && typeof mk.scrollIntoView === 'function') mk.scrollIntoView({ block: 'center' })
      }, [props.focus, text])
      var parts = useMemo(function () {
        var out = []
        var re = /\[\[node\s*=\s*"([^"]+)"\]\]|\[\[tscl\s*=\s*"([^"]+)"\]\]|\[\[([a-zA-Z0-9\u4e00-\u9fff:._-]+)\]\]/g
        var last = 0
        var m
        while ((m = re.exec(text))) {
          if (m.index > last) out.push({ t: text.slice(last, m.index) })
          var kind = m[1] !== undefined ? 'node' : m[2] !== undefined ? 'tscl' : 'bare'
          var id = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]
          out.push({ t: m[0], tid: kind === 'tscl' ? '' : id, macro: kind === 'tscl' ? id : '' })
          last = m.index + m[0].length
        }
        if (last < text.length) out.push({ t: text.slice(last) })
        return out
      }, [text])
      return h(
        'pre',
        { className: 'nkb-text', ref: box },
        parts.map(function (p, i) {
          if (p.macro) {
            return h(
              'span',
              { key: i, className: 'nkb-macro', title: '宏：' + p.macro, onClick: function () { props.onMacro && props.onMacro(p.macro) } },
              p.t,
            )
          }
          if (!p.tid) return h('span', { key: i }, hlNodes(p.t, terms, 'r' + i))
          return h(
            'span',
            { key: i, className: 'nkb-link', onClick: function () { props.onOpen && props.onOpen(p.tid) } },
            p.t,
          )
        }),
      )
    }

    // ── 类型颜色：同一类型恒定取色 ─────────────────────────────────────────
    var TYPE_HUE = { root: 210, folder: 38, file: 96, doc: 205, facts: 150, lessons: 32, todo: 8, handover: 282, index: 190, library: 320, section: 250 }
    function typeColor(type) {
      var s = String(type || '')
      if (!s) return 'rgba(128,128,128,.55)'
      var hue = TYPE_HUE[s]
      if (hue === undefined) {
        var acc = 0
        for (var i = 0; i < s.length; i++) acc = (acc * 31 + s.charCodeAt(i)) % 360
        hue = acc
      }
      return 'hsl(' + hue + ' 62% 58%)'
    }
    /** 同色半透明填充：模块用外框色的淡色块，别让板子透出底图 */
    function typeFill(type, a) {
      var c = typeColor(type)
      if (c.indexOf('hsl(') === 0) return 'hsl(' + c.slice(4, c.length - 1) + ' / ' + a + ')'
      var m = /^rgba?\(([^)]+)\)$/.exec(c)
      if (!m) return c
      var p = m[1].split(',')
      if (p.length < 3) return c
      return 'rgba(' + p[0].trim() + ',' + p[1].trim() + ',' + p[2].trim() + ',' + a + ')'
    }

    // ── LaTeX 子集 → MathML（浏览器原生排版，不引 KaTeX、不带字体）──────────
    var TEX_GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'.split(' ')
    var TEX_SYM = {
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ',
      eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
      xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
      tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
      Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
      Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
      times: '×', cdot: '⋅', pm: '±', mp: '∓', div: '÷', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
      le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼', simeq: '≃', cong: '≅',
      equiv: '≡', propto: '∝', ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇',
      sum: '∑', prod: '∏', coprod: '∐', int: '∫', oint: '∮', iint: '∬', iiint: '∭',
      to: '→', rightarrow: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐',
      leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔', implies: '⇒', mapsto: '↦',
      forall: '∀', exists: '∃', nexists: '∄', in: '∈', notin: '∉', ni: '∋',
      subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
      emptyset: '∅', varnothing: '∅', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
      angle: '∠', perp: '⊥', parallel: '∥', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
      degree: '°', prime: '′', therefore: '∴', because: '∵', hbar: 'ℏ', ell: 'ℓ',
      langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|', vert: '|', Vert: '‖', backslash: '∖',
    }
    var TEX_LETTERLIKE = ['partial', 'nabla', 'ell', 'hbar', 'aleph', 'Re', 'Im']
    var TEX_FUNCS = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf', 'lim', 'det', 'dim', 'ker', 'deg', 'gcd', 'Pr', 'arg', 'mod', 'bmod']

    function texEscape(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    function texToMathML(src, display) {
      var s = String(src == null ? '' : src)
      var i = 0
      var budget = 40000
      function startsWith(t) { return s.slice(i, i + t.length) === t }
      function skipWs() { while (i < s.length && /\s/.test(s[i])) i++ }
      function readName() {
        if (/[a-zA-Z]/.test(s[i] || '')) { var a = i; while (/[a-zA-Z]/.test(s[i] || '')) i++; return s.slice(a, i) }
        var ch = s[i] || ''; i++; return ch
      }
      function rawGroupText() {
        skipWs()
        if (s[i] !== '{') return readName()
        var d = 1
        var st = ++i
        while (i < s.length && d > 0) { if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (d === 0) break } i++ }
        var t = s.slice(st, i)
        if (s[i] === '}') i++
        return t
      }
      function inner(str) {
        var m = texToMathML(str, false)
        return m.replace(/^<math[^>]*>/, '').replace(/<\/math>$/, '')
      }
      function seq(stops, envMode, stopRight) {
        var out = []
        while (i < s.length && budget-- > 0) {
          skipWs()
          if (stops && stops.indexOf(s[i]) >= 0) break
          if (envMode && (startsWith('\\\\') || startsWith('\\end'))) break
          if (stopRight && startsWith('\\right')) break
          if (s[i] === '^' || s[i] === '_') {
            var base = out.pop() || '<mrow></mrow>'
            var sub = null
            var sup = null
            while (s[i] === '^' || s[i] === '_') {
              var take = s[i]
              i++
              var a2 = arg()
              if (take === '^') sup = a2
              else sub = a2
              skipWs()
            }
            out.push(sub !== null && sup !== null
              ? '<msubsup>' + base + sub + sup + '</msubsup>'
              : sup !== null ? '<msup>' + base + sup + '</msup>' : '<msub>' + base + sub + '</msub>')
            continue
          }
          var a = atom()
          if (a === null) i++
          else if (a) out.push(a)
        }
        return out.length === 1 ? out[0] : '<mrow>' + out.join('') + '</mrow>'
      }
      function arg() {
        skipWs()
        if (s[i] === '{') { i++; var v = seq('}'); if (s[i] === '}') i++; return v }
        var a = atom()
        return a || '<mrow></mrow>'
      }
      function atom() {
        skipWs()
        var c = s[i]
        if (c === undefined) return null
        if (c === '{') { i++; var g = seq('}'); if (s[i] === '}') i++; return g }
        if (c === '\\') { i++; return command() }
        if (/\d/.test(c)) { var a = i; while (/[\d.]/.test(s[i] || '')) i++; return '<mn>' + s.slice(a, i) + '</mn>' }
        if (/[a-zA-Z]/.test(c)) {
          // 一次一个字母：x^2 只作用于最后一个字母，与 TeX 的原子语义一致
          i++
          return '<mi>' + c + '</mi>'
        }
        if (c === '&') return null
        i++
        if (c === '-') return '<mo>−</mo>'
        if (c === '*') return '<mo>∗</mo>'
        if (c === "'") return '<mo>′</mo>'
        return '<mo>' + texEscape(c) + '</mo>'
      }
      function env() {
        var name = rawGroupText().trim()
        var rows = []
        var cells = []
        while (i < s.length && budget-- > 0) {
          skipWs()
          if (startsWith('\\end')) { i += 4; rawGroupText(); break }
          cells.push(seq('&', true))
          skipWs()
          if (s[i] === '&') { i++; continue }
          rows.push(cells)
          cells = []
          if (startsWith('\\\\')) { i += 2; continue }
          if (startsWith('\\end')) { i += 4; rawGroupText(); break }
          if (i < s.length) i++
        }
        if (cells.length) rows.push(cells)
        var body = rows.map(function (r) {
          return '<mtr>' + r.map(function (c) { return '<mtd>' + (c || '') + '</mtd>' }).join('') + '</mtr>'
        }).join('')
        var table = '<mtable>' + body + '</mtable>'
        if (/^[pbBvV]matrix$/.test(name)) {
          var pair = name.charAt(0) === 'p' ? ['(', ')'] : name.charAt(0) === 'b' ? ['[', ']'] : name.charAt(0) === 'B' ? ['{', '}'] : ['|', '|']
          return '<mrow><mo fence="true" stretchy="true">' + pair[0] + '</mo>' + table + '<mo fence="true" stretchy="true">' + pair[1] + '</mo></mrow>'
        }
        if (name === 'cases') return '<mrow><mo fence="true" stretchy="true">{</mo><mtable columnalign="left left">' + body + '</mtable></mrow>'
        if (name === 'aligned' || name === 'align' || name === 'split' || name === 'alignedat') return '<mtable columnalign="right left">' + body + '</mtable>'
        return table
      }
      function command() {
        var name = readName()
        switch (name) {
          case 'frac': case 'dfrac': case 'tfrac':
            return '<mfrac>' + arg() + arg() + '</mfrac>'
          case 'binom':
            return '<mrow><mo fence="true" stretchy="true">(</mo><mfrac linethickness="0">' + arg() + arg() + '</mfrac><mo fence="true" stretchy="true">)</mo></mrow>'
          case 'sqrt': {
            skipWs()
            var deg = null
            if (s[i] === '[') {
              var st2 = ++i
              while (i < s.length && s[i] !== ']') i++
              deg = '<mrow>' + inner(s.slice(st2, i)) + '</mrow>'
              if (s[i] === ']') i++
            }
            var body = arg()
            return deg ? '<mroot>' + body + deg + '</mroot>' : '<msqrt>' + body + '</msqrt>'
          }
          case 'text': case 'textrm': case 'mbox': case 'operatorname':
            return '<mtext>' + texEscape(rawGroupText()) + '</mtext>'
          case 'mathrm': case 'mathbf': case 'mathit': case 'mathsf': case 'mathtt': case 'mathbb': case 'mathcal': case 'boldsymbol': {
            var vmap = { mathrm: 'normal', mathbf: 'bold', mathit: 'italic', mathsf: 'sans-serif', mathtt: 'monospace', mathbb: 'double-struck', mathcal: 'script', boldsymbol: 'bold-italic' }
            return '<mstyle mathvariant="' + vmap[name] + '">' + arg() + '</mstyle>'
          }
          case 'overline': case 'bar':
            return '<mover accent="true">' + arg() + '<mo>‾</mo></mover>'
          case 'underline':
            return '<munder accentunder="true">' + arg() + '<mo>_</mo></munder>'
          case 'hat': case 'widehat':
            return '<mover accent="true">' + arg() + '<mo>^</mo></mover>'
          case 'vec':
            return '<mover accent="true">' + arg() + '<mo>→</mo></mover>'
          case 'dot':
            return '<mover accent="true">' + arg() + '<mo>˙</mo></mover>'
          case 'ddot':
            return '<mover accent="true">' + arg() + '<mo>¨</mo></mover>'
          case 'tilde': case 'widetilde':
            return '<mover accent="true">' + arg() + '<mo>~</mo></mover>'
          case 'left': {
            skipWs()
            var open = ''
            if (s[i] === '\\') { i++; var n3 = readName(); open = TEX_SYM[n3] !== undefined ? TEX_SYM[n3] : n3 }
            else { open = s[i] === undefined ? '' : s[i]; i++ }
            var content = seq(null, true, true)
            var close = ''
            if (startsWith('\\right')) {
              i += 6
              skipWs()
              if (s[i] === '\\') { i++; var n4 = readName(); close = TEX_SYM[n4] !== undefined ? TEX_SYM[n4] : n4 }
              else { close = s[i] === undefined ? '' : s[i]; i++ }
            }
            var op = open === '.' || open === '' ? '' : '<mo fence="true" stretchy="true">' + texEscape(open) + '</mo>'
            var cp = close === '.' || close === '' ? '' : '<mo fence="true" stretchy="true">' + texEscape(close) + '</mo>'
            return '<mrow>' + op + content + cp + '</mrow>'
          }
          case 'right': {
            skipWs()
            if (s[i] === '\\') { i++; readName() } else i++
            return ''
          }
          case 'begin':
            return env()
          case 'end':
            rawGroupText()
            return ''
          case 'quad': return '<mspace width="1em"></mspace>'
          case 'qquad': return '<mspace width="2em"></mspace>'
          case ',': case ':': case ';': case '!': case ' ': case 'thinspace':
            return '<mspace width="0.1667em"></mspace>'
          case 'displaystyle': case 'textstyle': case 'limits': case 'nolimits': case 'hline':
            return ''
          case '\\':
            return '<mspace linebreak="newline"></mspace>'
        }
        if (TEX_FUNCS.indexOf(name) >= 0) return '<mi mathvariant="normal">' + name + '</mi>'
        if (TEX_SYM[name] !== undefined) {
          var v = TEX_SYM[name]
          if (TEX_GREEK.indexOf(name) >= 0 || TEX_LETTERLIKE.indexOf(name) >= 0) return '<mi>' + texEscape(v) + '</mi>'
          var big = '∑∏∐∫∬∭∮'.indexOf(v) >= 0
          return '<mo' + (big ? ' largeop="true"' : '') + '>' + texEscape(v) + '</mo>'
        }
        return '<mtext>' + texEscape(name) + '</mtext>'
      }
      var body
      try {
        body = seq(null, false)
      } catch (e) {
        return '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>' + texEscape(s) + '</mtext></math>'
      }
      return '<math xmlns="http://www.w3.org/1998/Math/MathML"' + (display ? ' display="block"' : '') + '>' + body + '</math>'
    }

    function safeTex(src, display) {
      try {
        return texToMathML(src, display)
      } catch (e) {
        return '<span>' + texEscape(src) + '</span>'
      }
    }

    // ── 极简 markdown 渲染（不引第三方库）─────────────────────────────────
    var MD_INLINE = /`([^`\n]+)`|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\[\[node\s*=\s*"([^"]+)"\]\]|\[\[tscl\s*=\s*"([^"]+)"\]\]|\[\[([a-zA-Z0-9\u4e00-\u9fff:._-]+)\]\]|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g

    // ── 检索高亮 ──────────────────────────────────────────────────────────
    /** 检索词 → 小写词元（与引擎的 2-gram 不同：面板只高亮人打进框里的原词） */
    function hlTerms(q) {
      return String(q || '')
        .trim()
        .split(/\s+/)
        .filter(function (t) { return !!t })
        .map(function (t) { return t.toLowerCase() })
    }

    /** 把一段纯文本切成 [{t, hit}]：命中段 hit=true。按「最靠前、同位置取最长」挑词。 */
    function hlRuns(text, terms) {
      var s = String(text == null ? '' : text)
      if (!terms || !terms.length || !s) return [{ t: s }]
      var low = s.toLowerCase()
      var out = []
      var pos = 0
      while (pos < s.length) {
        var best = -1
        var blen = 0
        for (var i = 0; i < terms.length; i++) {
          var idx = low.indexOf(terms[i], pos)
          if (idx < 0) continue
          if (best < 0 || idx < best || (idx === best && terms[i].length > blen)) {
            best = idx
            blen = terms[i].length
          }
        }
        if (best < 0 || !blen) break
        if (best > pos) out.push({ t: s.slice(pos, best) })
        out.push({ t: s.slice(best, best + blen), hit: true })
        pos = best + blen
      }
      if (pos < s.length) out.push({ t: s.slice(pos) })
      return out
    }

    /** hlRuns 的 React 版：命中段包一层 <mark class="nkb-hl">（可被 scrollIntoView 定位） */
    function hlNodes(text, terms, keyPrefix) {
      var runs = hlRuns(text, terms)
      if (runs.length === 1 && !runs[0].hit) return [runs[0].t]
      return runs.map(function (r, i) {
        return r.hit ? h('mark', { key: keyPrefix + '-h' + i, className: 'nkb-hl' }, r.t) : r.t
      })
    }

    /** 单元素 children 版：没有命中就返回原字符串（children 保持纯文本，不额外包层） */
    function hlChildren(text, terms, keyPrefix) {
      var runs = hlRuns(text, terms)
      if (runs.length === 1 && !runs[0].hit) return runs[0].t
      return runs.map(function (r, i) {
        return r.hit ? h('mark', { key: keyPrefix + '-h' + i, className: 'nkb-hl' }, r.t) : r.t
      })
    }

    function mdInline(text, onOpen, kbKey, terms) {
      var out = []
      var last = 0
      var m
      var n = 0
      MD_INLINE.lastIndex = 0
      while ((m = MD_INLINE.exec(text))) {
        if (m.index > last) out.push(...hlNodes(text.slice(last, m.index), terms, kbKey + '-t' + n))
        var key = kbKey + '-i' + n++
        if (m[1] !== undefined) {
          out.push(h('code', { key: key }, hlChildren(m[1], terms, key + '-c')))
        } else if (m[2] !== undefined || m[3] !== undefined) {
          var texSrc = m[2] !== undefined ? m[2] : m[3]
          out.push(h('span', { key: key, className: 'nkb-math', dangerouslySetInnerHTML: { __html: safeTex(texSrc, m[2] !== undefined) } }))
        } else if (m[4] !== undefined || m[6] !== undefined) {
          var nid = m[4] !== undefined ? m[4] : m[6]
          out.push(
            h(
              'span',
              { key: key, className: 'nkb-link', title: nid, onClick: (function (tid) { return function () { onOpen && onOpen(tid) } })(nid) },
              nid,
            ),
          )
        } else if (m[5] !== undefined) {
          out.push(h('span', { key: key, className: 'nkb-macro', title: '宏：' + m[5] }, m[5]))
        } else if (m[7] !== undefined) {
          out.push(h('strong', { key: key }, hlChildren(m[7], terms, key + '-b')))
        } else if (m[8] !== undefined) {
          out.push(h('em', { key: key }, hlChildren(m[8], terms, key + '-e')))
        } else if (m[9] !== undefined) {
          out.push(h('a', { key: key, href: m[10], target: '_blank', rel: 'noreferrer' }, m[9]))
        }
        last = m.index + m[0].length
      }
      if (last < text.length) out.push(...hlNodes(text.slice(last), terms, kbKey + '-t' + n))
      return out
    }

    function splitRow(line) {
      return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (s) { return s.trim() })
    }

    function mdBlocks(text) {
      var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      var blocks = []
      var i = 0
      while (i < lines.length) {
        var line = lines[i]
        if (!line.trim()) { i++; continue }
        var fence = /^\s*```(\S*)\s*$/.exec(line)
        if (fence) {
          var buf = []
          i++
          while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++])
          i++
          var lang = fence[1] || ''
          blocks.push({ k: /^(math|tex|latex)$/i.test(lang) ? 'math' : 'code', lang: lang, text: buf.join('\n') })
          continue
        }
        if (/^\s*\$\$/.test(line)) {
          var mb = []
          var rest = line.replace(/^\s*\$\$/, '')
          if (/\$\$\s*$/.test(rest)) {
            blocks.push({ k: 'math', text: rest.replace(/\$\$\s*$/, '') })
            i++
            continue
          }
          if (rest.trim()) mb.push(rest)
          i++
          while (i < lines.length && !/\$\$/.test(lines[i])) mb.push(lines[i++])
          if (i < lines.length) {
            mb.push(lines[i].replace(/\$\$[\s\S]*$/, ''))
            i++
          }
          blocks.push({ k: 'math', text: mb.join('\n') })
          continue
        }
        var hd = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hd) { blocks.push({ k: 'h', level: hd[1].length, text: hd[2].trim() }); i++; continue }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ k: 'hr' }); i++; continue }
        if (/^\s*>/.test(line)) {
          var q = []
          while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
          blocks.push({ k: 'quote', text: q.join('\n') })
          continue
        }
        if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
          var items = []
          while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
            var lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
            items.push({ depth: Math.min(4, Math.floor(lm[1].length / 2.2)), ordered: /\d/.test(lm[2]), text: lm[3] })
            i++
          }
          blocks.push({ k: 'list', items: items })
          continue
        }
        if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
          var th = splitRow(line)
          i += 2
          var rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]))
          blocks.push({ k: 'table', head: th, rows: rows })
          continue
        }
        var para = [line]
        i++
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\$\$|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) {
          para.push(lines[i++])
        }
        blocks.push({ k: 'p', text: para.join('\n') })
      }
      return blocks
    }

    function mdBlock(b, idx, onOpen, terms) {
      var k = 'b' + idx
      if (b.k === 'code') return h('pre', { key: k }, h('code', null, b.text))
      if (b.k === 'math') return h('div', { key: k, className: 'nkb-math nkb-math-block', dangerouslySetInnerHTML: { __html: safeTex(b.text, true) } })
      if (b.k === 'h') return h('h' + b.level, { key: k }, mdInline(b.text, onOpen, k, terms))
      if (b.k === 'hr') return h('hr', { key: k })
      if (b.k === 'quote') return h('blockquote', { key: k }, mdInline(b.text, onOpen, k, terms))
      if (b.k === 'list') {
        var tag = b.items.length && b.items[0].ordered ? 'ol' : 'ul'
        return h(
          tag,
          { key: k },
          b.items.map(function (it, j) {
            return h('li', { key: k + '-' + j, style: { marginLeft: it.depth * 14 + 'px' } }, mdInline(it.text, onOpen, k + '-' + j, terms))
          }),
        )
      }
      if (b.k === 'table') {
        // 外面套一层横向滚动，宽表格不会顶出面板
        return h(
          'div',
          { key: k, className: 'nkb-tablewrap' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, b.head.map(function (c, j) { return h('th', { key: j }, mdInline(c, onOpen, k + 'h' + j, terms)) }))),
            h('tbody', null, b.rows.map(function (r, j) {
              return h('tr', { key: j }, r.map(function (c, cj) { return h('td', { key: cj }, mdInline(c, onOpen, k + j + '-' + cj, terms)) }))
            })),
          ),
        )
      }
      return h('p', { key: k }, mdInline(b.text, onOpen, k, terms))
    }

    function Md(props) {
      var text = props.text || ''
      var terms = props.terms || null
      var blocks = useMemo(function () { return mdBlocks(text) }, [text])
      var box = useRef(null)
      // 点检索结果时把预览滚到第一处命中（命中处由 mark.nkb-hl 标出）
      useEffect(function () {
        if (!props.focus) return
        var el = box.current
        if (!el) return
        var mk = el.querySelector('mark.nkb-hl')
        if (mk && typeof mk.scrollIntoView === 'function') mk.scrollIntoView({ block: 'center' })
      }, [props.focus, text])
      return h('div', { className: 'nkb-md', ref: box }, blocks.map(function (b, i) { return mdBlock(b, i, props.onOpen, terms) }))
    }

    function TreeRow(props) {
      var node = props.node
      var onOpen = props.onSelect || props.onOpen
      var sel = props.sel
      var expanded = props.expanded
      var toggle = props.toggle
      var depth = props.depth || 0
      var kids = node.children || []
      var open = expanded[node.tid] !== false && kids.length > 0
      var rows = [
        h(
          'div',
          {
            key: node.tid,
            className: 'nkb-row' + (sel === node.tid ? ' on' : ''),
            'data-tid': node.tid,
            style: { paddingLeft: 4 + depth * 11 + 'px' },
            title: node.tid + (node.source ? '\n' + node.source : ''),
            onClick: function () { onOpen(node.tid) },
          },
          h(
            'span',
            {
              className: 'nkb-caret',
              onClick: function (e) {
                e.stopPropagation()
                if (kids.length) toggle(node.tid)
              },
            },
            kids.length ? (open ? '▾' : '▸') : '',
          ),
          h('span', { className: 't' }, node.title || node.tid),
          node.type ? h('span', { className: 'nkb-tag' }, node.type) : null,
          h('span', { className: 'n' }, node.chars),
        ),
      ]
      if (open) {
        for (var i = 0; i < kids.length; i++) {
          rows.push(h(TreeRow, { key: kids[i].tid, node: kids[i], onOpen: onOpen, sel: sel, expanded: expanded, toggle: toggle, depth: depth + 1 }))
        }
      }
      return rows
    }

    function Icon(props) {
      var size = props.size || 18
      // 形状：三个叠层的方块 = 「库里的一棵节点树」
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 2.5, width: 14, height: 4, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('rect', { x: 3, y: 8, width: 9.5, height: 3.4, rx: 1.1, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.85 }),
        h('rect', { x: 3, y: 12.6, width: 6.5, height: 3.4, rx: 1.1, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.6 }),
        h('path', { d: 'M13.5 10.7v6.6', stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.55, strokeLinecap: 'round' }),
      )
    }

    // ── 节点图（自己排的树形布局，不引第三方库）──────────────────────────
    // 方框宽度固定，高度随标题行数变：标题最多显示 30 个字符，超出补省略号，
    // 自动换行最多 3 行（再多也是省略号），框高 = 行数 × 行高 + 上下内边距。
    var NODE_W = 188
    var NODE_H = 34 // 单行时的最小高度
    var NODE_MAX_CHARS = 30
    var NODE_LINE_H = 14
    var NODE_PAD_Y = 10
    var NODE_PAD_X = 10
    var NODE_MAX_LINES = 3
    var NODE_FONT = 12

    var WIDE_CH = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

    // 标点禁则：这些收尾标点不另起一行（挂在上行末尾，最多探出一个字宽）
    var HANG_PUNCT = /^[，。、；：！？）》」』】…·,.;:!?)\]]$/

    /** 估算单字符宽度（12px 字号下全角≈12px，半角≈6.6px）——不量 DOM，图在
     *  离屏或未挂载时也能算，且同一份数据每次排出来都一样。 */
    function chWidth(ch) {
      return WIDE_CH.test(ch) ? NODE_FONT : NODE_FONT * 0.55
    }

    /** 一串文字的估算宽度（与 chWidth 同一套口径） */
    function textWidth(s) {
      var w = 0
      for (var i = 0; i < s.length; i++) w += chWidth(s[i])
      return w
    }

    /**
     * 切成「不可再分的排版单元」：连续半角字母/数字（含 `pip`、`ASCII`、`1.4.4`、
     * `kb_read` 这类词）算一个单元，换行时整体搬到下一行；全角字、空格、CJK 标点
     * 各自算一个单元（中文可以逐字断行）。
     */
    function splitUnits(s) {
      var units = []
      var i = 0
      while (i < s.length) {
        var ch = s[i]
        if (/[A-Za-z0-9]/.test(ch)) {
          var j = i + 1
          while (j < s.length && /[A-Za-z0-9_.%+\-'/:@#~]/.test(s[j])) j++
          var word = s.slice(i, j)
          units.push({ text: word, w: textWidth(word), word: true })
          i = j
        } else {
          units.push({ text: ch, w: chWidth(ch), word: false })
          i++
        }
      }
      return units
    }

    /**
     * 标题 → 方框内的若干行。
     * 先按 30 字符砍（含省略号），再按可用宽度贪心换行——**不拆连续单词**：
     * 放不下就把整个词搬到下一行；只有单个词本身比整行还宽时才硬拆。
     * 超过 3 行也截断。
     */
    function graphTitleLines(title) {
      var s = String(title == null ? '' : title).replace(/\s+/g, ' ').trim()
      if (!s) s = '(无标题)'
      var maxW = NODE_W - NODE_PAD_X * 2
      var budget = NODE_MAX_CHARS
      var all = splitUnits(s)
      // 30 字符预算也按词算：放不下的整个词直接停在这里（“在其之前找断点”），
      // 只有单个词本身就超过预算时才硬切。
      var units = []
      var count = 0
      var truncated = false
      for (var k = 0; k < all.length; k++) {
        var u0 = all[k]
        if (count + u0.text.length > budget) {
          truncated = true
          if (u0.word && u0.text.length > budget && count === 0) {
            var piece = u0.text.slice(0, budget)
            units.push({ text: piece, w: textWidth(piece), word: true })
            count = piece.length
          }
          break
        }
        units.push(u0)
        count += u0.text.length
      }
      var lines = []
      var cur = ''
      var curW = 0
      var flush = function () {
        if (cur) {
          lines.push(cur.replace(/\s+$/, ''))
          cur = ''
          curW = 0
        }
      }
      for (var i = 0; i < units.length; i++) {
        var u = units[i]
        if (u.w > maxW) {
          // 单个词比整行还宽（超长 URL / 哈希）：只能按字符硬拆
          flush()
          var rest = u.text
          while (rest) {
            var take = ''
            var tw = 0
            while (rest.length && tw + chWidth(rest[0]) <= maxW) {
              tw += chWidth(rest[0])
              take += rest[0]
              rest = rest.slice(1)
            }
            if (!take) {
              take = rest[0]
              tw = chWidth(take)
              rest = rest.slice(1)
            }
            if (rest) lines.push(take)
            else {
              cur = take
              curW = tw
            }
          }
          continue
        }
        // 放不下整个词：换行点落在词开始之前，不拆词
        if (curW + u.w > maxW && cur) {
          // 标点禁则：收尾标点不另起一行，宁可让它在行尾稍微探出一点
          if (!HANG_PUNCT.test(u.text)) flush()
        }
        if (!cur && u.text === ' ') continue // 行首不挂空格
        cur += u.text
        curW += u.w
      }
      flush()
      if (lines.length > NODE_MAX_LINES) {
        lines = lines.slice(0, NODE_MAX_LINES)
        truncated = true
      }
      if (truncated) {
        // 末行补省略号：先整词卸载，实在不行才退字符
        var ell = chWidth('…')
        var lastUnits = splitUnits(lines[lines.length - 1] || '')
        var w2 = 0
        for (var a = 0; a < lastUnits.length; a++) w2 += lastUnits[a].w
        while (lastUnits.length > 1 && w2 + ell > maxW) {
          var popped = lastUnits.pop()
          w2 -= popped.w
        }
        var last = lastUnits.map(function (x) { return x.text }).join('')
        while (last.length > 1 && w2 + ell > maxW) {
          var cut = last[last.length - 1]
          w2 -= chWidth(cut)
          last = last.slice(0, -1)
        }
        lines[lines.length - 1] = last.replace(/\s+$/, '').replace(/…$/, '') + '…'
      }
      return { lines: lines, truncated: truncated, chars: count }
    }

    /** 方框高度：单行沿用 NODE_H，多行按行数撑高 */
    function graphNodeHeight(lines) {
      var n = (lines && lines.length) || 1
      return Math.max(NODE_H, n * NODE_LINE_H + NODE_PAD_Y * 2 - 4)
    }

    function walkTree(node, fn, depth) {
      if (!node) return
      fn(node, depth || 0)
      var kids = node.children || []
      for (var i = 0; i < kids.length; i++) walkTree(kids[i], fn, (depth || 0) + 1)
    }

    function collectTypes(root) {
      var set = {}
      walkTree(root, function (n) {
        if (n.type) set[n.type] = (set[n.type] || 0) + 1
      })
      return set
    }

    /**
     * 树 → 坐标。叶子按顺序占槽位，父节点落在首尾子节点的中点上，
     * 跟 MCP WebUI 的确定性布局一个思路：同样的树每次画出来都一样。
     */
    function layoutGraph(root, opts) {
      var items = []
      function collect(node, depth) {
        if (!node || opts.hidden[node.type]) return null
        var kids = []
        if (depth < opts.maxDepth && !opts.collapsed[node.tid]) {
          var raw = node.children || []
          for (var i = 0; i < raw.length; i++) {
            var c = collect(raw[i], depth + 1)
            if (c) kids.push(c)
          }
        }
        var tt = graphTitleLines(node.title || node.tid)
        var it = {
          node: node,
          tid: node.tid,
          depth: depth,
          kids: kids,
          x: 0,
          y: 0,
          primary: 0,
          lines: tt.lines,
          h: graphNodeHeight(tt.lines),
          truncated: tt.truncated,
        }
        items.push(it)
        return it
      }
      var rootItem = collect(root, 0)
      if (!rootItem) return { items: [], edges: [], width: 1, height: 1, minX: 0, minY: 0 }
      var tb = opts.dir !== 'LR'
      var GAP_X = 20
      var GAP_Y = 56
      var cursor = 0
      if (tb) {
        // 横排：每层占「本层最高的那个框」那么高，层间距固定，层内 y 对齐
        var rowTop = []
        var rowH = []
        for (var r = 0; r < items.length; r++) {
          var d0 = items[r].depth
          rowH[d0] = Math.max(rowH[d0] || 0, items[r].h)
        }
        var acc = 0
        for (var d1 = 0; d1 < rowH.length; d1++) {
          rowTop[d1] = acc
          acc += (rowH[d1] || NODE_H) + GAP_Y
        }
        ;(function place(it) {
          if (!it.kids.length) {
            it.primary = cursor
            cursor += 1
          } else {
            for (var i = 0; i < it.kids.length; i++) place(it.kids[i])
            it.primary = (it.kids[0].primary + it.kids[it.kids.length - 1].primary) / 2
          }
          it.x = it.primary * (NODE_W + GAP_X)
          it.y = rowTop[it.depth] || 0
        })(rootItem)
      } else {
        // 竖排：同层 x 固定，纵向按「叶子依次往下堆」，父节点对到首尾子节点的中点
        var colX = []
        var colAcc = 0
        var maxDepth = 0
        for (var m = 0; m < items.length; m++) maxDepth = Math.max(maxDepth, items[m].depth)
        for (var d2 = 0; d2 <= maxDepth; d2++) {
          colX[d2] = colAcc
          colAcc += NODE_W + 64
        }
        var vcur = 0
        ;(function place(it) {
          if (!it.kids.length) {
            it.primary = vcur + it.h / 2
            vcur += it.h + 20
          } else {
            for (var i = 0; i < it.kids.length; i++) place(it.kids[i])
            it.primary = (it.kids[0].primary + it.kids[it.kids.length - 1].primary) / 2
          }
          it.x = colX[it.depth] || 0
          it.y = it.primary - it.h / 2
        })(rootItem)
      }
      var edges = []
      for (var i2 = 0; i2 < items.length; i2++) {
        for (var j = 0; j < items[i2].kids.length; j++) edges.push({ from: items[i2], to: items[i2].kids[j] })
      }
      var minX = Infinity
      var minY = Infinity
      var maxX = -Infinity
      var maxY = -Infinity
      for (var k = 0; k < items.length; k++) {
        var a = items[k]
        minX = Math.min(minX, a.x)
        minY = Math.min(minY, a.y)
        maxX = Math.max(maxX, a.x + NODE_W)
        maxY = Math.max(maxY, a.y + (a.h || NODE_H))
      }
      return {
        items: items,
        edges: edges,
        tb: tb,
        minX: minX,
        minY: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      }
    }

    function edgePath(a, b, tb) {
      var ah = a.h || NODE_H
      var bh = b.h || NODE_H
      if (tb) {
        var x1 = a.x + NODE_W / 2
        var y1 = a.y + ah
        var x2 = b.x + NODE_W / 2
        var y2 = b.y
        var my = (y1 + y2) / 2
        return 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2
      }
      var ax = a.x + NODE_W
      var ay = a.y + ah / 2
      var bx = b.x
      var by = b.y + bh / 2
      var mx = (ax + bx) / 2
      return 'M' + ax + ',' + ay + ' C' + mx + ',' + ay + ' ' + mx + ',' + by + ' ' + bx + ',' + by
    }

    function ellipsis(s, n) {
      s = String(s || '')
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }

    // ── 电路板视图（board）────────────────────────────────────────────────
    // 一句话规则：**模块面积 = 它占整库的百分比**（按子树节点数算），屏幕上
    // 永远只标一层名字（丝印），再往下一层画方框，最下层画焊盘圆点；点模块
    // 就是换焦点，名字自然换到下一层。布局是纯函数、无随机，同一棵树每次
    // 排出来一模一样。
    var BOARD_W = 1440
    var BOARD_H = 900
    var BOARD_OUT = 18 // 板边留白
    var MOD_GAP = 9 // 模块之间
    var MOD_PAD = 9 // 模块内边距
    var MOD_TITLE_H = 20 // 丝印标题占高
    var CHIP_GAP = 4
    var PAD_MAX = 36 // 一个方框里最多画多少焊盘，多的用 +N 徽标

    /** 参与布局的子节点（类型被筛掉的直接不出现，面积也就跟着分） */
    function boardKids(node, hidden) {
      var raw = (node && node.children) || []
      var out = []
      for (var i = 0; i < raw.length; i++) {
        if (hidden && hidden[raw[i].type]) continue
        out.push(raw[i])
      }
      return out
    }

    /** 子树节点数（含自己）——模块面积的权重 */
    function subtreeCount(node, hidden) {
      if (!node) return 0
      if (hidden && hidden[node.type]) return 0
      var n = 1
      var kids = node.children || []
      for (var i = 0; i < kids.length; i++) n += subtreeCount(kids[i], hidden)
      return n
    }

    /** 根 → tid 的路径（含两端）；找不到返回 null */
    function findPath(root, tid) {
      if (!root) return null
      if (root.tid === tid) return [root]
      var kids = root.children || []
      for (var i = 0; i < kids.length; i++) {
        var p = findPath(kids[i], tid)
        if (p) {
          p.unshift(root)
          return p
        }
      }
      return null
    }

    /** squarified treemap 的坏纵横比：越小越方 */
    function worstRatio(row, side) {
      var s = 0
      var mx = 0
      var mn = Infinity
      for (var i = 0; i < row.length; i++) {
        var a = row[i].a
        s += a
        if (a > mx) mx = a
        if (a < mn) mn = a
      }
      if (!s || !mn || !isFinite(mn)) return Infinity
      var s2 = s * s
      var side2 = side * side
      return Math.max((side2 * mx) / s2, s2 / (side2 * mn))
    }

    /**
     * 面积分配：items = [{key, v}]，把 w×h 切成与 v 成正比、尽量方的矩形。
     * 确定性来自「按权重降序 + key 升序」的稳定排序，不用随机数。
     */
    function squarify(items, x, y, w, h) {
      var out = []
      var list = []
      for (var i = 0; i < items.length; i++) if (items[i].v > 0) list.push(items[i])
      if (!list.length || w <= 0 || h <= 0) return out
      list.sort(function (a, b) {
        return b.v - a.v || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      })
      var total = 0
      for (var j = 0; j < list.length; j++) total += list[j].v
      var scale = (w * h) / total
      var rest = list.map(function (it) {
        return { key: it.key, a: it.v * scale }
      })
      var rx = x
      var ry = y
      var rw = w
      var rh = h
      var start = 0
      while (start < rest.length) {
        if (rw <= 1e-9 || rh <= 1e-9) break
        var side = Math.min(rw, rh)
        var row = [rest[start]]
        var end = start + 1
        while (end < rest.length) {
          var cand = row.concat([rest[end]])
          if (worstRatio(row, side) < worstRatio(cand, side)) break
          row = cand
          end++
        }
        var sum = 0
        for (var q = 0; q < row.length; q++) sum += row[q].a
        if (rw >= rh) {
          var cw = sum / rh
          var cy = ry
          for (var r1 = 0; r1 < row.length; r1++) {
            var hh = row[r1].a / cw
            out.push({ key: row[r1].key, x: rx, y: cy, w: cw, h: hh })
            cy += hh
          }
          rx += cw
          rw -= cw
        } else {
          var ch = sum / rw
          var cx = rx
          for (var r2 = 0; r2 < row.length; r2++) {
            var ww = row[r2].a / ch
            out.push({ key: row[r2].key, x: cx, y: ry, w: ww, h: ch })
            cx += ww
          }
          ry += ch
          rh -= ch
        }
        start = end
      }
      return out
    }

    /** 丝印文字：宽度内放不下就补省略号（与方框同一套 chWidth 口径） */
    function fitLabel(s, maxW, font) {
      s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      if (!s) return ''
      var k = (font || NODE_FONT) / NODE_FONT
      var limit = maxW
      var w = 0
      var out = ''
      for (var i = 0; i < s.length; i++) {
        var cw = chWidth(s[i]) * k
        if (w + cw > limit - chWidth('…') * k) return out ? out + '…' : '…'
        w += cw
        out += s[i]
      }
      return out
    }

    /**
     * 树 → 电路板。
     *   modules = 焦点节点的子节点（有名字的一层）
     *   chips   = 再下一层（方框，无字）
     *   pads    = 再再下一层（圆点，最下级的 node）
     * focus 是空串时看根，也就是「总视图」。
     */
    function boardLayout(root, opts) {
      opts = opts || {}
      var hidden = opts.hidden || {}
      var levels = Math.max(1, Math.min(9, Math.round(opts.levels || 5)))
      // 板子按容器实际像素排（不缩放），字才是字；没给尺寸时退回 1440×900
      var vw = opts.w > 40 ? opts.w : BOARD_W
      var vh = opts.h > 40 ? opts.h : BOARD_H
      // 下钻时沿用上级模块的宽高比：板子只等比放大，内容布局不被压成竖条
      var bw = vw
      var bh = vh
      var asp = opts.aspect > 0 ? opts.aspect : 0
      if (asp > 0) {
        if (vw / vh > asp) {
          bh = vh
          bw = vh * asp
        } else {
          bw = vw
          bh = vw / asp
        }
        bw = Math.max(120, Math.min(vw, bw))
        bh = Math.max(120, Math.min(vh, bh))
      }
      var focus = root
      var path = root ? [root] : []
      if (root && opts.focus) {
        var p = findPath(root, opts.focus)
        if (p) {
          focus = p[p.length - 1]
          path = p
        }
      }
      var out = {
        focus: focus ? focus.tid : '',
        path: path.map(function (n) {
          return { tid: n.tid, title: n.title || n.tid }
        }),
        level: Math.max(0, path.length - 1),
        levels: levels,
        board: { x: 0, y: 0, w: bw, h: bh },
        modules: [],
        pads: [],
        links: [],
        traces: [],
        badges: [],
        total: subtreeCount(focus, hidden),
      }
      if (!focus) return out

      // 递归铺板：每层都按子节点数分面积，模块里继续嵌模块，只有叶子才落成焊盘。
      // 焊盘半径随层级递减（越深越小），模块填充用外框色的淡色块（与边框同色）。
      function walk(parent, rect, depth) {
        if (depth >= levels || rect.w < 12 || rect.h < 12) return
        var kids = boardKids(parent, hidden)
        if (!kids.length) return
        // 整层都是叶子：焊盘贴着模块边缘排一圈（像芯片的引脚），不摆到模块正中
        var leafOnly = kids.length >= 2
        for (var z = 0; z < kids.length && leafOnly; z++) {
          if (boardKids(kids[z], hidden).length) leafOnly = false
        }
        if (leafOnly && rect.w >= 26 && rect.h >= 22) {
          var pr0 = Math.max(1.4, 5.4 - depth * 0.9)
          var inset = pr0 + 3.5
          var x0 = rect.x + inset
          var y0 = rect.y + inset
          var iw = rect.w - inset * 2
          var ih = rect.h - inset * 2
          if (iw > 6 && ih > 6) {
            var per = 2 * (iw + ih)
            var step = per / kids.length
            for (var pi = 0; pi < kids.length; pi++) {
              var sp = step * (pi + 0.5)
              var px
              var py
              if (sp < iw) {
                px = x0 + sp
                py = y0
              } else if (sp < iw + ih) {
                px = x0 + iw
                py = y0 + (sp - iw)
              } else if (sp < iw * 2 + ih) {
                px = x0 + iw - (sp - iw - ih)
                py = y0 + ih
              } else {
                px = x0
                py = y0 + ih - (sp - iw * 2 - ih)
              }
              out.pads.push({
                tid: kids[pi].tid,
                cx: px,
                cy: py,
                r: pr0,
                depth: depth,
                type: kids[pi].type || '',
                more: 0,
              })
            }
            return
          }
        }
        var items = []
        for (var i = 0; i < kids.length; i++) items.push({ key: kids[i].tid, v: subtreeCount(kids[i], hidden) })
        var rects = squarify(items, rect.x, rect.y, rect.w, rect.h)
        var byTid = {}
        for (i = 0; i < kids.length; i++) byTid[kids[i].tid] = kids[i]
        var gap = Math.max(2, MOD_GAP - depth * 3)
        var g = gap / 2
        var placed = []
        for (var r = 0; r < rects.length; r++) {
          var rr = rects[r]
          var node = byTid[rr.key]
          if (!node) continue
          var m = { x: rr.x + g, y: rr.y + g, w: Math.max(1, rr.w - gap), h: Math.max(1, rr.h - gap) }
          if (m.w < 4 || m.h < 4) continue
          var kn = (node.children || []).length
          var count = subtreeCount(node, hidden)
          if (!kn) {
            // 叶子：只画焊盘，不再当模块（倒数第二层也要保持焊盘形态）
            var pr = Math.min(6.5 - depth * 1.1, Math.min(m.w, m.h) * 0.3)
            out.pads.push({
              tid: node.tid,
              cx: m.x + m.w / 2,
              cy: m.y + m.h / 2,
              r: Math.max(1.1, pr),
              depth: depth,
              type: node.type || '',
              more: 0,
            })
            placed.push(m)
            continue
          }
          var fs = Math.max(7.5, 13 - depth * 1.5)
          var labelH = m.w >= 46 && m.h >= 26 ? Math.min(MOD_TITLE_H, fs + 6, m.h - 4) : 0
          out.modules.push({
            tid: node.tid,
            title: node.title || node.tid,
            kind: node.kind || '',
            type: node.type || '',
            x: m.x,
            y: m.y,
            w: m.w,
            h: m.h,
            labelH: labelH,
            fs: fs,
            depth: depth,
            count: count,
            kids: kn,
          })
          // 内缩按模块自身的尺寸收敛：太小的模块（比如只有 38px 高的目录）也要能铺进去
          var pad = Math.max(1.5, Math.min(MOD_PAD - depth * 2, Math.min(m.w, m.h) * 0.06))
          var inner = { x: m.x + pad, y: m.y + labelH + pad * 0.8, w: m.w - pad * 2, h: m.h - labelH - pad * 1.8 }
          if (depth + 1 < levels && inner.w > 14 && inner.h > 10) walk(node, inner, depth + 1)
          else if (m.w >= 34 && m.h >= 18) {
            out.badges.push({ x: m.x + m.w - 5, y: m.y + m.h - 4, text: '+' + count, depth: depth })
          }
          placed.push(m)
        }
        return placed
      }

      walk(focus, { x: BOARD_OUT, y: BOARD_OUT, w: bw - BOARD_OUT * 2, h: bh - BOARD_OUT * 2 }, 0)

      // 排线 = 真链接：横/竖/少量 45° 斜线，同一水平走线不重叠
      var centers = {}
      var tmap = {}
      var i3
      for (i3 = 0; i3 < out.modules.length; i3++) {
        var mm = out.modules[i3]
        tmap[mm.tid] = mm.type
        centers[mm.tid] = { x: mm.x + mm.w / 2, y: mm.y + Math.min(mm.h / 2, mm.labelH ? mm.labelH + 6 : mm.h / 2) }
      }
      for (i3 = 0; i3 < out.pads.length; i3++) {
        var pp = out.pads[i3]
        tmap[pp.tid] = pp.type
        if (!centers[pp.tid]) centers[pp.tid] = { x: pp.cx, y: pp.cy }
      }
      var edges = opts.edges || []
      var laneUsed = []
      function laneFree(y, x1, x2) {
        for (var q = 0; q < laneUsed.length; q++) {
          var u = laneUsed[q]
          if (Math.abs(u.y - y) < 3.5 && !(x2 < u.x1 - 3 || x1 > u.x2 + 3)) return false
        }
        return true
      }
      function takeLane(y, x1, x2) {
        laneUsed.push({ y: y, x1: Math.min(x1, x2), x2: Math.max(x1, x2) })
      }
      // 这一段横线要穿过几个模块内部？越少越好（走模块之间的缝）
      function crossings(y, x1, x2) {
        var c = 0
        var lo = Math.min(x1, x2)
        var hi = Math.max(x1, x2)
        for (var q = 0; q < out.modules.length; q++) {
          var qm = out.modules[q]
          if (y <= qm.y + 1 || y >= qm.y + qm.h - 1) continue
          if (hi < qm.x + 1 || lo > qm.x + qm.w - 1) continue
          c++
        }
        return c
      }
      // 竖着的那两段会不会压到焊盘？
      function padHitsV(x, y1, y2, skipA, skipB) {
        var c = 0
        var lo = Math.min(y1, y2)
        var hi = Math.max(y1, y2)
        for (var q = 0; q < out.pads.length; q++) {
          var qp = out.pads[q]
          if (qp.tid === skipA || qp.tid === skipB) continue
          if (Math.abs(qp.cx - x) > qp.r + 1.6) continue
          if (qp.cy < lo - qp.r - 1 || qp.cy > hi + qp.r + 1) continue
          c++
        }
        return c
      }
      function padHits(y, x1, x2, skipA, skipB) {
        var c = 0
        var lo = Math.min(x1, x2)
        var hi = Math.max(x1, x2)
        for (var q = 0; q < out.pads.length; q++) {
          var qp = out.pads[q]
          if (qp.tid === skipA || qp.tid === skipB) continue
          if (Math.abs(qp.cy - y) > qp.r + 1.6) continue
          if (qp.cx < lo - qp.r - 1 || qp.cx > hi + qp.r + 1) continue
          c++
        }
        return c
      }
      for (i3 = 0; i3 < edges.length && out.links.length < 600; i3++) {
        var e = edges[i3]
        if (!e || e.length < 2) continue
        var a = centers[e[0]]
        var b = centers[e[1]]
        if (!a || !b || (a.x === b.x && a.y === b.y)) continue
        var d = null
        if (Math.abs(a.y - b.y) < 0.8) {
          // 水平：一条横线
          if (laneFree(a.y, a.x, b.x)) {
            d = 'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1) + 'L' + b.x.toFixed(1) + ',' + b.y.toFixed(1)
            takeLane(a.y, a.x, b.x)
          }
        } else if (Math.abs(a.x - b.x) < 0.8) {
          // 垂直：一条竖线
          d = 'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1) + 'L' + b.x.toFixed(1) + ',' + b.y.toFixed(1)
        } else {
          // 竖线出 → 横线走 → 竖线进，两个拐角各切一刀 45° 斜角（不做长斜线横穿板面）
          var sx = b.x > a.x ? 1 : -1
          var base = (a.y + b.y) / 2
          var best = null
          var bestScore = Infinity
          for (var k = 0; k < 13; k++) {
            var off = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 6
            var my = Math.round((base + off) * 2) / 2
            if (Math.abs(my - a.y) < 1 || Math.abs(b.y - my) < 1) continue
            if (laneFree(my, a.x, b.x)) {
              var score =
                crossings(my, a.x, b.x) * 30 +
                (padHits(my, a.x, b.x, e[0], e[1]) +
                  padHitsV(a.x, a.y, my, e[0], e[1]) +
                  padHitsV(b.x, b.y, my, e[0], e[1])) *
                  80 +
                Math.abs(my - base)
              if (score < bestScore) {
                bestScore = score
                best = my
              }
            }
          }
          if (best !== null) {
            var chamfer = 6
            var dya = best - a.y
            var dyb = b.y - best
            var ca = Math.min(chamfer, Math.abs(dya) - 1)
            var cb = Math.min(chamfer, Math.abs(dyb) - 1)
            var sa = dya > 0 ? 1 : -1
            var sb = dyb > 0 ? 1 : -1
            d =
              'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1) +
              'L' + a.x.toFixed(1) + ',' + (best - sa * ca).toFixed(1) +
              'L' + (a.x + sx * ca).toFixed(1) + ',' + best.toFixed(1) +
              'L' + (b.x - sx * cb).toFixed(1) + ',' + best.toFixed(1) +
              'L' + b.x.toFixed(1) + ',' + (best + sb * cb).toFixed(1) +
              'L' + b.x.toFixed(1) + ',' + b.y.toFixed(1)
            takeLane(best, a.x + sx * ca, b.x - sx * cb)
          }
        }
        if (!d) continue
        out.links.push({ d: d, from: e[0], to: e[1], type: tmap[e[0]] || tmap[e[1]] || '' })
      }
      return out
    }

    /** 电路板视图：点击模块 = 下钻（换焦点），点击芯片/焊盘 = 选中 */
    function Board(props) {
      var svgRef = useRef(null)
      var boxState = useState(null) // 容器实际像素（板子就按这个排，避免整块缩放把字缩没）
      var box = boxState[0]
      var setBox = boxState[1]
      var lay = useMemo(
        function () {
          return boardLayout(props.root, {
            focus: props.focus,
            hidden: props.hidden,
            levels: props.levels,
            aspect: props.aspect,
            edges: props.edges,
            w: box ? box.w : 0,
            h: box ? box.h : 0,
          })
        },
        [props.root, props.focus, props.hidden, props.levels, props.aspect, props.edges, box],
      )
      var viewState = useState(null)
      var view = viewState[0]
      var setView = viewState[1]
      var dragRef = useRef(null)
      var panRef = useRef(false) // 本回合拖过：拖完的 pointerup 不该被当成点击
      var hotState = useState('') // 悬停的节点：只把它那几根排线点亮，其余压暗
      var hotTid = hotState[0] || props.sel || ''
      var hotPads = {}
      var padLinked = {} // 有排线连着的焊盘：画实心白点；其余画空心环
      var lkAll = lay.links || []
      if (hotTid) hotPads[hotTid] = 1
      for (var li = 0; li < lkAll.length; li++) {
        padLinked[lkAll[li].from] = 1
        padLinked[lkAll[li].to] = 1
        if (lkAll[li].from === hotTid || lkAll[li].to === hotTid) {
          hotPads[lkAll[li].from] = 1
          hotPads[lkAll[li].to] = 1
        }
      }

      useEffect(function () {
        var el = svgRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return undefined
        function measure() {
          var r = el.getBoundingClientRect()
          if (!r || r.width < 60 || r.height < 60) return
          var w = Math.floor(r.width)
          var h = Math.floor(r.height)
          setBox(function (old) {
            return old && Math.abs(old.w - w) < 2 && Math.abs(old.h - h) < 2 ? old : { w: w, h: h }
          })
        }
        measure()
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        window.addEventListener('resize', measure)
        return function () {
          window.removeEventListener('resize', measure)
        }
      }, [])

      function fitNow() {
        var el = svgRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        var r = el.getBoundingClientRect()
        if (!r.width || !r.height) return
        var k = Math.min(1.2, (r.width - 24) / lay.board.w, (r.height - 24) / lay.board.h)
        if (!isFinite(k) || k <= 0) k = 1
        setView({ k: k, x: (r.width - lay.board.w * k) / 2, y: (r.height - lay.board.h * k) / 2 })
      }

      useEffect(function () {
        fitNow()
      }, [lay, props.fitTick])

      useEffect(function () {
        var el = svgRef.current
        if (!el || typeof el.addEventListener !== 'function') return undefined
        function onWheel(e) {
          e.preventDefault()
          var r = el.getBoundingClientRect()
          var mx = e.clientX - r.left
          var my = e.clientY - r.top
          setView(function (v) {
            if (!v) return v
            var k = Math.max(0.2, Math.min(4, v.k * Math.exp(-e.deltaY * 0.0015)))
            var ratio = k / v.k
            return { k: k, x: mx - (mx - v.x) * ratio, y: my - (my - v.y) * ratio }
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () {
          el.removeEventListener('wheel', onWheel)
        }
      }, [])

      function down(e) {
        var v = view || { k: 1, x: 0, y: 0 }
        dragRef.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }
        panRef.current = false // 按下时还没拖：点击照常生效
        if (e.currentTarget.classList) e.currentTarget.classList.add('drag')
      }
      function move(e) {
        var d = dragRef.current
        if (!d) return
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) panRef.current = true
        setView(function (v) {
          return v ? { k: v.k, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) } : v
        })
      }
      function up(e) {
        dragRef.current = null
        if (e && e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.remove('drag')
        // click 在 pointerup 之后同步触发，所以延后一拍再清，别把这次点击也挡掉
        setTimeout(function () {
          panRef.current = false
        }, 0)
      }

      var t = view || { k: 0.7, x: 0, y: 0 }
      var selTid = props.sel
      var path = lay.path

      var crumbs = h(
        'div',
        { className: 'nkb-crumb' },
        path.map(function (n, i) {
          var last = i === path.length - 1
          return h(
            'span',
            {
              key: n.tid,
              className: 'nkb-crumb-i' + (last ? ' on' : ''),
              title: last ? '当前层级' : '回到 ' + (n.title || n.tid),
              onClick: function () {
                if (last) return
                props.onDrill(i === 0 ? '' : n.tid)
              },
            },
            n.title || n.tid,
          )
        }),
      )

      return h(
        'div',
        { className: 'nkb-gwrap', style: { position: 'absolute', inset: 0 } },
        h(
          'svg',
          { ref: svgRef, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerLeave: up },
          h(
            'g',
            {
              style: {
                transform: 'translate(' + t.x + 'px,' + t.y + 'px) scale(' + t.k + ')',
                transformOrigin: '0 0',
                transition: 'transform .18s ease',
              },
            },
            h('rect', {
              className: 'nkb-bboard',
              x: 0,
              y: 0,
              width: lay.board.w,
              height: lay.board.h,
              rx: 14,
              // 颜色也写成属性：万一 <style> 是旧版本，至少不会全黑
              fill: 'rgba(22,28,32,0.5)',
              stroke: 'rgba(120,170,140,0.45)',
              strokeWidth: 1.2,
            }),
            // 模块底板（点它下钻）：填充用外框色的淡色块，逐层变浅
            lay.modules.map(function (m) {
              var on = selTid === m.tid
              return h(
                'g',
                { key: 'm' + m.tid, className: 'nkb-bmod' + (on ? ' sel' : '') },
                h('rect', {
                  x: m.x,
                  y: m.y,
                  width: m.w,
                  height: m.h,
                  rx: m.depth ? 5 : 8,
                  fill: typeFill(m.type, on ? 0.28 : m.depth ? 0.09 : 0.15),
                  stroke: typeColor(m.type),
                  strokeWidth: m.depth ? 0.9 : 1.25,
                  onMouseEnter: function () {
                    hotState[1](m.tid)
                  },
                  onMouseLeave: function () {
                    hotState[1]('')
                  },
                  onClick: function (e) {
                    e.stopPropagation()
                    if (panRef.current) return
                    props.onDrill(m.tid, m.w, m.h)
                  },
                }),
                h('title', null, m.tid + ' · ' + m.count + ' 个节点 · 点击下钻'),
              )
            }),
            // 语义排线：真引用才连线（两端都在板上）；颜色跟焊盘所在模块一致
            (lay.links || []).map(function (lk, i) {
              var hot = hotTid && (lk.from === hotTid || lk.to === hotTid)
              return h('path', {
                key: 'k' + i,
                className: 'nkb-btrace link' + (hot ? ' hot' : ''),
                d: lk.d,
                fill: 'none',
                stroke: hot ? 'rgba(96,170,255,0.95)' : typeFill(lk.type || '', 1),
                strokeWidth: hot ? 1.7 : 1,
                strokeLinejoin: 'round',
                opacity: hot ? 1 : hotTid ? 0.22 : 0.9,
              })
            }),
            // 焊盘：只表示没有子节点的节点，用亮白
            lay.pads.map(function (p) {
              return h(
                'g',
                {
                  key: 'p' + p.tid,
                  className: 'nkb-bpad' + (selTid === p.tid ? ' sel' : ''),
                  onMouseEnter: function () {
                    hotState[1](p.tid)
                  },
                  onMouseLeave: function () {
                    hotState[1]('')
                  },
                  onClick: function (e) {
                    e.stopPropagation()
                    if (panRef.current) return
                    props.onSelect(p.tid)
                  },
                  onDoubleClick: p.more
                    ? function (e) {
                        e.stopPropagation()
                        if (panRef.current) return
                        props.onDrill(p.tid)
                      }
                    : undefined,
                },
                h('circle', {
                  cx: p.cx,
                  cy: p.cy,
                  r: p.r,
                  // 默认空心白环；被排线连到 / 被选中 → 实心白点；悬停或它的对端 → 蓝色实心
                  fill:
                    selTid === p.tid || hotPads[p.tid]
                      ? 'rgba(96,170,255,1)'
                      : padLinked[p.tid]
                        ? 'rgba(255,255,255,0.95)'
                        : 'none',
                  stroke:
                    selTid === p.tid || hotPads[p.tid]
                      ? 'rgba(96,170,255,1)'
                      : 'rgba(255,255,255,0.95)',
                  strokeWidth: selTid === p.tid || hotPads[p.tid] || padLinked[p.tid] ? 0.6 : 1.2,
                }),
                selTid === p.tid || hotPads[p.tid]
                  ? h('circle', {
                      className: 'nkb-bhalo',
                      cx: p.cx,
                      cy: p.cy,
                      r: p.r + 2.4,
                      fill: 'none',
                      stroke: 'rgba(96,170,255,0.85)',
                      strokeWidth: 1,
                    })
                  : null,
                p.more
                  ? h('circle', {
                      className: 'ring',
                      cx: p.cx,
                      cy: p.cy,
                      r: p.r + 1.6,
                      fill: 'none',
                      stroke: 'rgba(255,255,255,0.35)',
                      strokeWidth: 1,
                    })
                  : null,
                h('title', null, p.tid + (p.more ? ' · 双击下钻' : '')),
              )
            }),
            lay.badges.map(function (b, i) {
              return h(
                'text',
                { key: 'bd' + i, className: 'nkb-bbadge', x: b.x, y: b.y, textAnchor: 'end', fill: 'currentColor', opacity: 0.45, fontSize: 9 },
                b.text,
              )
            }),
            // 丝印：每一层都只标自己这一层，字号随层级缩小
            lay.modules.map(function (m) {
              if (!m.labelH) return null
              var fs = m.fs
              var txt = fitLabel(m.title, m.w - 12, fs)
              if (!txt) return null
              var ty = m.y + Math.min(m.labelH - 2.5, fs + 1)
              return h(
                'g',
                { key: 'l' + m.tid, className: 'nkb-blab' },
                h('text', { x: m.x + 6, y: ty, fontSize: fs, fill: 'currentColor', opacity: 0.92 }, txt),
                m.w >= 96 && m.h >= 40
                  ? h(
                      'text',
                      { className: 'cnt', x: m.x + m.w - 6, y: ty, fontSize: 9.5, textAnchor: 'end', fill: 'currentColor', opacity: 0.42 },
                      m.count,
                    )
                  : null,
              )
            }),
          ),
        ),
        crumbs,
        h(
          'div',
          { className: 'nkb-gbar' },
          h('button', { onClick: function () { props.onDrill('') }, title: '回到总视图' }, '总览'),
          h('button', { onClick: props.onUp, title: '返回上一级（Esc）' }, '↑'),
          h('button', { onClick: function () { setView(function (v) { return v ? { k: Math.min(4, v.k * 1.25), x: v.x, y: v.y } : v }) }, title: '放大' }, '+'),
          h('button', { onClick: function () { setView(function (v) { return v ? { k: Math.max(0.2, v.k / 1.25), x: v.x, y: v.y } : v }) }, title: '缩小' }, '−'),
          h('button', { onClick: fitNow, title: '适应视图' }, '适应'),
          h('span', { className: 'nkb-muted', style: { padding: '2px 6px', fontSize: 11 } }, Math.round((t.k || 1) * 100) + '%'),
        ),
      )
    }

    function Graph(props) {
      var lay = useMemo(
        function () {
          return layoutGraph(props.root, {
            dir: props.dir,
            maxDepth: props.maxDepth,
            hidden: props.hidden,
            collapsed: props.collapsed,
          })
        },
        [props.root, props.dir, props.maxDepth, props.hidden, props.collapsed],
      )
      var viewState = useState(null)
      var view = viewState[0]
      var setView = viewState[1]
      var svgRef = useRef(null)
      var dragRef = useRef(null)
      var layoutKey =
        props.dir + '|' + props.maxDepth + '|' + Object.keys(props.hidden || {}).length + '|' + Object.keys(props.collapsed || {}).length

      function fitNow() {
        var el = svgRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        var r = el.getBoundingClientRect()
        if (!r.width || !r.height) return
        var k = Math.min(1.1, (r.width - 56) / lay.width, (r.height - 56) / lay.height)
        if (!isFinite(k) || k <= 0) k = 1
        setView({
          k: k,
          x: (r.width - lay.width * k) / 2 - lay.minX * k,
          y: (r.height - lay.height * k) / 2 - lay.minY * k,
        })
      }

      useEffect(function () {
        fitNow()
      }, [layoutKey, props.fitTick, lay])

      useEffect(function () {
        var el = svgRef.current
        if (!el || typeof el.addEventListener !== 'function') return undefined
        function onWheel(e) {
          e.preventDefault()
          var r = el.getBoundingClientRect()
          var mx = e.clientX - r.left
          var my = e.clientY - r.top
          setView(function (v) {
            if (!v) return v
            var k = Math.max(0.15, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0015)))
            var ratio = k / v.k
            return { k: k, x: mx - (mx - v.x) * ratio, y: my - (my - v.y) * ratio }
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () {
          el.removeEventListener('wheel', onWheel)
        }
      }, [])

      function down(e) {
        var v = view || { k: 1, x: 0, y: 0 }
        dragRef.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false }
        if (e.currentTarget.classList) e.currentTarget.classList.add('drag')
      }
      function move(e) {
        var d = dragRef.current
        if (!d) return
        var dx = e.clientX - d.x
        var dy = e.clientY - d.y
        if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
        setView(function (v) {
          return v ? { k: v.k, x: d.vx + dx, y: d.vy + dy } : v
        })
      }
      function up(e) {
        dragRef.current = null
        if (e && e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.remove('drag')
      }

      var t = view || { k: 1, x: 0, y: 0 }
      var tb = lay.tb

      return h(
        'div',
        { className: 'nkb-gwrap', style: { position: 'absolute', inset: 0 } },
        h(
          'svg',
          { ref: svgRef, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerLeave: up },
          h(
            'g',
            { transform: 'translate(' + t.x + ',' + t.y + ') scale(' + t.k + ')' },
            lay.edges.map(function (e, i) {
              var on = props.sel === e.from.tid || props.sel === e.to.tid
              return h('path', { key: 'e' + i, className: 'nkb-edge' + (on ? ' on' : ''), d: edgePath(e.from, e.to, tb) })
            }),
            lay.items.map(function (it) {
              var cls = 'nkb-node' + (props.sel === it.tid ? ' sel' : '') + (it.node.kind === 'folder' ? ' folder' : '')
              return h(
                'g',
                {
                  key: it.tid,
                  className: cls,
                  transform: 'translate(' + it.x + ',' + it.y + ')',
                  onClick: function (e) {
                    e.stopPropagation()
                    props.onSelect(it.tid)
                  },
                  onDoubleClick: function (e) {
                    e.stopPropagation()
                    props.onToggleCollapse(it.tid)
                  },
                },
                h('rect', { width: NODE_W, height: it.h, rx: 6, stroke: typeColor(it.node.type), strokeWidth: 1.4 }),
                h(
                  'text',
                  { x: NODE_PAD_X },
                  (function (lines) {
                    var blockH = lines.length * NODE_LINE_H
                    var top = (it.h - blockH) / 2
                    return lines.map(function (ln, li) {
                      return h('tspan', { key: 'l' + li, x: NODE_PAD_X, y: top + li * NODE_LINE_H + NODE_LINE_H - 3 }, ln)
                    })
                  })(it.lines || graphTitleLines(it.node.title || it.tid).lines),
                ),
                h('title', null, (it.node.title || it.tid) + '\n' + it.tid + '\n' + (it.node.type || '') + ' · ' + (it.node.chars || 0) + ' 字符'),
              )
            }),
          ),
        ),
        h(
          'div',
          { className: 'nkb-gbar' },
          h('button', { onClick: function () { setView(function (v) { return v ? { k: Math.min(3, v.k * 1.25), x: v.x, y: v.y } : v }) }, title: '放大' }, '+'),
          h('button', { onClick: function () { setView(function (v) { return v ? { k: Math.max(0.15, v.k / 1.25), x: v.x, y: v.y } : v }) }, title: '缩小' }, '−'),
          h('button', { onClick: fitNow, title: '适应视图' }, '适应'),
          h('span', { className: 'nkb-muted', style: { padding: '2px 6px', fontSize: 11 } }, Math.round((t.k || 1) * 100) + '%'),
        ),
      )
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function Panel() {
      ensureStyle()

      var libsState = useState([])
      var libs = libsState[0]
      var setLibs = libsState[1]

      // 全局注册表里的库（不在当前工作区内），与 libs 分组显示
      var otherState = useState([])
      var otherLibs = otherState[0]
      var setOtherLibs = otherState[1]

      var kbState = useState('')
      var kb = kbState[0]
      var setKb = kbState[1]

      var treeState = useState(null)
      var tree = treeState[0]
      var setTree = treeState[1]

      var selState = useState('root')
      var sel = selState[0]
      var setSel = selState[1]

      var modeState = useState('subtree')
      var mode = modeState[0]
      var setMode = modeState[1]

      var viewState = useState('subtree')
      var view = viewState[0]
      var setView = viewState[1]

      var nodeState = useState(null)
      var nodeData = nodeState[0]
      var setNodeData = nodeState[1]

      var srcState = useState(null)
      var src = srcState[0]
      var setSrc = srcState[1]

      var errState = useState('')
      var err = errState[0]
      var setErr = errState[1]

      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var qState = useState('')
      var query = qState[0]
      var setQuery = qState[1]

      var hitsState = useState(null)
      var hits = hitsState[0]
      var setHits = hitsState[1]

      // 已提交的检索词（高亮用）与「跳到命中」的触发计数（点不同条目也重新滚动）
      var qUsedState = useState('')
      var qUsed = qUsedState[0]
      var setQUsed = qUsedState[1]
      var focusState = useState(0)
      var focus = focusState[0]
      var setFocus = focusState[1]
      var hlTermsNow = useMemo(function () { return hlTerms(qUsed) }, [qUsed])

      var backState = useState(null)
      var back = backState[0]
      var setBack = backState[1]

      var diagState = useState(null)
      var diagData = diagState[0]
      var setDiag = diagState[1]

      var expState = useState({})
      var expanded = expState[0]
      var setExpanded = expState[1]

      // 节点图：布局方向 / 展开层数 / 被隐藏的类型 / 手动折叠的节点 / 重排计数
      // 默认走电路板：整齐树在宽而扁的库上会缩成一根竖条（1.5.19 起换默认）
      var gdirState = useState('PCB')
      var gdir = gdirState[0]
      var setGdir = gdirState[1]
      var bfocusState = useState('')
      var bfocus = bfocusState[0]
      var setBfocus = bfocusState[1]
      // 电路板：最多显示层数（默认 5）与下钻时沿用的宽高比
      var blevelState = useState(5)
      var blevel = blevelState[0]
      var setBlevel = blevelState[1]
      var baspState = useState(0)
      var basp = baspState[0]
      var setBasp = baspState[1]
      var aspStackRef = useRef([])
      var gdepthState = useState(3)
      var gdepth = gdepthState[0]
      var setGdepth = gdepthState[1]
      var ghideState = useState({})
      var ghide = ghideState[0]
      var setGhide = ghideState[1]
      var gcollState = useState({})
      var gcoll = gcollState[0]
      var setGcoll = gcollState[1]
      var fitState = useState(0)
      var fitTick = fitState[0]
      var setFitTick = fitState[1]

      // DSH 自己的 workspace 列表（宿主 /workspaces 给）：面板没有会话上下文，
      // 但「这个 DSH 用过哪些项目目录」宿主知道，不用让人手打路径。
      var wsState = useState([])
      var wsList = wsState[0]
      var setWsList = wsState[1]

      // 左栏容器（选中时把对应行滚进视野，画布与左栏双向同步用）
      var treeBoxRef = useRef(null)

      var toggle = useCallback(function (tid) {
        setExpanded(function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[tid] = prev[tid] === false
          return next
        })
      }, [])

      // 库列表：分两组
      //   mine  = 当前工作区里的库（/libs?scope=workspace，只含真的在这个目录下的）
      //   other = 全局注册表里登记的库（路径不在本工作区内，且必须真的存在）
      // 「t（路径不存在）」这类失效注册项直接不进下拉。
      var loadLibs = useCallback(function () {
        return Promise.all([get('/libs', { scope: 'workspace' }), get('/libs')])
          .then(function (rs) {
            var mine = (rs[0] && rs[0].libs) || []
            var all = (rs[1] && rs[1].libs) || []
            var seen = {}
            for (var i = 0; i < mine.length; i++) seen[mine[i].name + '|' + mine[i].path] = 1
            var other = []
            for (var j = 0; j < all.length; j++) {
              var l = all[j]
              if (!l.exists) continue
              if (seen[l.name + '|' + l.path]) continue
              other.push(l)
            }
            setLibs(mine)
            setOtherLibs(other)
            var pick = null
            for (var a = 0; a < mine.length; a++) {
              if (mine[a].exists) { pick = mine[a].name; break }
            }
            if (!pick) {
              for (var b = 0; b < all.length; b++) { if (all[b].exists) { pick = all[b].name; break } }
            }
            setKb(pick || '')
            if (!mine.length && !other.length) {
              setErr('这个工作区里没找到 .nodekb 库。换一个目录（右上「目录」），或在项目里建 .nodekb/ 放 md 文件；放在 .dsh/skills/<技能>/.nodekb/ 也会被自动发现。')
            } else {
              setErr('')
            }
          })
          .catch(function (e) { setErr(e.message) })
      }, [])

      var loadWs = useCallback(function () {
        return get('/workspaces')
          .then(function (r) {
            var rows = r.workspaces || []
            setWsList(rows)
            return rows
          })
          .catch(function () { return [] })
      }, [])

      // 首次挂载：没手动指定过工作区时，从 DSH 的 workspace 列表里挑一个真的
      // 有 .nodekb 的目录（优先），这样面板打开就能看到东西。
      useEffect(function () {
        if (WS) {
          loadWs()
          loadLibs()
          return
        }
        loadWs().then(function (rows) {
          var cand = null
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].nodekb) { cand = rows[i]; break }
          }
          if (cand) {
            writeWs(cand.path)
            setKb('')
            setTree(null)
            setHits(null)
            setSel('root')
          }
          loadLibs()
        })
      }, [])

      /** 选一个工作区（来自 DSH workspace 列表或手打路径） */
      function useWs(dir) {
        writeWs(String(dir || '').trim())
        setKb('')
        setTree(null)
        setHits(null)
        setSel('root')
        loadLibs()
      }

      /** 换工作区：面板没有会话上下文，只能由人指定一次，记在 localStorage */
      function pickWs() {
        if (!g.prompt) return
        var v = g.prompt('nodekb 工作区目录（留空 = 插件进程当前目录）', WS || '')
        if (v === null || v === undefined) return
        useWs(v)
      }

      // 树
      var loadTree = useCallback(function (name) {
        setTree(null)
        setHits(null)
        return get('/tree', { kb: name })
          .then(function (r) { setTree(r); setErr('') })
          .catch(function (e) { setErr(e.message); setTree({ name: name || '?', tree: null, nodeCount: 0 }) })
      }, [])

      useEffect(function () {
        if (!kb && !libs.length) return
        loadTree(kb).then(function () {
          if (!kb) {
            // 没有任何库时也别静默
            setErr('没有可用的 nodekb 库。在工作区建 .nodekb/ 放 md 文件，或在插件配置里登记库。')
          }
        })
      }, [kb, libs.length])

      // 节点正文
      useEffect(function () {
        if (!kb || !sel) return
        setBusy(true)
        var m = view === 'toc' ? 'subtree' : view
        get('/node', { kb: kb, tid: sel, mode: m })
          .then(function (r) { setNodeData(r); setErr('') })
          .catch(function (e) { setErr(e.message); setNodeData(null) })
          .then(function () { setBusy(false) })
      }, [kb, sel, view])

      // 源码
      useEffect(function () {
        setSrc(null)
        if (view !== 'source' || !kb || !sel) return
        get('/source', { kb: kb, tid: sel })
          .then(function (r) { setSrc(r) })
          .catch(function (e) { setSrc({ error: e.message }) })
      }, [view, kb, sel])

      // 反向链接
      useEffect(function () {
        setBack(null)
        if (!kb || !sel) return
        get('/backlinks', { kb: kb, tid: sel })
          .then(function (r) { setBack(r.backlinks || []) })
          .catch(function () { setBack([]) })
      }, [kb, sel, nodeData && nodeData.title])

      /** 展开到某个节点（祖先若被手动折叠过就重新打开） */
      function expandTo(tid) {
        if (!treeNode) return
        var p = findPath(treeNode, tid)
        if (!p || !p.length) return
        setExpanded(function (prev) {
          var next = null
          for (var i = 0; i < p.length; i++) {
            if (prev[p[i].tid] === false) {
              if (!next) {
                next = {}
                for (var k in prev) next[k] = prev[k]
              }
              next[p[i].tid] = true
            }
          }
          return next || prev
        })
      }

      /** 电路板定位（左栏 → 画布）：有子节点就直接钻进去，叶子则聚焦它的父节点 */
      function boardLocate(tid) {
        if (gdir !== 'PCB' || !treeNode) return
        var node = findPath(treeNode, tid)
        var self = node && node.length ? node[node.length - 1] : null
        // 从左栏跳过去不沿用上一级的宽高比（那是"放大"的语义，跳转不是）
        aspStackRef.current = []
        setBasp(0)
        if (treeNode && tid === treeNode.tid) {
          setBfocus('')
          return
        }
        if (self && self.children && self.children.length) {
          setBfocus(tid)
          return
        }
        if (!node || node.length < 2) {
          setBfocus('')
          return
        }
        var parent = node[node.length - 2]
        setBfocus(parent.tid === treeNode.tid ? '' : parent.tid)
      }

      /** 左栏/正文里点节点：选中 + 展开 + 电路板跟着定位（双向同步的左→右） */
      function open(tid) {
        setSel(tid)
        setView('subtree')
        setHits(null)
        setQuery('')
        expandTo(tid)
        boardLocate(tid)
      }

      /** 电路板下钻 / 返回（画布 → 左栏）；w/h 是刚点开的模块尺寸，用来保住板子的宽高比 */
      function drillBoard(tid, w, h) {
        if (!tid) {
          aspStackRef.current = []
          setBasp(0)
          setBfocus('')
          setSel((treeNode && treeNode.tid) || 'root')
          return
        }
        if (w > 4 && h > 4) {
          aspStackRef.current.push(basp)
          setBasp(w / h)
        }
        setBfocus(tid)
        setSel(tid)
        expandTo(tid)
      }
      function boardUp() {
        if (!bfocus) return
        var stack = aspStackRef.current
        setBasp(stack.length ? stack.pop() : 0)
        var p = findPath(treeNode, bfocus)
        if (!p || p.length < 2) {
          setBfocus('')
          return
        }
        var up = p[p.length - 2]
        setBfocus(up.tid === (treeNode && treeNode.tid) ? '' : up.tid)
        setSel(up.tid)
      }

      // 左栏跟随选中：展开到该节点并把那一行滚进视野（画布点击 → 左栏定位）
      useEffect(function () {
        var box = treeBoxRef.current
        if (!box || !sel) return
        var el = box.querySelector('[data-tid="' + String(sel).replace(/"/g, '\\"') + '"]')
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [sel, treeNode, expanded])

      // Esc = 电路板返回上一级
      useEffect(function () {
        if (typeof document === 'undefined' || !document.addEventListener) return undefined
        function onKey(e) {
          if (e.key !== 'Escape' || gdir !== 'PCB' || !bfocus) return
          boardUp()
        }
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('keydown', onKey)
        }
      }, [gdir, bfocus, treeNode])

      /** 点开一个 [[tscl="id"]]：跳到定义所在的节点（值就在那一段话里）；检索态不退出 */
      function openDef(id) {
        if (!kb || !id) return
        get('/defs', { kb: kb, id: id })
          .then(function (r) {
            if (!r || !r.owner_tid) { setErr('未找到定义: ' + id); return }
            setErr('')
            setSel(r.owner_tid)
            setView('node')
            setFocus(function (n) { return n + 1 })
          })
          .catch(function (e) { setErr(e.message) })
      }

      /** 退出检索：只有「×」和 Esc 走这里（点命中条目只换预览，不退出） */
      function exitSearch() {
        setQuery('')
        setQUsed('')
        setHits(null)
      }

      /** 点检索命中：换预览 + 滚到命中处，检索列表保留，可继续点其它条目 */
      function openHit(tid) {
        setSel(tid)
        setFocus(function (n) { return n + 1 })
        if (view === 'toc') setView('subtree')
      }

      function runSearch() {
        var q = (query || '').trim()
        if (!q) { exitSearch(); return }
        setBusy(true)
        get('/search', { kb: kb, q: q, limit: 30 })
          .then(function (r) { setHits(r); setQUsed(q); setErr('') })
          .catch(function (e) { setErr(e.message) })
          .then(function () { setBusy(false) })
      }

      function runDiag() {
        setBusy(true)
        get('/diag', { kb: kb })
          .then(function (r) { setDiag(r); setErr('') })
          .catch(function (e) { setErr(e.message) })
          .then(function () { setBusy(false) })
      }

      // 检索态下 Esc 也能退出（点过命中条目后焦点已不在输入框里）
      useEffect(function () {
        if (!hits) return undefined
        function onKey(e) {
          if (e.key === 'Escape') {
            setQuery('')
            setQUsed('')
            setHits(null)
          }
        }
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('keydown', onKey)
        return function () {
          if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('keydown', onKey)
        }
      }, [hits])

      /** 改文件名：TID 由文件名派生，所以引用要一起搬（走 /rename，不自己拼） */
      function rename() {
        if (!g.prompt || !info || info.kind !== 'file') return
        var v = g.prompt('新文件名（.md 可省略；全库引用会一起改写）', (info.title || '') + '.md')
        if (v === null || v === undefined) return
        var name = String(v).trim()
        if (!name) return
        setBusy(true)
        post('/rename', { kb: kb }, { target: info.tid, new_name: name })
          .then(function (r) {
            setErr('')
            setDiag({ errors: [], warnings: [], rename: r.text || '' })
            setSel(r.new_tid || r.newTid || info.tid)
            return loadTree(kb)
          })
          .catch(function (e) { setErr(e.message) })
          .then(function () { setBusy(false) })
      }

      var text = ''
      if (view === 'source' && src) {
        text = src.error ? '' : (src.lines || []).map(function (l) { return l.number + '\t' + l.text }).join('\n')
      } else if (nodeData) {
        text = nodeData.text || ''
      }
      // 面板单次最多渲染 1 万字符：再长就只显示开头，正文与滚动条都不至于卡死
      var TEXT_LIMIT = 10000
      var textCut = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : ''
      var shownText = textCut ? textCut : text

      var treeNode = tree && tree.tree
      var info = nodeData || null

      var head = h(
        'div',
        { className: 'nkb-head' },
        h('span', { className: 'nkb-title' }, '项目节点知识库'),
        h(
          'select',
          {
            value: kb,
            onChange: function (e) { setKb(e.target.value); setSel('root'); setView('subtree') },
            title: '切换知识库',
          },
          libs.length || otherLibs.length
            ? [
                libs.length
                  ? h('optgroup', { key: 'ws', label: '当前工作区' }, libs.map(function (l) {
                      return h('option', { key: 'w-' + l.name, value: l.name }, l.name + (l.exists ? '' : '（路径不存在）'))
                    }))
                  : null,
                otherLibs.length
                  ? h('optgroup', { key: 'reg', label: '全局注册' }, otherLibs.map(function (l) {
                      return h('option', { key: 'r-' + l.name, value: l.name }, l.name + ' — ' + l.path)
                    }))
                  : null,
              ]
            : h('option', { value: '' }, '（无库）'),
        ),
        tree && typeof tree.nodeCount === 'number' ? h('span', { className: 'nkb-muted' }, tree.nodeCount + ' 节点') : null,
        h(
          'span',
          { className: 'nkb-qbox' },
          h('input', {
            value: query,
            placeholder: '检索（中文自然语言可用）',
            'aria-label': '检索知识库',
            onChange: function (e) { setQuery(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter') runSearch()
              else if (e.key === 'Escape') { if (hits || query) exitSearch() }
            },
          }),
          query || hits
            ? h('button', { className: 'nkb-qclear', title: '退出检索（Esc）', onClick: exitSearch }, '×')
            : null,
        ),
        h(
          'select',
          {
            value: WS,
            onChange: function (e) { useWs(e.target.value) },
            title: '切换工作区（DSH 里用过的项目目录）',
            style: { maxWidth: 220 },
          },
          h('option', { value: '' }, '（默认目录）'),
          wsList
            .filter(function (w) { return w.nodekb })
            .map(function (w) {
              return h('option', { key: w.id || w.path, value: w.path }, (w.title || w.path) + '（' + (w.libs || 0) + ' 个库）')
            }),
          WS && !wsList.some(function (w) { return w.path === WS && w.nodekb }) ? h('option', { key: 'manual', value: WS }, WS + '（当前）') : null,
        ),
        h('button', { onClick: runSearch, disabled: busy }, '搜索'),
        h('button', { onClick: runDiag, disabled: busy }, '诊断'),
        h('button', { onClick: function () { loadTree(kb) }, disabled: busy }, '刷新'),
        h('button', { onClick: pickWs, title: '指定工作区目录（面板拿不到会话上下文）' }, '目录'),
        busy ? h('span', { className: 'nkb-muted' }, '…') : null,
      )

      // 图设置：布局方向、展开层数、类型筛选（点一下隐藏该类型）
      var typeStats = useMemo(function () {
        return treeNode ? collectTypes(treeNode) : {}
      }, [treeNode])
      var typeNames = Object.keys(typeStats).sort()

      var settings = h(
        'div',
        { className: 'nkb-settings' },
        h('div', { className: 'lbl' }, '布局'),
        h(
          'div',
          null,
          h('span', { className: 'nkb-chip' + (gdir === 'PCB' ? ' on' : ''), onClick: function () { setGdir('PCB'); setFitTick(fitTick + 1) } }, '电路板'),
          h('span', { className: 'nkb-chip' + (gdir === 'TB' ? ' on' : ''), onClick: function () { setGdir('TB'); setFitTick(fitTick + 1) } }, '上下'),
          h('span', { className: 'nkb-chip' + (gdir === 'LR' ? ' on' : ''), onClick: function () { setGdir('LR'); setFitTick(fitTick + 1) } }, '左右'),
        ),
        gdir === 'PCB'
          ? h('div', { className: 'nkb-muted', style: { marginTop: 6, fontSize: 11 } }, '点模块下钻 · Esc 返回上级 · 模块面积 = 节点数占比')
          : h('div', { className: 'lbl' }, '展开层数'),
        gdir === 'PCB'
          ? h(
              'div',
              null,
              h('span', { className: 'nkb-muted', style: { fontSize: 11, marginRight: 4 } }, '层数'),
              [2, 3, 4, 5, 6, 8].map(function (d) {
                return h(
                  'span',
                  {
                    key: d,
                    className: 'nkb-chip' + (blevel === d ? ' on' : ''),
                    title: '最多显示 ' + d + ' 层',
                    onClick: function () {
                      setBlevel(d)
                      setFitTick(fitTick + 1)
                    },
                  },
                  String(d),
                )
              }),
            )
          : h(
              'select',
              {
                value: String(gdepth),
                style: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, padding: '2px 6px' },
                onChange: function (e) { setGdepth(Number(e.target.value)); setFitTick(fitTick + 1) },
              },
              [2, 3, 4, 6, 99].map(function (d) {
                return h('option', { key: d, value: String(d) }, d >= 99 ? '全部' : d + ' 层')
              }),
            ),
        h('div', { className: 'lbl' }, '类型（点一下隐藏）'),
        h(
          'div',
          null,
          typeNames.length
            ? typeNames.map(function (t) {
                return h(
                  'span',
                  {
                    key: t,
                    className: 'nkb-chip' + (ghide[t] ? '' : ' on'),
                    style: { borderColor: typeColor(t) },
                    title: typeStats[t] + ' 个节点',
                    onClick: function () {
                      setGhide(function (prev) {
                        var next = {}
                        for (var k in prev) next[k] = prev[k]
                        next[t] = !prev[t]
                        return next
                      })
                      setFitTick(fitTick + 1)
                    },
                  },
                  t + ' ' + typeStats[t],
                )
              })
            : h('span', { className: 'nkb-muted' }, '（无）'),
        ),
        h('div', { className: 'lbl' }, '操作'),
        h(
          'div',
          { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
          h('button', { onClick: function () { setGcoll({}); setFitTick(fitTick + 1) } }, '全部展开'),
          h('button', { onClick: function () { setGhide({}) } }, '显示全部类型'),
          h('button', { onClick: function () { setFitTick(fitTick + 1) } }, '适应视图'),
        ),
        h('div', { className: 'nkb-muted', style: { marginTop: 6, fontSize: 11 } }, '滚轮缩放 · 拖动平移 · 双击节点折叠'),
      )

      var left = h(
        'aside',
        { className: 'nkb-left' },
        h(
          'div',
          { className: 'nkb-tree', ref: treeBoxRef },
          hits
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'nkb-muted', style: { padding: '2px 6px 6px' } },
                  '命中 ' + hits.count + ' / ' + hits.total + ' 条 · 点条目预览，× 退出',
                ),
                (hits.hits || []).map(function (hit, i) {
                  return h(
                    'div',
                    {
                      key: hit.tid + '#' + i,
                      className: 'nkb-hit' + (hit.tid === sel ? ' on' : ''),
                      onClick: function () { openHit(hit.tid) },
                      title: '在右侧预览并滚到命中处（检索不退出）',
                    },
                    h('div', { className: 'tt' }, hlNodes(String(hit.title || hit.tid), hlTermsNow, 'tt' + i)),
                    h('div', { className: 'nkb-muted' }, hit.tid + ' · ' + hit.type),
                    h('div', { className: 'sn' }, hlNodes(String(hit.snippet || ''), hlTermsNow, 'sn' + i)),
                  )
                }),
              )
            : treeNode
              ? h(TreeRow, { node: treeNode, onSelect: open, sel: sel, expanded: expanded, toggle: toggle, depth: 0 })
              : h('div', { className: 'nkb-muted', style: { padding: 8 } }, tree ? '（空库）' : '载入中…'),
        ),
        settings,
      )

      var tabs = h(
        'div',
        { className: 'nkb-tabs' },
        [['subtree', '整支'], ['node', '本节点'], ['raw', '原文'], ['source', '源码']].map(function (pair) {
          return h(
            'button',
            { key: pair[0], className: view === pair[0] ? 'on' : '', onClick: function () { setView(pair[0]) } },
            pair[1],
          )
        }),
        info ? h('span', { className: 'nkb-muted', style: { marginLeft: 'auto', paddingRight: 4 } }, (info.section || info.type) + ' · ' + text.length + ' 字符') : null,
      )

      var body = diagData
        ? h(
            'div',
            { className: 'nkb-diag' },
            h('div', null, '诊断：' + (diagData.errors && diagData.errors.length ? diagData.errors.length + ' 错误' : '无错误') + ' · ' + (diagData.warnings && diagData.warnings.length ? diagData.warnings.length + ' 告警' : '无告警') + (diagData.advice && diagData.advice.length ? ' · ' + diagData.advice.length + ' 建议' : '')),
            ...(diagData.errors || []).map(function (t, i) { return h('div', { key: 'e' + i }, '✗ ' + t) }),
            ...(diagData.warnings || []).map(function (t, i) { return h('div', { key: 'w' + i, className: 'nkb-muted' }, '! ' + t) }),
            ...(diagData.advice || []).map(function (t, i) { return h('div', { key: 'a' + i, className: 'nkb-muted' }, '› ' + t) }),
            diagData.rename ? h('pre', { style: { whiteSpace: 'pre-wrap', margin: '8px 0 0' } }, diagData.rename) : null,
            h('div', { style: { marginTop: 8 } }, h('button', { onClick: function () { setDiag(null) } }, '关闭')),
          )
        : err
          ? h(
              'div',
              { className: 'nkb-diag nkb-err' },
              h('div', null, err),
              wsList.filter(function (w) { return w.nodekb }).length
                ? h(
                    'div',
                    { style: { marginTop: 10 } },
                    h('div', { className: 'nkb-muted' }, '选一个有 .nodekb 的 DSH 项目目录：'),
                    wsList.filter(function (w) { return w.nodekb }).map(function (w) {
                      return h(
                        'div',
                        { key: w.id || w.path, style: { marginTop: 6 } },
                        h('button', { onClick: function () { useWs(w.path) } }, (w.title || w.path) + ' · ' + (w.libs || 0) + ' 个库'),
                        h('span', { className: 'nkb-muted', style: { marginLeft: 8 } }, w.path),
                      )
                    }),
                  )
                : null,
            )
          : view === 'raw' || view === 'source' || view === 'toc'
            ? h(Rich, { text: shownText, onOpen: open, onMacro: openDef, terms: hlTermsNow, focus: focus })
            : h(Md, { text: shownText, onOpen: open, terms: hlTermsNow, focus: focus })
      var cutNotice = textCut
        ? h(
            'div',
            { className: 'nkb-cut' },
            '已显示前 ' + TEXT_LIMIT.toLocaleString() + ' 字符（全文 ' + text.length.toLocaleString() + ' 字符）；需要完整内容请用 kb_read 的 maxlen / mode=node',
          )
        : null

      var center = h(
        'section',
        { className: 'nkb-main' },
        treeNode
          ? gdir === 'PCB'
            ? h(Board, {
                root: treeNode,
                sel: sel,
                focus: bfocus,
                hidden: ghide,
                levels: blevel,
                aspect: basp,
                edges: (tree && tree.edges) || [],
                fitTick: fitTick,
                onDrill: drillBoard,
                onUp: boardUp,
                onSelect: open,
              })
            : h(Graph, {
                root: treeNode,
                sel: sel,
                onSelect: open,
                dir: gdir,
                maxDepth: gdepth,
                hidden: ghide,
                collapsed: gcoll,
                fitTick: fitTick,
                onToggleCollapse: function (tid) {
                  setGcoll(function (prev) {
                    var next = {}
                    for (var k in prev) next[k] = prev[k]
                    next[tid] = !prev[tid]
                    return next
                  })
                },
              })
          : h('div', { className: 'nkb-muted', style: { padding: 16 } }, tree ? '空库' : '载入中…'),
      )

      var props = h(
        'div',
        { className: 'nkb-props' },
        info
          ? h(
              'div',
              null,
              h('div', { className: 'nkb-sec', style: { marginTop: 0 } }, '节点属性'),
              kv('tid', info.tid),
              kv('类型', info.type),
              kv('标题', info.title),
              kv('父', info.parent_tid),
              kv('源', info.source),
              kv('字符', String((info.text || '').length)),
              info.children && info.children.length ? kv('子节', info.children.length + ' 个') : null,
              info.kind === 'file'
                ? h('div', { style: { margin: '6px 0' } }, h('button', { onClick: rename, disabled: busy, title: '文件改名并改写全库 [[TID]] 引用' }, '改名'))
                : null,
              h('div', { className: 'nkb-sec' }, '被引用'),
              back === null
                ? h('div', { className: 'nkb-muted' }, '…')
                : back.length
                  ? back.map(function (b, i) {
                      return h('div', { key: i }, h('span', { className: 'nkb-link', onClick: function () { open(b.tid) } }, b.tid))
                    })
                  : h('div', { className: 'nkb-muted' }, '没有节点引用它'),
            )
          : h('div', { className: 'nkb-muted' }, '选一个节点看详情'),
        tree && tree.problems && tree.problems.length
          ? h('div', null, h('div', { className: 'nkb-sec' }, 'TID 冲突'), h('div', { className: 'nkb-err' }, tree.problems.join('\n')))
          : null,
      )

      var right = h('aside', { className: 'nkb-right' }, h('div', { className: 'nkb-content' }, tabs, cutNotice, body), props)

      return h('div', { className: 'nkb-root' }, head, h('div', { className: 'nkb-body' }, left, center, right))
    }

    function kv(k, v) {
      if (v === undefined || v === null || v === '') return null
      return h('div', { className: 'nkb-kv' }, h('span', { className: 'k' }, k), h('span', { className: 'v' }, String(v)))
    }

    function makeIcon(React_) {
      return function NodekbIcon(props) {
        return h(Icon, props)
      }
    }

    // ── 装配 ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      var disposers = []
      var started = Date.now()
      var done = {}

      // 槽位注册逐个兜底：重复注册（热更/双载）只告警，不让整个客户端半边失败。
      function reg(label, fn) {
        try {
          var d = fn()
          if (typeof d === 'function') disposers.push(d)
          done[label] = 'ok'
        } catch (e) {
          done[label] = 'failed: ' + String((e && e.message) || e)
          report({ phase: 'register', label: label, error: String((e && e.message) || e) })
          try { console.warn('[project-node-memory] 槽位注册失败（' + label + '）:', e) } catch (_) { /* 控制台不可用 */ }
        }
      }

      function slotsOf() {
        if (ctx && ctx.slots && typeof ctx.slots.register === 'function') return ctx.slots
        try {
          if (ctx && typeof ctx.get === 'function') {
            var s = ctx.get('slots')
            if (s && typeof s.register === 'function') return s
          }
        } catch (e) { /* 服务未就绪 */ }
        return null
      }

      // `main` 与 `sidebar.panellist` 都可能比本插件晚声明（DSH 的槽位按条目
      // 的 children 表声明，声明前 register 会抛 "is not declared"）。
      // 官方第三方插件（dsh-tiddlywiki）用的是 slots.inject(name, cb)：声明已
      // 存在就同步跑，否则等到声明时再跑。这里同样走 inject，并保留轮询兜底。
      function regHere(label, register) {
        try {
          var d = register()
          done[label] = 'ok'
          return d
        } catch (e) {
          done[label] = 'failed: ' + String((e && e.message) || e)
          report({ phase: 'register', label: label, error: String((e && e.message) || e) })
          try { console.warn('[project-node-memory] 槽位注册失败（' + label + '）:', e) } catch (_) { /* 控制台不可用 */ }
          return undefined
        }
      }

      function whenDeclared(slots, name, label, register) {
        try {
          if (typeof slots.inject === 'function') {
            var remove = slots.inject(name, function () {
              var d = regHere(label, register)
              report({ phase: 'registered', label: label, at: Date.now() - started })
              return d
            })
            if (typeof remove === 'function') disposers.push(remove)
            if (typeof remove !== 'undefined') {
              done[label] = 'armed' // 已挂到声明钩子上，等声明时自动注册
              return true
            }
          }
        } catch (e) {
          report({ phase: 'inject', label: label, error: String((e && e.message) || e) })
        }
        // 没有 inject（旧 SDK）就当场注册一次，失败留给轮询重试。
        regHere(label, register)
        return true
      }

      function attempt() {
        var slots = slotsOf()
        if (!slots) return false
        if (!done['sidebar.panellist'] || done['sidebar.panellist'] === 'retry') {
          whenDeclared(slots, 'sidebar.panellist', 'sidebar.panellist', function () {
            return slots.register({ name: 'sidebar.panellist', id: 'nodekb', order: 50, label: function () { return SIDEBAR_LABEL } }, makeIcon())
          })
        }
        if (!done['main'] || done['main'] === 'retry') {
          whenDeclared(slots, 'main', 'main', function () {
            return slots.register({ name: 'main', key: 'nodekb' }, Panel)
          })
        }
        return true
      }

      function settled(label) {
        var s = done[label]
        return s === 'ok' || s === 'armed'
      }

      var attempts = 0
      function tick() {
        attempts++
        var ok = attempt()
        if (ok && settled('sidebar.panellist') && settled('main')) {
          report({ phase: 'apply', ok: true, id: PKG_ID, label: SIDEBAR_LABEL, attempts: attempts, ms: Date.now() - started, done: done })
          return
        }
        if (attempts >= 100) {
          report({
            phase: 'apply',
            ok: false,
            attempts: attempts,
            reason: '10 秒内槽位没有声明齐全',
            hasSlots: !!slotsOf(),
            hasInject: !!(slotsOf() && typeof slotsOf().inject === 'function'),
            done: done,
          })
          return
        }
        try { setTimeout(tick, 100) } catch (e) { /* 无定时器 */ }
      }

      report({
        phase: 'apply-start',
        hasCtx: !!ctx,
        hasSlots: !!(ctx && ctx.slots),
        ctxKeys: ctx && typeof ctx === 'object' ? Object.keys(ctx).slice(0, 40) : null,
      })
      tick()
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (e) { /* 卸载期忽略 */ }
        }
      }
    }

    return {
      apply: apply,
      inject: ['slots'],
      Panel: Panel,
      Icon: Icon,
      // 离线自检用：不装 DSH 也能直接驱动布局函数
      __internals: { layoutGraph: layoutGraph, edgePath: edgePath, collectTypes: collectTypes, Graph: Graph, NODE_W: NODE_W, NODE_H: NODE_H, graphTitleLines: graphTitleLines, graphNodeHeight: graphNodeHeight, NODE_MAX_CHARS: NODE_MAX_CHARS, boardLayout: boardLayout, squarify: squarify, findPath: findPath, subtreeCount: subtreeCount, fitLabel: fitLabel, BOARD_W: BOARD_W, BOARD_H: BOARD_H, Board: Board, typeFill: typeFill, mdBlocks: mdBlocks, mdInline: mdInline, Md: Md, typeColor: typeColor, texToMathML: texToMathML, safeTex: safeTex, hlTerms: hlTerms, hlRuns: hlRuns, hlNodes: hlNodes },
    }
  }
})()
