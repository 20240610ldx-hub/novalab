import { create } from 'zustand';
import type { Cell, DagEdge, KernelState, StagedDiff, VarSchema } from '../kernel/types';

interface NotebookStore {
  cells: Cell[];
  dagEdges: DagEdge[];
  staleSet: string[];
  schemas: VarSchema[];
  kernelState: KernelState;
  diffs: StagedDiff[];
  activeCellId: string | null;

  setState: (patch: Partial<Omit<NotebookStore, 'setState' | 'setActive'>>) => void;
  setActive: (cellId: string | null) => void;
}

/** 全局状态：cell 列表、DAG、stale 集合、diff 队列、内核状态（spec §10）。 */
export const useNotebook = create<NotebookStore>((set) => ({
  cells: [],
  dagEdges: [],
  staleSet: [],
  schemas: [],
  kernelState: 'connecting',
  diffs: [],
  activeCellId: null,

  setState: (patch) => set(patch),
  setActive: (cellId) => set({ activeCellId: cellId }),
}));
