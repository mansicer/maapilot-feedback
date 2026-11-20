# maapilot-feedback

[MaaPilot](https://github.com/mansicer/MaaPilot) 用户反馈的接收端：一个 Cloudflare Worker，把收到的反馈存进 R2，再发一条 Telegram 通知给开发者。

用户在 MaaPilot 里说"我想反馈一个问题"，他的 agent 整理好内容、在对话里给他看过、他同意之后才会上传到这里。
上传的内容和脱敏规则见 MaaPilot 仓库的 `docs/cli.md`「feedback」和 skill `maapilot-feedback`。

## 收到的数据怎么处理

- **存什么**：客户端发来的清单和 zip 包，原样存进 R2（不公开可读）。包里是用户的反馈原话、agent 写的会话经过、不含个人信息的环境信息；用户同意时还有原始会话记录、截图、MAA 日志。
- **不存什么**：提交者的 IP。IP 只在限流时用一下，不写进存储，不写进通知。Worker 的日志关着。
- **留多久**：90 天，由 R2 的生命周期规则自动删除。
- **谁能看**：只有开发者，凭密钥取回。
- **通知**：Telegram 里只有编号、类别、版本、大小和用户原话的开头 80 个字（客户端脱敏后放在清单里的）。

## 接口

| 请求 | 做什么 |
|---|---|
| `POST /feedback` | 收一份反馈。`multipart/form-data`，字段 `manifest`（JSON）和 `bundle`（zip），请求头 `X-MaaPilot-Feedback: 1`。成功回 `{"ok": true, "id": "<编号>"}` |
| `GET /feedback/<编号>` | 开发者取回那份包。要 `Authorization: Bearer <ADMIN_TOKEN>`，没有或不对一律 404 |
| `GET /feedback?day=YYYY-MM-DD` | 开发者看某天收到的清单（同样要密钥） |

收之前的检查，任何一项不过都不落盘：

| 检查 | 不过时 |
|---|---|
| 带了客户端的请求头、是 multipart | 400 `bad_client` / `bad_content_type` |
| 大小不超过 5 MB（先看声明的长度，读的时候再按实际字节卡） | 413 `too_big` |
| 同一个 IP 60 秒内不超过 5 份 | 429 `rate_limited` |
| 清单：版本、编号格式和日期、类别、文件名只能是客户端会产生的那几种 | 400 `bad_schema` / `bad_id` / `bad_category` / `bad_files` |
| 包：是 zip，大小和 sha256 与清单一致，里面的文件和清单列的一样 | 400 `size_mismatch` / `hash_mismatch` / `bad_zip` / `files_mismatch` |
| 当天收到的不超过 200 份 | 429 `daily_limit` |

同一个编号原样重发（客户端断线后会这样）回成功、不重复存；同一个编号换了内容回 409 `id_taken`。

R2 里的布局：`feedback/<年>/<月>/<日>/<编号>/bundle.zip` 和 `manifest.json`（日期取自编号）；`days/<收到的日期>/<编号>` 是数当天收了多少份用的空文件。

## 测试

```sh
node --test test/worker.test.js
```

不用装任何依赖（Node 22 以上）。请求体 `test/fixtures/request-body.bin` 是 MaaPilot 客户端真实生成的：客户端改了上传协议，就在 MaaPilot 的虚拟环境里重新生成一份，测试对不上说明两边走样了。

```sh
# 在 MaaPilot 仓库里跑；第二个参数是一个空的临时文件夹
MAAPILOT_PRIVATE=<临时文件夹>/private .venv/bin/python <本仓库>/test/make-fixture.py <本仓库>/test/fixtures <临时文件夹>
```

## 部署

仓库里**没有**任何账号信息和密钥：`wrangler.toml`、`.dev.vars` 都在 `.gitignore` 里，只入库模板。

1. Cloudflare 后台开通 R2，建一个存储桶。
2. 建一个 API token：Workers 脚本编辑、R2 存储编辑；绑自定义域名还要那个域名的 DNS 和 Workers 路由权限。
3. `cp wrangler.example.toml wrangler.toml`，填存储桶的名字。
4. 部署和设密钥（账号 ID 和 token 从环境变量来，不写进文件）：

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
   npx wrangler deploy
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put ADMIN_TOKEN
   ```

5. 90 天自动删除：

   ```sh
   npx wrangler r2 bucket lifecycle add <存储桶> expire-90d feedback/ --expire-days 90
   npx wrangler r2 bucket lifecycle add <存储桶> expire-days-90d days/ --expire-days 90
   ```

6. 先在 `workers.dev` 的临时地址上测：MaaPilot 那边设环境变量 `MAAPILOT_FEEDBACK_URL=https://<临时地址>/feedback`，走一遍起草和发送。
7. 测通后在 `wrangler.toml` 里打开 `[[routes]]`（自定义域名），再部署一次。

取回一份反馈：

```sh
export FEEDBACK_URL=https://<域名>/feedback  FEEDBACK_ADMIN_TOKEN=…
scripts/pull.sh --list            # 今天收到的
scripts/pull.sh fb-20261120-233323-33e1
```

取回的包来自匿名用户，当数据看：只解压到 `downloads/<编号>/`（不入库），不执行里面的任何东西。
