# 百炼业务空间专属域名迁移

> 记录 2026-09-21 收到的阿里云邮件，以及本扩展的应对计划。官方说明：[选择地域、服务部署范围和接入域名](https://help.aliyun.com/zh/model-studio/regions#%E8%BF%81%E7%A7%BB%E8%87%B3%E4%B8%9A%E5%8A%A1%E7%A9%BA%E9%97%B4%E4%B8%93%E5%B1%9E%E5%9F%9F%E5%90%8D)。

## 邮件在说什么

2026-09-30 起，DashScope 共享域名 `dashscope.aliyuncs.com` 进入维护状态：不再迭代新特性，现有服务不受影响。百炼建议改用业务空间专属域名 `{workspaceId}.{region}.maas.aliyuncs.com`。

这不是停服。当天之后，现有模型、现有调用方式仍可继续用。专属域名的差别是并发承载和网络隔离更好，超时更长，并且此后的新能力只在专属域名上提供。

## 对本扩展的实际影响

本扩展只使用华北 2（北京）的 OpenAI 兼容接口。地址写死在三处：

- `src/proofreader.ts` 的 `AliyunApiClient`（正文校对）
- `src/llm/llmClient.ts` 的 `llmGenerateJson`（资料检索等）
- `src/llm/llmClient.ts` 的 `llmChat`（编辑记忆等）

当前地址：

`https://dashscope.aliyuncs.com/compatible-mode/v1`

对应的专属地址：

`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`

`Authorization: Bearer`、路径 `/chat/completions`、请求体里的 `model`、`messages`、`enable_thinking`、`temperature` 都不用改。客户端超时上限是 300 秒；专属域名把服务端超时从 600 秒提到 3600 秒，对现有设置没有影响。限流仍按主账号、按模型计算。

不能把某一个 WorkspaceId 写进代码。共享域名接受该地域任意业务空间的 API Key；专属域名只接受该业务空间自己的 Key。本扩展由使用者各自填写密钥，写死一个空间后，别人的密钥会鉴权失败。

## 应对计划

分三步。9 月 30 日前做完即可，不必赶在当天。旧域名在维护期内仍可调用现有模型，第 2 步晚几天合并也不会让当前校对中断。

### 1. 在控制台核对地址和密钥是否同一空间

打开百炼[业务空间管理](https://bailian.console.aliyun.com/)，在当前正在使用的空间里复制「API Host」，形如 `llm-xxxx.cn-beijing.maas.aliyuncs.com`。确认设置项 `ai-proofread.apiKeys.aliyun` 里的密钥就是在这个空间创建的。有多个空间时，以密钥所属空间为准。

### 2. 扩展增加可选接入地址，默认仍用旧域名

新增设置项 `ai-proofread.apiKeys.aliyunBaseUrl`，默认为空。

- 空：继续用 `https://dashscope.aliyuncs.com/compatible-mode/v1`，已安装用户行为不变。
- 填写 Host 或完整 Base URL：上面三处调用都走这一处拼出来的地址。

清空该设置即可退回旧域名。

### 3. 自己先切，再写进说明

用同一把密钥，对新旧地址各发一次极短的 `chat/completions`（模型用正在用的，例如 `qwen3.7-max`）。新地址返回正常后，在扩展设置里填上 Host，用一小段书稿走一遍校对，并点一次会调用 `llmClient` 的功能（资料检索或编辑记忆）。通过后，在 README 和设置说明里写上：9 月 30 日起新模型、新能力只在专属域名提供，请到业务空间页复制 API Host。
