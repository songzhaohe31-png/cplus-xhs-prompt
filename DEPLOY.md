# CPLUS Agent 部署与使用

线上地址：https://cplus-xhs-prompt.onrender.com/

## 环境变量（Render）

必填：

- `AI_API_KEY` xAI 密钥，必须是 `xai-` 开头的完整密钥（在 https://console.x.ai 创建，只显示一次）。**不要填团队 UUID。**
- `AI_PROVIDER` `xai`
- `AI_API_BASE` `https://api.x.ai/v1`（必须是网址，不能填 ID）
- `AI_MODEL` `grok-4.6`

可选：

- `ADMIN_PASSWORD` 仅内部账号用，公开站点不需要登录

强烈建议：

- `DATABASE_URL` Render PostgreSQL。免费 Web 无持久盘，没有数据库会丢知识库和日历。
- `IMAGE_API_KEY` AI 海报；不填则只能用快速模板。

可选：

- `ADMIN_NAME` 默认 Admin
- `IMAGE_MODEL` 默认 `dall-e-3`

管理员用户名默认 `Admin`，密码为 `ADMIN_PASSWORD`。

## 知识库

上传 PDF/Word/Excel/TXT 后会抽文本、按段落切片检索，不会把全文塞进模型。过期资料会提示。生产请配 DATABASE_URL，文件二进制也会写入 Postgres。

## 定时任务

管理员 `POST /api/jobs`：

```
{ "type": "weekly_generate", "runAt": "2026-08-20T02:00:00.000Z", "payload": { "message": "生成本周3篇小红书内容。" } }
```

任务在服务器运行，关闭浏览器不会中断。失败会保留 `failed` 和错误信息。

## 回滚

`data/backups/agent-real-*` 或 `git revert` 本次提交。
