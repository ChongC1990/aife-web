#!/usr/bin/env node
/**
 * AiFE Web Server
 * POST /api/inspect  - 上传图片，返回检测结果
 * GET  /             - 前端页面
 */

'use strict';
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { execSync } = require('child_process');

const PORT      = process.env.PORT || 3456;
const PUBLIC    = path.join(__dirname, 'public');
const UPLOADS   = path.join(__dirname, 'uploads');
const LOGS_DIR  = path.join(__dirname, 'logs');
const API_KEY   = process.env.SKILLFREE_API_KEY || '';
const MODEL     = 'gemini-3.1-flash-lite-preview';

[UPLOADS, LOGS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon' };

// ── 静态文件 ──────────────────────────────────────────────────────────────────
function serveStatic(req, res) {
  const fp = path.join(PUBLIC, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

// ── 解析 multipart ────────────────────────────────────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return reject(new Error('no boundary'));
    const boundary = Buffer.from('--' + bm[1]);

    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // 找到文件数据
      const start = body.indexOf(boundary) ;
      const parts = [];
      let pos = 0;
      while (pos < body.length) {
        const bStart = body.indexOf(boundary, pos);
        if (bStart === -1) break;
        const hStart = bStart + boundary.length + 2; // skip \r\n
        const hEnd   = body.indexOf(Buffer.from('\r\n\r\n'), hStart);
        if (hEnd === -1) break;
        const header  = body.slice(hStart, hEnd).toString();
        const dataStart = hEnd + 4;
        const nextBound = body.indexOf(boundary, dataStart);
        const dataEnd   = nextBound === -1 ? body.length : nextBound - 2;
        const data      = body.slice(dataStart, dataEnd);
        parts.push({ header, data });
        pos = nextBound === -1 ? body.length : nextBound;
      }
      const imgPart = parts.find(p => p.header.includes('filename'));
      if (!imgPart) return reject(new Error('no file'));
      const fnm = (imgPart.header.match(/filename="([^"]+)"/) || [])[1] || 'upload.jpg';
      resolve({ filename: fnm, data: imgPart.data });
    });
    req.on('error', reject);
  });
}

// ── 压缩图片（跨平台）────────────────────────────────────────────────────────
function compress(src, dst) {
  try {
    // macOS: sips
    if (process.platform === 'darwin') {
      execSync(`sips -Z 900 --setProperty formatOptions 60 "${src}" --out "${dst}" 2>/dev/null`);
    } else {
      // Linux: imagemagick convert
      execSync(`convert "${src}" -resize 900x900> -quality 60 "${dst}" 2>/dev/null`);
    }
    return dst;
  } catch (e) {
    console.error('[compress error]', e.message);
    return src; // fallback: 用原图
  }
}

// ── 调用视觉 API ──────────────────────────────────────────────────────────────
const PROMPT = `这是工业压装设备屏幕截图（轮辋螺栓压装曲线，X轴=位移mm，Y轴=压力N）。

请完成以下判断并只输出JSON：

A. 界面顶部有一个「复位」按钮，在「复位」按钮左侧有一个数字显示框。
   这个数字框里的数字是什么？（只读这一个框，不要读坐标轴刻度）

B. 曲线从开始上升到结束的X轴行程，大约多少毫米？

C. 曲线末端形态（平稳/持续上升截断/其他）

只输出JSON，不要markdown：
{"reset_left_value":"数字","x_range_mm":10,"end_behavior":"描述"}`;

function callVisionAPI(imgPath) {
  return new Promise((resolve, reject) => {
    const b64  = fs.readFileSync(imgPath).toString('base64');
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: 'text', text: PROMPT }
      ]}],
      max_tokens: 120,
      temperature: 0.05
    });
    const req = https.request({
      hostname: 'skillfree.tech', path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content || ''); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 判断逻辑 ──────────────────────────────────────────────────────────────────
function judge(obs) {
  const val     = String(obs.reset_left_value || '').trim();
  const xRange  = Number(obs.x_range_mm) || 10;
  const is10000 = val === '10000' || val === '10,000';

  let result, defect_type, confidence, analysis, recommendation;

  if (is10000 && xRange >= 10) {
    result = 'BAD'; defect_type = '压力过高'; confidence = 0.93;
    analysis = '界面显示压力超限（10000），螺栓已压到位（行程正常），但最终压力超出上限，可能导致螺栓或轮辋受损。';
    recommendation = '隔离该工件，检查压装机参数及螺栓/孔径配合尺寸。';
  } else if (is10000 && xRange < 10) {
    result = 'BAD'; defect_type = '压力过高且未压到位'; confidence = 0.90;
    analysis = '界面显示压力超限（10000），且X轴行程偏短，螺栓未压到规定深度，属双重缺陷。';
    recommendation = '隔离该工件，检查压装机行程设定及螺栓/孔径配合尺寸，必须返工处理。';
  } else if (!is10000 && xRange <= 9) {
    result = 'BAD'; defect_type = '压力过高且未压到位'; confidence = 0.80;
    analysis = 'X轴行程偏短（约' + xRange + 'mm），螺栓未压到规定深度，存在未压到位的风险。';
    recommendation = '建议人工复核，如确认行程不足需返工。';
  } else {
    result = 'GOOD'; defect_type = null; confidence = 0.92;
    analysis = '界面未检测到压力超限信号，X轴行程正常（约' + xRange + 'mm），曲线特征符合合格品标准。';
    recommendation = '产品合格，正常放行。';
  }

  return { result, defect_type, confidence, analysis, recommendation };
}

// ── 记录日志 ──────────────────────────────────────────────────────────────────
function writeLog(filename, judgment, obs) {
  const today = new Date().toISOString().split('T')[0];
  const entry = JSON.stringify({ ts: new Date().toISOString(), filename, ...judgment, obs, model: MODEL });
  fs.appendFileSync(path.join(LOGS_DIR, `${today}.jsonl`), entry + '\n');
}

// ── API 处理 ──────────────────────────────────────────────────────────────────
async function handleInspect(req, res) {
  try {
    const { filename, data } = await parseMultipart(req);
    const ts       = Date.now();
    const rawPath  = path.join(UPLOADS, `${ts}_${filename}`);
    const compPath = path.join(UPLOADS, `${ts}_comp.jpg`);
    fs.writeFileSync(rawPath, data);
    compress(rawPath, compPath);

    const raw      = await callVisionAPI(compPath);
    const m        = raw.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error('模型输出无法解析: ' + raw.slice(0, 80));
    const obs      = JSON.parse(m[0]);
    const judgment = judge(obs);

    writeLog(filename, judgment, obs);

    // 清理临时文件
    [rawPath, compPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...judgment, obs }));

  } catch (e) {
    console.error('[inspect error]', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'POST' && req.url === '/api/inspect') {
    return handleInspect(req, res);
  }
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`🔍 AiFE Web 服务启动：http://0.0.0.0:${PORT}`);
  console.log(`   模型: ${MODEL}`);
  console.log(`   API Key: ${API_KEY ? '已配置' : '⚠️  未配置'}`);
});
