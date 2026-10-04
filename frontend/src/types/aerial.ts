/**
 * 无人机航测判读（Aerial）
 * 监测中心用无人机航测给出的地块成活率判读结果，按「判读包（架次）→ 判读条目」两级管理。
 * 判读结果只回填还没现场实测的测次；已有现场记录时仅做对账，不覆盖现场数据。
 */

/**
 * 单条判读条目与现场验收的对账状态：
 * - matched   判读与现场一致（差异在阈值内），或已经复核结案
 * - suspended 判读成活率 / 株高与现场实测差异超阈值，挂起等复核
 * - backfilled 该测次尚无现场验收，判读值已回填为临时验收记录
 * - superseded 同一地块 + 测次更新的判读包已交回，本条被替代留痕
 */
export type AerialStatus = 'matched' | 'suspended' | 'backfilled' | 'superseded';

/** 挂起测次的复核结论：以现场实测为准 / 以航测判读为准 */
export type AerialResolveVerdict = '以现场实测为准' | '以航测判读为准';

export const AERIAL_RESOLVE_OPTIONS: AerialResolveVerdict[] = ['以现场实测为准', '以航测判读为准'];

export const AERIAL_STATUS_LABEL: Record<AerialStatus, string> = {
  matched: '对账一致',
  suspended: '挂起等复核',
  backfilled: '判读回填',
  superseded: '已被替代',
};

export interface AerialPackage {
  id: string;
  /** 判读包业务编号：同一编号重复交回只保留一份（去重键） */
  packageId: string;
  /** 无人机架次编号（一个判读包对应一次航测架次） */
  sortie: string;
  /** 航测日期 YYYY-MM-DD */
  flightDate: string;
  /** 监测中心交回日期时间 ISO */
  receivedAt: string;
  /** 条目数（冗余，便于判读包列表展示） */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AerialItem {
  id: string;
  /** 所属判读包主键 */
  packageRef: string;
  /** 判读包业务编号（冗余，便于按包追溯） */
  packageId: string;
  /** 架次编号（冗余） */
  sortie: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……），与现场验收按地块 + 测次对账 */
  round: number;
  /** 判读成活率（百分比，保留 1 位小数） */
  survivalRate: number;
  /** 判读平均株高（厘米） */
  avgHeightCm: number;
  /** 对账状态 */
  status: AerialStatus;
  /** 对账时与现场实测的成活率差（百分点，绝对值），回填态为 null */
  rateDiff: number | null;
  /** 对账时与现场实测的株高差（厘米，绝对值），回填态为 null */
  heightDiff: number | null;
  /** 挂起 / 结案说明（超阈值原因或复核意见） */
  note: string;
  /** 复核结论；未复核为 null */
  resolveVerdict: AerialResolveVerdict | null;
  /** 复核时间 ISO；未复核为 null */
  resolvedAt: string | null;
  /** 若该判读回填了一条现场尚无的验收记录，记录其 survey id */
  backfilledSurveyId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 判读包 JSON 中单条判读结果的入参形态 */
export interface AerialItemInput {
  /** 地块 id，与 plotName 二选一即可 */
  plotId?: string;
  /** 地块名（plotId 缺失时按名称匹配） */
  plotName?: string;
  round: number;
  survivalRate: number;
  avgHeightCm: number;
}

/** 判读包 JSON 的入参形态（监测中心交回文件） */
export interface AerialPackageInput {
  packageId: string;
  sortie: string;
  flightDate: string;
  items: AerialItemInput[];
}
