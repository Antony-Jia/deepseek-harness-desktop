# DeepSeek 视觉桥接

为 DeepSeek Harness 中不支持图片输入的模型注册 `/vision` 图片命令和 `deepseek_vision_analyze` 工具。工具使用内建的 `deepseek-official/deepseek-v4-flash-vision-exp` 分析当前会话图片，可用于图片描述、OCR、图表解读、截图检查和多图比较。支持图片的模型会直接看图，并禁止调用桥接工具。

## 工作方式

- 只接受当前 DSH 会话中已经持久化的图片引用，不读取任意本地路径或远程 URL。
- 非视觉模型附加图片后，使用 `/vision 你的问题` 提交；原生发送按钮仍会执行 Harness 的模型模态准入。
- `/vision` 会把图片和原始问题记录为正常用户消息，因此聊天流会显示用户气泡和图片画廊；桥接指令只进入系统提示词。
- 未传 `attachmentIds` 时分析最近一条含图片消息中的全部图片；显式传入时最多分析 8 张。
- 图片继续由 DSH 附件服务完成校验、缩放与请求投影。
- 当前 `deepseek-official` 配置必须公布 `deepseek-v4-flash-vision-exp`，且模型元数据包含 `image` 输入能力。

## 安装

```sh
dsh plugin --profile web add @p-dsh-market/deepseek-vision-bridge
```

安装后重启 DSH。插件的 `cordis.patch.yml` 会挂载 `commands`、`llm`、`skills`、`systemPrompt` 和 `tools` 五项宿主服务。

## 工具参数

```json
{
  "query": "读取截图中的错误信息并给出摘要",
  "attachmentIds": ["sha256:..."]
}
```

`query` 必填；`attachmentIds` 可省略。
