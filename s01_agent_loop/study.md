
## 常量

- 系统提示词： You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.
- 模型相关参数：api、auth_token、model_name
- 工具定义： bash_tool

## 主线逻辑

1、获取和声明各类常量
2、创建AI会话实例
3、打开 bash，等待用户输入指令
4、声明 history，存储用户全部指令和会话历史，把用户指令作为最新会话:  history.push({ role: "user", content: query });
5、携带用户最新指令进入 loop，直到 loop 结束
6、将 loop 得到的结果返回给用户


## Loop逻辑

1、开启循环，并在循环中执行下面操作：
2、使用AI实例，带着系统提示词、工具定义，会话历史、最新指令，发起会话
3、拿到AI实例返回值，如果返回值不是工具提供的，则中断循环，返回内容
4、在子线程里执行 bash_tool 提供的 bash 命令，并将执行结果存入 results
5、将 results 作为用户输入追加到 history 里，然后进入下一次循环

## bash_tool 逻辑

1、命令限制：const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
2、工具定义
```js
const TOOLS = [{
  name: "bash",           // 工具的名称标识符
  description: "Run a shell command.",  // 告诉模型这工具干什么用
  input_schema: {         // 定义输入参数的 JSON Schema
    type: "object",       
    properties: { 
      command: { 
        type: "string"    // 参数 "command" 必须是字符串
      } 
    },
    required: ["command"] // command 参数是必填的
  },
}];
```
3、模型思考链路
```
用户说："帮我看看当前文件夹有哪些文件"

模型推理：
读取工具清单 → 发现有个 bash 工具
匹配功能描述 → "Run a shell command" 正好适合执行系统命令
检查参数要求 → 需要一个 command 字符串参数
决定调用 → bash({command: "ls -la"})

```
4、模型响应示例
```json
{
  "stop_reason": "tool_use",
  "content": [{
    "type": "tool_use",
    "id": "tool_123",
    "name": "bash",
    "input": {
      "command": "ls -la"
    }
  }]
}
```