/**
 * 无人机航测判读对账状态管理（Zustand）
 * 维护判读包 / 判读条目缓存、筛选条件与导入 / 复核 / 删除动作。
 * 所有写操作收口到 utils/db 的单事务函数：导入失败整体回滚，只影响判读这一侧。
 */
import { create } from 'zustand';
import type { AerialItem, AerialPackage, AerialPackageInput, AerialResolveVerdict, AerialStatus } from '../types/aerial';
import {
  importAerialPackage,
  initDatabase,
  listAerialItems,
  listAerialPackages,
  removeAerialPackage,
  resolveAerialItem,
  type ImportAerialResult,
} from '../utils/db';

export interface AerialFilters {
  plotId: string | 'all';
  status: AerialStatus | 'all';
  keyword: string;
}

const EMPTY_FILTERS: AerialFilters = { plotId: 'all', status: 'all', keyword: '' };

interface AerialStoreState {
  packages: AerialPackage[];
  items: AerialItem[];
  loading: boolean;
  ready: boolean;
  filters: AerialFilters;
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setFilters: (patch: Partial<AerialFilters>) => void;
  resetFilters: () => void;
  /** 导入判读包：同一 packageId 重复交回只留一份；失败抛错由页面提示 */
  importPackage: (input: AerialPackageInput) => Promise<ImportAerialResult>;
  /** 复核挂起条目 */
  resolveItem: (itemId: string, verdict: AerialResolveVerdict) => Promise<void>;
  /** 删除判读包（条目与其未被现场顶替的回填占位一并清理） */
  removePackage: (packageRef: string) => Promise<void>;
}

export const useAerialStore = create<AerialStoreState>((set, get) => ({
  packages: [],
  items: [],
  loading: true,
  ready: false,
  filters: { ...EMPTY_FILTERS },
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    await get().refresh();
  },

  async refresh() {
    set({ loading: true });
    const [packages, items] = await Promise.all([listAerialPackages(), listAerialItems()]);
    set({ packages, items, loading: false, ready: true, revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  async importPackage(input) {
    // 事务内完成全部写入：任一步失败抛错回滚，现场测次不受影响，可直接重新交回重试
    const result = await importAerialPackage(input);
    await get().refresh();
    set({
      lastMessage: result.resubmitted
        ? `判读包 ${result.packageId} 为重复交回，已按最新内容替换（仍只保留一份）`
        : `判读包 ${result.packageId} 已接收：对账一致 ${result.matched} 条、挂起 ${result.suspended} 条、回填 ${result.backfilled} 条`,
    });
    return result;
  },

  async resolveItem(itemId, verdict) {
    await resolveAerialItem(itemId, verdict);
    await get().refresh();
    set({ lastMessage: `挂起测次已按「${verdict}」复核结案` });
  },

  async removePackage(packageRef) {
    await removeAerialPackage(packageRef);
    await get().refresh();
    set({ lastMessage: '判读包及其判读条目已删除' });
  },
}));
