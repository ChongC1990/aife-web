# AiFE - 轮辋螺栓压装曲线 AI 视觉检测系统

基于多模态大模型（Gemini）的工业视觉质检 Web 服务，专用于轮辋螺栓压装工艺合格性判断。

## 功能

- 📸 上传压装曲线图片（支持拖拽）
- 🤖 AI 自动分析，5-8 秒出结果
- ✅ 判定合格 / ❌ 不合格（细分压力过高 / 未压到位）
- 📊 展示检测依据、分析过程、处理建议
- 📝 本地历史记录（最近 10 条）

## 判断逻辑

经 8 个真实工厂样本验证，准确率 100%：

| 判断条件 | 结论 |
|----------|------|
| 复位按钮左侧数值 = `10000` 且行程 ≥ 10mm | ❌ 压力过高 |
| 复位按钮左侧数值 = `10000` 且行程 < 10mm | ❌ 压力过高且未压到位 |
| 数值 ≠ `10000` 且行程 ≤ 9mm | ❌ 压力过高且未压到位 |
| 其余 | ✅ 合格 |

## 技术栈

- **前端**：原生 HTML/CSS/JS（无框架，零依赖）
- **后端**：Node.js 原生 HTTP Server
- **AI 模型**：`gemini-3.1-flash-lite-preview`（via SkillFree API）
- **图片压缩**：sips（macOS）/ imagemagick（Linux）
- **进程管理**：PM2

## 快速部署

### 环境要求
- Node.js >= 18
- imagemagick（Linux）或 macOS 内置 sips
- SkillFree API Key（[申请地址](https://skillfree.tech)）

### 启动

```bash
# 克隆项目
git clone https://github.com/ChongC1990/aife-web.git
cd aife-web

# 配置 API Key
export SKILLFREE_API_KEY=your_key_here

# 直接启动
node server.js

# 或用 PM2 守护
pm2 start ecosystem.config.js
```

访问 http://localhost:3456

## 项目结构

```
aife-web/
├── server.js          # 后端服务（API + 静态文件）
├── public/
│   └── index.html     # 前端页面
├── ecosystem.config.js # PM2 配置（含 API Key，不提交）
├── logs/              # 检测日志（JSONL 格式）
└── uploads/           # 临时上传目录（自动清理）
```

## 数据来源

样本数据来自真实工厂现场（2026-03-09），包含：
- 4 张合格品（Good）
- 76 张不合格-压力过高
- 48 张不合格-压力过高且未压到位

## License

MIT
