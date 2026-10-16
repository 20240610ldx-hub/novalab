import { describe, expect, it } from 'vitest';
import { OUTPUT_CHAR_LIMIT } from '../router';
import { AGENT_TOOL_NAMES } from './tools';
import { TOOL_OUTPUT_WHITELIST, TRACEBACK_CHAR_LIMIT } from './output-whitelist';

/** 钉住第二道闸与 router 第一道闸的常量/工具集不漂移（output-whitelist 不能 import router）。 */
describe('output-whitelist 与 router 对齐', () => {
  it('TRACEBACK_CHAR_LIMIT === router.OUTPUT_CHAR_LIMIT', () => {
    expect(TRACEBACK_CHAR_LIMIT).toBe(OUTPUT_CHAR_LIMIT);
  });

  it('白名单覆盖且仅覆盖六个工具', () => {
    expect(Object.keys(TOOL_OUTPUT_WHITELIST).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});
