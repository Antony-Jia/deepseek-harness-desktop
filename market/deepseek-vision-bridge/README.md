# DeepSeek 视觉桥接

为 DeepSeek Harness 中不支持图片输入的模型注册 `deepseek_vision_analyze` 工具。工具使用内建的 `deepseek-official/deepseek-v4-flash-vision-exp` 分析当前会话已上传的图片，可用于图片描述、OCR、图表解读、截图检查和多图比较。

## 工作方式

- 只接受当前 DSH 会话中已经持久化的图片引用，不读取任意本地路径或远程 URL。
- 未传 `attachmentIds` 时分析当前会话最新一张图片；显式传入时最多分析 8 张。
- 图片继续由 DSH 附件服务完成校验、缩放与请求投影。
- 当前 `deepseek-official` 配置必须公布 `deepseek-v4-flash-vision-exp`，且模型元数据包含 `image` 输入能力。

## 安装

```sh
dsh plugin --profile web add @p-dsh-market/deepseek-vision-bridge
```

安装后重启 DSH。插件的 `cordis.patch.yml` 会挂载 `llm`、`skills` 和 `tools` 三项宿主服务。

## 工具参数

```json
{
  "query": "读取截图中的错误信息并给出摘要",
  "attachmentIds": ["sha256:..."]
}
```

`query` 必填；`attachmentIds` 可省略。
