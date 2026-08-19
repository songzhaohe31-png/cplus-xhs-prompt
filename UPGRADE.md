# CPLUS 新媒体运营工作台升级说明

日期：2026-08-19  
备份：`data/backups/pre-upgrade-20260819-175426/`（数据）  
源码快照：`data/backups/source-20260819-175426/`

## 第一阶段：现有系统检查

| 项 | 现状 |
|---|---|
| 形态 | Express + 静态 SPA，Docker 部署 Render 免费实例 `cplus-xhs-prompt` |
| 数据 | `DATA_DIR` JSON 文件；Render 无持久盘，回收后数据会丢，前端对 feed/素材有 localStorage 补偿 |
| 现有页面 | 出稿、喂帖、风格、账号规则、存档；Prompt 模板与素材 API 仍在，上一版导航曾收起 |
| AI | `settings.json` 可存 Key；前端已脱敏。`/api/generate/*` 存在但主流程是打包任务 |
| 风险 | 免费 Render 无磁盘；知识库大文件同样不持久。须定期导出。 |

## 兼容策略

- 不删除 `/api/prompt/*`、`/api/materials`、`/api/rules`、`/api/feed`、`/api/produce`、PDF 导出
- 导航恢复 Prompt 模板与素材
- 默认开放权限，避免把现有同事锁在门外
- API Key 只存在服务器 / Render 环境变量

## 回滚

1. 用 `data/backups/source-20260819-175426/` 覆盖 `server.js`、`public/`、`package.json`、`Dockerfile`
2. 删除 `lib/` 与 `public/js/workbench.js`、`public/css/theme.css`
3. `git revert` 本次升级提交
4. 数据可用 `data/backups/pre-upgrade-*` 的 JSON 覆盖 `data/`

## 环境变量（Render）

- `AI_API_KEY`（不写进仓库）
- `AI_API_BASE` 默认 `https://api.openai.com/v1`
- `AI_MODEL` 默认 `gpt-4o-mini`
- `ADMIN_PIN` / `EDITOR_PIN` / `REVIEWER_PIN` 可选
- `DATA_DIR=/app/data`
