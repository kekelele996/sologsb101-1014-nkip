/**
 * 航测判读状态管理（Zustand）
 * 判读包导入 / 对账 / 挂起复核 / 失败重试；判读只回填还没实测的测次。
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Interpretation, InterpretationStatus } from '../types/interpretation';
import {
  db,
  hasSuspendedInterpretation,
  importInterpretationPackage,
  initDatabase,
  removeInterpretation,
  resolveInterpretation,
} from '../utils/db';
import { parseInterpretationPackage } from '../utils/reconcile';
import { usePlotStore } from './plotStore';

/** 判读筛选条件（地块 + 状态 + 关键字） */
export interface InterpretationFilters {
  plotId: string | 'all';
  status: InterpretationStatus | 'all';
  keyword: string;
}

/** 最近一次判读包导入结果（失败时保留原文，供「只重试判读这一侧」） */
export interface LastImport {
  ok: boolean;
  message: string;
  packageId: string;
  /** 是否可重试（失败且保留了原始报文） */
  retriable: boolean;
  rawText: string;
}

interface InterpretationStoreState {
  interpretations: Interpretation[];
  loading: boolean;
  ready: boolean;
  error: string;
  filters: InterpretationFilters;
  selectedIds: string[];
  lastImport: LastImport | null;
  revision: number;
  init: () => Promise<void>;
  setFilters: (patch: Partial<InterpretationFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  /** 导入判读包原文（解析失败 / 事务回滚均不触碰现场测次） */
  importPackageText: (text: string) => Promise<boolean>;
  /** 重试最近一次失败的判读导入（只重试判读这一侧） */
  retryImport: () => Promise<boolean>;
  /** 挂起复核通过：恢复正常 */
  resolve: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  hasSuspendedForPlot: (plotId: string) => Promise<boolean>;
}

const EMPTY_FILTERS: InterpretationFilters = { plotId: 'all', status: 'all', keyword: '' };

let subscribed = false;

export const useInterpretationStore = create<InterpretationStoreState>((set, get) => ({
  interpretations: [],
  loading: true,
  ready: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  lastImport: null,
  revision: 0,

  async init() {
    await initDatabase();
    if (subscribed) return;
    subscribed = true;
    liveQuery(() => db.interpretations.toArray()).subscribe({
      next: (interpretations) => {
        set({ interpretations, ready: true, loading: false, error: '' });
      },
      error: (err: unknown) => {
        set({ error: err instanceof Error ? err.message : '读取航测判读数据失败', loading: false });
      },
    });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  async importPackageText(text) {
    const parsed = parseInterpretationPackage(text);
    if (!parsed.ok || parsed.pkg === null) {
      // 解析失败：不写任何数据，现场测次照旧
      set({
        lastImport: { ok: false, message: parsed.message, packageId: '', retriable: true, rawText: text },
        revision: get().revision + 1,
      });
      return false;
    }
    try {
      const result = await importInterpretationPackage(parsed.pkg);
      const parts = [`导入判读 ${result.imported} 条`];
      if (result.duplicated > 0) parts.push(`重复包跳过 ${result.duplicated} 条`);
      if (result.backfilled > 0) parts.push(`回填测次 ${result.backfilled} 个`);
      if (result.suspended > 0) parts.push(`挂起复核 ${result.suspended} 条`);
      set({
        lastImport: {
          ok: true,
          message: parts.join('，'),
          packageId: parsed.pkg.packageId,
          retriable: false,
          rawText: '',
        },
        revision: get().revision + 1,
      });
      await usePlotStore.getState().refreshCounts();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '判读导入失败';
      set({
        lastImport: { ok: false, message, packageId: parsed.pkg.packageId, retriable: true, rawText: text },
        revision: get().revision + 1,
      });
      return false;
    }
  },

  async retryImport() {
    const last = get().lastImport;
    if (!last || !last.retriable || last.rawText.trim() === '') return false;
    return get().importPackageText(last.rawText);
  },

  async resolve(id) {
    await resolveInterpretation(id);
    set({ revision: get().revision + 1 });
  },

  async remove(id) {
    await removeInterpretation(id);
    set({
      selectedIds: get().selectedIds.filter((rowId) => rowId !== id),
      revision: get().revision + 1,
    });
    await usePlotStore.getState().refreshCounts();
  },

  async hasSuspendedForPlot(plotId) {
    return hasSuspendedInterpretation(plotId);
  },
}));
