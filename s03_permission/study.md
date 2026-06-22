## 许可

移除前面课程中的 bash 黑名单和 文件路径校验，变更为向用户咨询许可

## checkPermission

- 允许用户配置一个 bash 命令黑名单 checkDenyList
- 对于 bash 类型的命令，优先检查 checkDenyList, 如果命令在黑名单中，直接返回 permission = false
- 其他类型的命令，使用 checkRules 方法，对命令执行检查
- 如果检查到危险命令（破坏性的bash、非当前工作目录的文件），则调用 askUser 方法寻求用户的建议
- 如果用户拒绝执行，则在本轮工具调用 results 中追加 results.push({ type: "tool_result", tool_use_id: block.id, content: "Permission denied." });
- 并将 results 追加到 history 中，进入下次循环 messages.push({ role: "user", content: results });

## checkRules

- 定义了一个 PERMISSION_RULES，为 tools 分配 check 方法

## askUser

- 在命令行输入当前需要执行的工具、工具需要权限的原因，并询问用户是否    Allow? [y/N]