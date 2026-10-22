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

    // ── 样式（只注入一次）──────────────────────────────────────────────────
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('project-node-memory-style')) return
      var css = [
        '.nkb-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:inherit}',
        '.nkb-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.25);flex:0 0 auto}',
        '.nkb-title{font-weight:600;letter-spacing:.02em}',
        '.nkb-head select,.nkb-head input,.nkb-head button{font:inherit;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:3px 7px}',
        '.nkb-head input{min-width:180px}',
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
      var el = document.createElement('style')
      el.id = 'project-node-memory-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    // ── 小组件 ────────────────────────────────────────────────────────────
    /** 把 [[node="x"]] / [[tscl="x"]] / [[x]] 变成可点条目（点击跳到节点；宏点击跳到定义所在处） */
    function Rich(props) {
      var text = props.text || ''
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
        { className: 'nkb-text' },
        parts.map(function (p, i) {
          if (p.macro) {
            return h(
              'span',
              { key: i, className: 'nkb-macro', title: '宏：' + p.macro, onClick: function () { props.onMacro && props.onMacro(p.macro) } },
              p.t,
            )
          }
          if (!p.tid) return p.t
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

    function mdInline(text, onOpen, kbKey) {
      var out = []
      var last = 0
      var m
      var n = 0
      MD_INLINE.lastIndex = 0
      while ((m = MD_INLINE.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index))
        var key = kbKey + '-i' + n++
        if (m[1] !== undefined) {
          out.push(h('code', { key: key }, m[1]))
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
          out.push(h('strong', { key: key }, m[7]))
        } else if (m[8] !== undefined) {
          out.push(h('em', { key: key }, m[8]))
        } else if (m[9] !== undefined) {
          out.push(h('a', { key: key, href: m[10], target: '_blank', rel: 'noreferrer' }, m[9]))
        }
        last = m.index + m[0].length
      }
      if (last < text.length) out.push(text.slice(last))
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

    function mdBlock(b, idx, onOpen) {
      var k = 'b' + idx
      if (b.k === 'code') return h('pre', { key: k }, h('code', null, b.text))
      if (b.k === 'math') return h('div', { key: k, className: 'nkb-math nkb-math-block', dangerouslySetInnerHTML: { __html: safeTex(b.text, true) } })
      if (b.k === 'h') return h('h' + b.level, { key: k }, mdInline(b.text, onOpen, k))
      if (b.k === 'hr') return h('hr', { key: k })
      if (b.k === 'quote') return h('blockquote', { key: k }, mdInline(b.text, onOpen, k))
      if (b.k === 'list') {
        var tag = b.items.length && b.items[0].ordered ? 'ol' : 'ul'
        return h(
          tag,
          { key: k },
          b.items.map(function (it, j) {
            return h('li', { key: k + '-' + j, style: { marginLeft: it.depth * 14 + 'px' } }, mdInline(it.text, onOpen, k + '-' + j))
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
            h('thead', null, h('tr', null, b.head.map(function (c, j) { return h('th', { key: j }, mdInline(c, onOpen, k + 'h' + j)) }))),
            h('tbody', null, b.rows.map(function (r, j) {
              return h('tr', { key: j }, r.map(function (c, cj) { return h('td', { key: cj }, mdInline(c, onOpen, k + j + '-' + cj)) }))
            })),
          ),
        )
      }
      return h('p', { key: k }, mdInline(b.text, onOpen, k))
    }

    function Md(props) {
      var text = props.text || ''
      var blocks = useMemo(function () { return mdBlocks(text) }, [text])
      return h('div', { className: 'nkb-md' }, blocks.map(function (b, i) { return mdBlock(b, i, props.onOpen) }))
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
    var NODE_W = 188
    var NODE_H = 34

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
        var it = { node: node, tid: node.tid, depth: depth, kids: kids, x: 0, y: 0, primary: 0 }
        items.push(it)
        return it
      }
      var rootItem = collect(root, 0)
      if (!rootItem) return { items: [], edges: [], width: 1, height: 1, minX: 0, minY: 0 }
      var tb = opts.dir !== 'LR'
      var slot = tb ? NODE_W + 20 : NODE_H + 26
      var level = tb ? NODE_H + 56 : NODE_W + 64
      var cursor = 0
      ;(function place(it) {
        if (!it.kids.length) {
          it.primary = cursor
          cursor += 1
        } else {
          for (var i = 0; i < it.kids.length; i++) place(it.kids[i])
          it.primary = (it.kids[0].primary + it.kids[it.kids.length - 1].primary) / 2
        }
        var sec = it.depth * level
        if (tb) {
          it.x = it.primary * slot
          it.y = sec
        } else {
          it.x = sec
          it.y = it.primary * slot
        }
      })(rootItem)
      var edges = []
      for (var i = 0; i < items.length; i++) {
        for (var j = 0; j < items[i].kids.length; j++) edges.push({ from: items[i], to: items[i].kids[j] })
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
        maxY = Math.max(maxY, a.y + NODE_H)
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
      if (tb) {
        var x1 = a.x + NODE_W / 2
        var y1 = a.y + NODE_H
        var x2 = b.x + NODE_W / 2
        var y2 = b.y
        var my = (y1 + y2) / 2
        return 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2
      }
      var ax = a.x + NODE_W
      var ay = a.y + NODE_H / 2
      var bx = b.x
      var by = b.y + NODE_H / 2
      var mx = (ax + bx) / 2
      return 'M' + ax + ',' + ay + ' C' + mx + ',' + ay + ' ' + mx + ',' + by + ' ' + bx + ',' + by
    }

    function ellipsis(s, n) {
      s = String(s || '')
      return s.length > n ? s.slice(0, n - 1) + '…' : s
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
                h('rect', { width: NODE_W, height: NODE_H, rx: 6, stroke: typeColor(it.node.type), strokeWidth: 1.4 }),
                h('text', { x: 10, y: NODE_H / 2 + 4 }, ellipsis(it.node.title || it.tid, tb ? 24 : 22)),
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
      var gdirState = useState('LR')
      var gdir = gdirState[0]
      var setGdir = gdirState[1]
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

      function open(tid) {
        setSel(tid)
        setView('subtree')
        setHits(null)
        setQuery('')
      }

      function runSearch() {
        var q = (query || '').trim()
        if (!q) { setHits(null); return }
        setBusy(true)
        get('/search', { kb: kb, q: q, limit: 30 })
          .then(function (r) { setHits(r); setErr('') })
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

      /** 改文件名：TID 由文件名派生，所以引用要一起搬（走 /rename，不自己拼） */
      function rename() {
        if (!g.prompt || !info || info.kind !== 'file') return
        var v = g.prompt('新文件名（.md 可省略；全库引用会一起改写）', (info.title || '') + '.md')
        if (v === null || v === undefined) return
        var name = String(v).trim()
        if (!name) return
        setBusy(true)
        get('/rename', { kb: kb, target: info.tid, new_name: name })
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
        h('input', {
          value: query,
          placeholder: '检索（中文自然语言可用）',
          onChange: function (e) { setQuery(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter') runSearch() },
        }),
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
          h('span', { className: 'nkb-chip' + (gdir === 'TB' ? ' on' : ''), onClick: function () { setGdir('TB'); setFitTick(fitTick + 1) } }, '上下'),
          h('span', { className: 'nkb-chip' + (gdir === 'LR' ? ' on' : ''), onClick: function () { setGdir('LR'); setFitTick(fitTick + 1) } }, '左右'),
        ),
        h('div', { className: 'lbl' }, '展开层数'),
        h(
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
          { className: 'nkb-tree' },
          hits
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'nkb-muted', style: { padding: '2px 6px 6px' } },
                  '命中 ' + hits.count + ' / ' + hits.total + ' 条',
                ),
                (hits.hits || []).map(function (hit, i) {
                  return h(
                    'div',
                    { key: hit.tid + '#' + i, className: 'nkb-hit', onClick: function () { open(hit.tid) } },
                    h('div', { className: 'tt' }, hit.title || hit.tid),
                    h('div', { className: 'nkb-muted' }, hit.tid + ' · ' + hit.type),
                    h('div', { className: 'sn' }, hit.snippet || ''),
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
            h('div', null, '诊断：' + (diagData.errors && diagData.errors.length ? diagData.errors.length + ' 错误' : '无错误') + ' · ' + (diagData.warnings && diagData.warnings.length ? diagData.warnings.length + ' 告警' : '无告警')),
            ...(diagData.errors || []).map(function (t, i) { return h('div', { key: 'e' + i }, '✗ ' + t) }),
            ...(diagData.warnings || []).map(function (t, i) { return h('div', { key: 'w' + i, className: 'nkb-muted' }, '! ' + t) }),
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
            ? h(Rich, { text: shownText, onOpen: open })
            : h(Md, { text: shownText, onOpen: open })
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
          ? h(Graph, {
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
      __internals: { layoutGraph: layoutGraph, edgePath: edgePath, collectTypes: collectTypes, Graph: Graph, NODE_W: NODE_W, NODE_H: NODE_H, mdBlocks: mdBlocks, mdInline: mdInline, Md: Md, typeColor: typeColor, texToMathML: texToMathML, safeTex: safeTex },
    }
  }
})()
