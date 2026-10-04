/**
 * 航测判读 × 现场验收对账规则（纯函数）
 * - 按地块 + 测次匹配判读条目与现场验收记录
 * - 判读成活率 / 平均株高与现场实测差异超阈值 → 挂起等复核
 * - 挂起期间调用方不得据此生成补植计划
 * 阈值集中在此，验收台与航测对账台共用同一口径。
 */
import type { Survey } from '../types/survey';
import type { AerialItem, AerialItemInput } from '../types/aerial';
import { round1 } from './rate';

/** 成活率对账容差（百分点）：差值 > 该值视为差异过大 */
export const RECONCILE_RATE_TOLERANCE = 5;
/** 平均株高对账容差（厘米）：差值 > 该值视为差异过大 */
export const RECONCILE_HEIGHT_TOLERANCE_CM = 15;

export interface ReconcileResult {
  /** 是否差异过大需要挂起 */
  suspended: boolean;
  /** 成活率差（百分点，保留 1 位小数） */
  rateDiff: number;
  /** 株高差（厘米，保留 1 位小数） */
  heightDiff: number;
  /** 挂起原因文案；对账一致为空串 */
  reason: string;
}

/**
 * 比较一条判读结果与一条现场验收记录。
 * 任一指标超出容差即挂起，原因里列明具体是哪几项超标。
 */
export function reconcileAerialWithSurvey(input: {
  rate: number;
  heightCm: number;
  survey: Pick<Survey, 'survivalRate' | 'avgHeightCm'>;
}): ReconcileResult {
  const rateDiff = round1(Math.abs(input.rate - input.survey.survivalRate));
  const heightDiff = round1(Math.abs(input.heightCm - input.survey.avgHeightCm));
  const reasons: string[] = [];
  if (rateDiff > RECONCILE_RATE_TOLERANCE) {
    reasons.push(`成活率相差 ${rateDiff} 个百分点（容差 ${RECONCILE_RATE_TOLERANCE}）`);
  }
  if (heightDiff > RECONCILE_HEIGHT_TOLERANCE_CM) {
    reasons.push(`平均株高相差 ${heightDiff} cm（容差 ${RECONCILE_HEIGHT_TOLERANCE_CM}）`);
  }
  return {
    suspended: reasons.length > 0,
    rateDiff,
    heightDiff,
    reason: reasons.join('；'),
  };
}

/** 该地块是否存在挂起等复核的判读条目——挂起期间不生成补植计划 */
export function hasSuspendedAerial(items: AerialItem[], plotId: string): boolean {
  return items.some((item) => item.plotId === plotId && item.status === 'suspended');
}

/** 找出一条判读条目当前对应的现场验收记录（按地块 + 测次，且只认真测/回填记录本身） */
export function findFieldSurvey(
  surveys: Survey[],
  plotId: string,
  round: number,
): Survey | undefined {
  return surveys.find((row) => row.plotId === plotId && row.round === round);
}

/** 判读成活率换算成活株数（回填时占位，现场补测后以实测为准） */
export function aliveCountFromRate(rate: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.max(0, Math.min(totalCount, Math.round((rate / 100) * totalCount)));
}

export interface AerialItemValidation {
  ok: boolean;
  message: string;
  item?: AerialItemInput;
}

/** 校验判读包内单条结果的字段 */
export function validateAerialItem(raw: unknown, index: number): AerialItemValidation {
  const prefix = `第 ${index + 1} 条判读结果`;
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: `${prefix}不是对象` };
  const data = raw as Record<string, unknown>;
  const hasPlotId = typeof data.plotId === 'string' && data.plotId !== '';
  const hasPlotName = typeof data.plotName === 'string' && data.plotName !== '';
  if (!hasPlotId && !hasPlotName) return { ok: false, message: `${prefix}缺少 plotId / plotName` };
  if (typeof data.round !== 'number' || data.round < 1) return { ok: false, message: `${prefix}的 round 必须是 ≥ 1 的数字` };
  if (typeof data.survivalRate !== 'number' || data.survivalRate < 0 || data.survivalRate > 100) {
    return { ok: false, message: `${prefix}的 survivalRate 必须是 0–100 的数字` };
  }
  if (typeof data.avgHeightCm !== 'number' || data.avgHeightCm < 0) {
    return { ok: false, message: `${prefix}的 avgHeightCm 必须是 ≥ 0 的数字` };
  }
  return {
    ok: true,
    message: '',
    item: {
      plotId: hasPlotId ? String(data.plotId) : undefined,
      plotName: hasPlotName ? String(data.plotName) : undefined,
      round: data.round,
      survivalRate: round1(data.survivalRate),
      avgHeightCm: round1(data.avgHeightCm),
    },
  };
}
