import { useCallback, useEffect, useReducer } from 'react';
import { bridge } from '../../bridge/client';
import { controlReduce, type ControlState } from './logic';

/**
 * 控件值乐观更新 + 回退 hook（spec §15.3）。
 *
 * 接线 pending：bridge router（P3.1 多 tab 独占重构线）尚未透传 control.set——
 * 当前 rpc 会以 -32601（method not found）失败，orchestrator 在 P3.1 合入后接线。
 * BridgeClient 的 reject 只携带 message 文本（不带 code），故这里对任何失败
 * （-32601 / 内核 -32000 / 传输层）统一走回退路径：console.warn + 回滚
 * lastGood，不向 UI 抛错（优雅降级，不崩）。
 */
export function useControlCommit<T>(controlId: string, initial: T) {
  const [state, dispatch] = useReducer(controlReduce<T>, {
    value: initial,
    lastGood: initial,
    pending: false,
  } satisfies ControlState<T>);

  // 内核载荷变化（cell 重跑 = 控件重建，值回默认）→ 同步重置乐观状态
  useEffect(() => {
    dispatch({ type: 'reset', value: initial });
  }, [initial]);

  const commit = useCallback(
    (value: T) => {
      dispatch({ type: 'local', value });
      bridge.rpc('control.set', { controlId, value }).then(
        () => dispatch({ type: 'ack' }),
        (err: unknown) => {
          console.warn(`[controls] control.set 失败，回退乐观更新 (${controlId}):`, err);
          dispatch({ type: 'error' });
        },
      );
    },
    [controlId],
  );

  return { value: state.value, pending: state.pending, commit };
}
