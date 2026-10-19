import { describe, expect, it } from 'vitest';
import { agentToolSchemas } from '@novalab/bridge/mcp-tools';
import { SKILL_PACKS, skillsPromptSection } from './skills';
import { AGENT_SYSTEM_PROMPT } from './systemPrompt';

describe('技能包（ADR-016）', () => {
  it('每个技能依赖的契约 kind 都能通过 verify 的 schema', () => {
    for (const pack of SKILL_PACKS) {
      for (const kind of pack.contractKinds) {
        const res = agentToolSchemas.verify.safeParse({ runId: 'r', contracts: [{ kind }] });
        // 缺参数会失败，但失败原因不能是"未知 kind"（判别字段不匹配）
        const unknownKind = !res.success && res.error.issues.some((i) => i.code === 'invalid_union' && i.path.join('.') === 'contracts.0.kind');
        expect(unknownKind, `${pack.id} → ${kind}`).toBe(false);
      }
    }
    // 守护本测试自身：未知 kind 确实会被识别出来
    const bogus = agentToolSchemas.verify.safeParse({ runId: 'r', contracts: [{ kind: 'frobnicate' }] });
    expect(!bogus.success && bogus.error.issues.some((i) => i.code === 'invalid_union' && i.path.join('.') === 'contracts.0.kind')).toBe(true);
  });

  it('两个通用技能的典型契约可以直接通过校验', () => {
    const ok = agentToolSchemas.verify.safeParse({
      runId: 'r',
      contracts: [
        {
          kind: 'mapping_conserved',
          mapping: 'group_map',
          before: { target: 'raw', column: 'src_group', value: 'n', phase: 'before' },
          after: { target: 'summary', column: 'group', value: 'n' },
        },
        { kind: 'mapping_conserved', mapping: { a: 'X' }, before: { target: 'raw', column: 'g' }, after: { target: 'out', column: 'h' } },
        { kind: 'margins_match', target: 'fitted', rows: 'row_targets', cols: [4, 6] },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('system prompt 含全部技能段落，id 不重复', () => {
    const ids = SKILL_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_SYSTEM_PROMPT).toContain(skillsPromptSection());
    for (const p of SKILL_PACKS) expect(AGENT_SYSTEM_PROMPT).toContain(`（${p.id}）`);
  });
});
