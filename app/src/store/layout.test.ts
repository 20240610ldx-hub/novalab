import { describe, expect, it } from 'vitest';
import {
  AGENT_MAX,
  AGENT_MIN,
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  SIDE_MAX,
  SIDE_MIN,
  clamp,
  clickActivity,
  loadLayout,
  parseLayout,
  persistLayout,
  useLayout,
} from './layout';

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

describe('parseLayout', () => {
  it('缺省/损坏 → 默认布局', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{oops')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[1,2]')).toEqual(DEFAULT_LAYOUT);
  });

  it('宽度越界夹紧、未知活动项回默认、类型不对回默认', () => {
    const p = parseLayout(
      JSON.stringify({ activity: 'search', sideOpen: 'yes', sideWidth: 9999, agentOpen: false, agentWidth: 10 }),
    );
    expect(p).toEqual({
      activity: 'explorer',
      sideOpen: true,
      sideWidth: SIDE_MAX,
      agentOpen: false,
      agentWidth: AGENT_MIN,
    });
  });

  it('合法值原样保留', () => {
    const v = { activity: 'sessions', sideOpen: false, sideWidth: 300, agentOpen: true, agentWidth: 500 };
    expect(parseLayout(JSON.stringify(v))).toEqual(v);
  });
});

describe('clamp', () => {
  it('取整并夹紧；NaN → 下限', () => {
    expect(clamp(250.6, SIDE_MIN, SIDE_MAX)).toBe(251);
    expect(clamp(10, SIDE_MIN, SIDE_MAX)).toBe(SIDE_MIN);
    expect(clamp(Number.NaN, AGENT_MIN, AGENT_MAX)).toBe(AGENT_MIN);
  });
});

describe('clickActivity（VS Code 语义）', () => {
  it('点其他项 → 切换并打开侧栏；点当前项 → 开合', () => {
    expect(clickActivity({ activity: 'explorer', sideOpen: false }, 'sessions')).toEqual({
      activity: 'sessions',
      sideOpen: true,
    });
    expect(clickActivity({ activity: 'explorer', sideOpen: true }, 'explorer')).toEqual({
      activity: 'explorer',
      sideOpen: false,
    });
    expect(clickActivity({ activity: 'explorer', sideOpen: false }, 'explorer')).toEqual({
      activity: 'explorer',
      sideOpen: true,
    });
  });
});

describe('load/persist', () => {
  it('往返；storage 抛异常不炸', () => {
    const s = memStorage();
    persistLayout(s, { ...DEFAULT_LAYOUT, sideWidth: 320 });
    expect(JSON.parse(s.dump()[LAYOUT_KEY]!).sideWidth).toBe(320);
    expect(loadLayout(s).sideWidth).toBe(320);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadLayout(throwing)).toEqual(DEFAULT_LAYOUT);
    expect(() => persistLayout(throwing, DEFAULT_LAYOUT)).not.toThrow();
  });
});

describe('useLayout', () => {
  it('动作更新内存态；宽度经夹紧；编辑区视图切换', () => {
    const st = useLayout.getState();
    st.setSideWidth(5);
    expect(useLayout.getState().sideWidth).toBe(SIDE_MIN);
    st.selectActivity('variables');
    expect(useLayout.getState()).toMatchObject({ activity: 'variables', sideOpen: true });
    st.toggleAgent();
    expect(useLayout.getState().agentOpen).toBe(!DEFAULT_LAYOUT.agentOpen);
    st.showNotebook();
    expect(useLayout.getState().editorView).toBe('notebook');
    st.showWelcome();
    expect(useLayout.getState().editorView).toBe('welcome');
  });
});
