// 本地静态服务器：把官方 chat-demo 构建产物 + 本地 API Key 注入 + 历史管理页跑起来。
// 零依赖，只用 Node 内置模块（Node >= 18）。
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const CONFIG_PATH = path.join(ROOT, 'config.local.json')
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

const DEFAULTS = {
  apiKey: '',
  forceApiKey: false,
  locale: 'zh-CN',
  theme: 'system',
  port: 5180
}

async function loadConfig () {
  let raw = {}
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[warn] config.local.json 解析失败，改用默认值：${err.message}`)
    }
  }
  const cfg = { ...DEFAULTS, ...raw }
  cfg.apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : ''
  cfg.locale = cfg.locale === 'en-US' ? 'en-US' : 'zh-CN'
  cfg.theme = ['light', 'dark', 'system'].includes(cfg.theme) ? cfg.theme : 'system'
  cfg.port = Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : DEFAULTS.port
  return cfg
}

function maskKey (key) {
  if (!key) return ''
  if (key.length <= 10) return '****'
  return `${key.slice(0, 5)}…${key.slice(-4)}`
}

// 注入脚本：官方前端从 localStorage 读配置，这里在它加载前把值写好。
// 同时把「计费单价」交给注入层（overlay.js）用来估算花费。
function buildLocalConfigJs (cfg) {
  const payload = {
    apiKey: cfg.apiKey,
    forceApiKey: cfg.forceApiKey === true,
    locale: cfg.locale,
    theme: cfg.theme
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  const pricing = JSON.stringify(cfg.pricing || null).replace(/</g, '\\u003c')
  return `/* 由 server.mjs 生成，内容来自 config.local.json */
window.__DS_LOCAL_PRICING__ = ${pricing};
(function () {
  var cfg = ${json};
  var KEYS = {
    apiKey: 'chat-demo:api-key',
    locale: 'chat-demo:locale',
    theme: 'chat-demo:theme-preference'
  };
  try {
    var LS = window.localStorage;
    function setIfAllowed(name, value, force) {
      if (!value) return;
      try {
        if (!force && LS.getItem(name)) return;
        LS.setItem(name, value);
      } catch (e) {}
    }
    setIfAllowed(KEYS.apiKey, cfg.apiKey, !!cfg.forceApiKey);
    setIfAllowed(KEYS.locale, cfg.locale, false);
    setIfAllowed(KEYS.theme, cfg.theme !== 'system' ? cfg.theme : '', false);
  } catch (e) {}
})();
`
}

function json (res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  })
  res.end(data)
}

function safeResolve (urlPath) {
  const rel = urlPath.replace(/^\/+/, '')
  const abs = path.resolve(PUBLIC, rel)
  if (abs !== PUBLIC && !abs.startsWith(PUBLIC + path.sep)) return null
  return abs
}

const server = createServer(async (req, res) => {
  if (!req.url) return json(res, 400, { error: 'bad request' })
  const url = new URL(req.url, `http://${HOST}`)
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return json(res, 400, { error: 'bad path' })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' })
  }

  const cfg = await loadConfig()

  if (pathname === '/local-config.js') {
    const body = buildLocalConfigJs(cfg)
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    })
    return res.end(body)
  }

  if (pathname === '/api/status') {
    let publicVersion = '0.1.1'
    return json(res, 200, {
      hasApiKey: Boolean(cfg.apiKey),
      apiKeyMasked: maskKey(cfg.apiKey),
      locale: cfg.locale,
      theme: cfg.theme,
      publicVersion,
      configPath: CONFIG_PATH,
      manageUrl: `http://${HOST}:${cfg.port}/manage`
    })
  }

  if (pathname === '/manage' || pathname === '/manage/') pathname = '/manage.html'
  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html'
  if (pathname.startsWith('/chat-demo/')) pathname = pathname.slice('/chat-demo'.length)

  const filePath = safeResolve(pathname)
  if (!filePath) return json(res, 403, { error: 'forbidden' })

  let info
  try {
    info = await stat(filePath)
    if (info.isDirectory()) {
      info = await stat(path.join(filePath, 'index.html'))
      return json(res, 404, { error: 'not found' })
    }
  } catch {
    return json(res, 404, { error: 'not found', path: pathname })
  }

  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const isHashed = /[.-][0-9a-f]{8,}\.(js|css)$/.test(filePath)
  const isHtml = ext === '.html'

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': isHtml ? 'no-store' : isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  })

  if (req.method === 'HEAD') return res.end()
  createReadStream(filePath).pipe(res)
})

const cfg = await loadConfig()
server.listen(cfg.port, HOST, () => {
  const base = `http://${HOST}:${cfg.port}`
  console.log('')
  console.log('  DeepSeek 本地版（官方 chat-demo 构建产物）已启动')
  console.log(`  聊天界面 : ${base}/`)
  console.log(`  历史管理 : ${base}/manage    <- 删除 / 导出 / 清空本地聊天记录`)
  console.log(`  API Key  : ${cfg.apiKey ? '已从 config.local.json 注入（' + maskKey(cfg.apiKey) + '）' : '未配置 —— 可在页面设置里手填，或写入 config.local.json'}`)
  console.log('  按 Ctrl+C 停止')
  console.log('')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${cfg.port} 已被占用：改 config.local.json 里的 port，或先关掉占用它的程序。`)
    process.exit(1)
  }
  throw err
})
