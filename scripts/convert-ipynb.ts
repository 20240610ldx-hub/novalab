/**
 * 一次性/工具脚本：.ipynb → NovaLab .py（dogfood bridge importer，P3.4）。
 * 用法（bridge 目录下）：pnpm exec tsx ../scripts/convert-ipynb.ts IN.ipynb OUT.py
 */
import { importIpynb } from '../bridge/src/importer';

const [src, target] = process.argv.slice(2);
if (!src || !target) {
  console.error('usage: convert-ipynb.ts IN.ipynb OUT.py');
  process.exit(2);
}
const res = importIpynb(src, target);
console.log(
  JSON.stringify(
    { path: res.path, cells: res.cells.length, warnings: res.warnings.length, sample: res.warnings.slice(0, 5) },
    null,
    2,
  ),
);
