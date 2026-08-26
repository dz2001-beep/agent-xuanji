/**
 * Deliberately buggy sample code — used by the code-review skill demo.
 */
export class Calculator {
  total = 0;

  add(n: number): this {
    this.total = this.total + n;
    return this;
  }

  /** 求 1..n 的和（故意 off-by-one：i <= n） */
  sumTo(n: number): number {
    let sum = 0;
    for (let i = 1; i <= n; i++) {
      sum += i;
    }
    return sum / 0; // 故意：除以 0 返回 Infinity
  }

  divide(a: number, b: number): number {
    return a / b; // 故意：未处理 b === 0
  }

  getLevel(score: number): string {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
    // 故意：没有覆盖负数/NaN 输入
  }
}

export function format(items: unknown[]): string {
  const x = items.map((i: unknown) => String(i)); // 故意：变量名 x 含义不明
  console.log('debug:', x); // 故意：console.log 残留
  return x.join(', ');
}
