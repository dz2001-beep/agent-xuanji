---
name: sqlite-query
description: 编写与优化 SQLite SQL 查询，给出可执行的建表、增删改查语句，并解释执行计划。
---

# SQLite Query 技能

当用户请求编写或优化 SQL（"sql"、"查询"、"建表"等）时：

## 流程

1. **澄清需求**：表结构、字段类型、期望结果；不确定时先给出合理假设并说明。
2. **编写 SQL**：遵循以下约定：
   - 关键字大写，表名/列名小写蛇形（snake_case）
   - 始终用 `EXPLAIN QUERY PLAN` 审视慢查询
   - 多表查询优先 JOIN 而非子查询；需要去重时优先 EXISTS 而非 IN
   - 聚合先 WHERE 后 GROUP BY / HAVING
3. **输出格式**：先给完整 SQL 语句，再逐段解释关键点，最后（如有）给出索引建议：

   ```sql
   CREATE INDEX idx_orders_user ON orders(user_id, created_at);
   ```

4. **验证**：若环境可用（sqlite3 CLI），用 `shell.run` 实际执行并返回结果行数与示例输出。
