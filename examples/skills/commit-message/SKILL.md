---
name: commit-message
description: 根据代码变更或描述生成遵循 Conventional Commits 规范的提交信息，支持中英文摘要。
---

# Commit Message 技能

当用户请求生成提交信息（"commit"、"提交信息"、"写个 commit"等）时：

## 流程

1. **获取变更**：优先用 `shell.run` 执行 `git diff --stat` 和 `git diff`（或 `git diff HEAD~1`）查看变更；若无 git 上下文，则依据用户给出的变更描述。
2. **推断类型**（type）：
   - `feat` 新功能 / `fix` 修复 / `docs` 文档 / `style` 格式（不影响逻辑）/ `refactor` 重构（不改变行为）/ `perf` 性能 / `test` 测试 / `chore` 杂项 / `build` 构建 / `ci` CI
3. **输出格式**：

   ```
   type(scope): 简洁的英文或中文摘要（≤ 50 字符）

   - 变更点 1（可选详细列表）
   - 变更点 2
   ```

4. **规则**：只描述"做了什么"，不描述"为什么"的废话；摘要用祈使句；一次提交只表达一个意图；若变更跨多个类型，选最重要的。
5. 若用户要求，直接执行 `git commit -m "..."`。
