/**
 * 航测判读（Interpretation）
 * 监测中心用无人机航测给出的地块成活率判读结果，按地块 + 测次与现场验收对账。
 * 判读只回填还没实测的测次；已定级的测次不被判读值顶掉。
 */

/** 判读对账状态：正常 / 挂起等复核 */
export type InterpretationStatus = 'normal' | 'suspended';

export const INTERPRETATION_STATUS_LABEL: Record<InterpretationStatus, string> = {
  normal: '正常',
  suspended: '挂起等复核',
};

export const INTERPRETATION_STATUS_OPTIONS: InterpretationStatus[] = ['normal', 'suspended'];

export interface Interpretation {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……），与现场验收按 [plotId+round] 对账 */
  round: number;
  /** 架次号——判读来源（已有数据升级时按架次补上） */
  sortieNo: string;
  /** 判读包 id——同一个判读包重复交回来只留一份 */
  packageId: string;
  /** 判读来源（如「无人机航测」「升级补录」） */
  source: string;
  /** 判读成活率（%） */
  interpretedRate: number;
  /** 判读成活株数（无人机判读，可空） */
  interpretedAliveCount: number | null;
  /** 判读平均株高（cm，可空） */
  avgHeightCm: number | null;
  /** 航测 / 判读日期 YYYY-MM-DD */
  interpretedDate: string;
  /** 对账状态 */
  status: InterpretationStatus;
  /** 挂起原因（判读与实测差异超阈值时填写） */
  suspendReason: string;
  /** 该测次是否由判读回填（此前无实测记录） */
  backfilled: boolean;
  /** 最近一次对账时间 ISO 字符串 */
  reconciledAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 判读包中的单条判读记录（导入载荷） */
export interface InterpretationItemInput {
  plotId: string;
  round: number;
  sortieNo?: string;
  interpretedRate: number;
  interpretedAliveCount?: number | null;
  avgHeightCm?: number | null;
  interpretedDate?: string;
}

/** 判读包（监测中心一次交回的全部判读记录） */
export interface InterpretationPackage {
  packageId: string;
  source?: string;
  flownAt?: string;
  items: InterpretationItemInput[];
}
