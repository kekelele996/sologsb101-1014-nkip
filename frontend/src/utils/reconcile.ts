/**
 * 航测判读对账工具
 * - 判读成活率与实测成活株数、株高差得多 → 挂起等复核
 * - 判读只回填还没实测的测次；已定级测次不被判读值顶掉
 * - 同一个判读包重复交回来只留一份（packageId 去重）
 */
import type {
  Interpretation,
  InterpretationItemInput,
  InterpretationPackage,
  InterpretationStatus,
} from '../types/interpretation';
import type { Survey } from '../types/survey';
import { calcSurvivalRate, round1 } from './rate';
import { nowIso, uuid } from './id';

/** 判读成活率与实测成活率差异阈值（百分点），超过则挂起 */
export const RATE_DIFF_THRESHOLD = 10;
/** 判读成活株数与实测成活株数差异阈值（%），超过则挂起 */
export const ALIVE_COUNT_DIFF_PCT = 15;
/** 判读株高与实测株高差异阈值（%），超过则挂起 */
export const HEIGHT_DIFF_PCT = 15;

/** 升级补录判读包 id（已有数据没有判读来源，升级时按架次补上） */
export const UPGRADE_PACKAGE_ID = 'pkg-upgrade-v3';

export interface ReconcileResult {
  status: InterpretationStatus;
  /** 挂起原因（差异超阈值时填写） */
  suspendReason: string;
  /** 判读成活率与实测成活率之差（百分点，绝对值） */
  rateDiff: number | null;
  /** 判读成活株数与实测成活株数之差（%，绝对值） */
  aliveDiffPct: number | null;
  /** 判读株高与实测株高之差（%，绝对值） */
  heightDiffPct: number | null;
}

/**
 * 对账：判读 vs 实测。
 * 差异超阈值 → 挂起等复核；实测为空（还没实测）时不做差异判定，由调用方回填。
 */
export function reconcileInterpretation(
  interp: Pick<Interpretation, 'interpretedRate' | 'interpretedAliveCount' | 'avgHeightCm'>,
  survey: Survey | null,
  totalCount: number,
): ReconcileResult {
  if (survey === null) {
    return { status: 'normal', suspendReason: '', rateDiff: null, aliveDiffPct: null, heightDiffPct: null };
  }
  const measuredRate = calcSurvivalRate(survey.aliveCount, totalCount);
  const rateDiff = round1(Math.abs(interp.interpretedRate - measuredRate));
  const aliveDiffPct =
    interp.interpretedAliveCount != null && survey.aliveCount > 0
      ? round1((Math.abs(interp.interpretedAliveCount - survey.aliveCount) / survey.aliveCount) * 100)
      : null;
  const heightDiffPct =
    interp.avgHeightCm != null && survey.avgHeightCm > 0
      ? round1((Math.abs(interp.avgHeightCm - survey.avgHeightCm) / survey.avgHeightCm) * 100)
      : null;
  const reasons: string[] = [];
  if (rateDiff > RATE_DIFF_THRESHOLD) {
    reasons.push(`成活率差 ${rateDiff} 个百分点（阈值 ${RATE_DIFF_THRESHOLD}）`);
  }
  if (aliveDiffPct != null && aliveDiffPct > ALIVE_COUNT_DIFF_PCT) {
    reasons.push(`成活株数差 ${aliveDiffPct}%（阈值 ${ALIVE_COUNT_DIFF_PCT}%）`);
  }
  if (heightDiffPct != null && heightDiffPct > HEIGHT_DIFF_PCT) {
    reasons.push(`株高差 ${heightDiffPct}%（阈值 ${HEIGHT_DIFF_PCT}%）`);
  }
  return {
    status: reasons.length > 0 ? 'suspended' : 'normal',
    suspendReason: reasons.join('；'),
    rateDiff,
    aliveDiffPct,
    heightDiffPct,
  };
}

export interface PackageParseResult {
  ok: boolean;
  message: string;
  pkg: InterpretationPackage | null;
}

/** 解析并校验判读包 JSON（失败时不写任何数据，现场测次照旧） */
export function parseInterpretationPackage(text: string): PackageParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: '判读包 JSON 解析失败，请确认文件内容完整。', pkg: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '判读包格式不正确：顶层必须是对象。', pkg: null };
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.packageId !== 'string' || data.packageId.trim() === '') {
    return { ok: false, message: '判读包缺少 packageId（判读包编号），无法去重。', pkg: null };
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    return { ok: false, message: '判读包缺少 items 数组或为空。', pkg: null };
  }
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i] as Record<string, unknown>;
    if (typeof item.plotId !== 'string' || item.plotId.trim() === '') {
      return { ok: false, message: `第 ${i + 1} 条判读缺少 plotId。`, pkg: null };
    }
    if (typeof item.round !== 'number' || !Number.isFinite(item.round) || item.round < 1) {
      return { ok: false, message: `第 ${i + 1} 条判读缺少合法 round（测次）。`, pkg: null };
    }
    if (typeof item.interpretedRate !== 'number' || !Number.isFinite(item.interpretedRate)) {
      return { ok: false, message: `第 ${i + 1} 条判读缺少 interpretedRate（判读成活率）。`, pkg: null };
    }
  }
  return {
    ok: true,
    message: '判读包校验通过。',
    pkg: {
      packageId: data.packageId as string,
      source: typeof data.source === 'string' ? data.source : '',
      flownAt: typeof data.flownAt === 'string' ? data.flownAt : '',
      items: data.items as InterpretationItemInput[],
    },
  };
}

/** 由判读包条目构造一条判读记录（状态与对账结果由导入流程回填） */
export function buildInterpretationRow(
  item: InterpretationItemInput,
  pkg: InterpretationPackage,
): Interpretation {
  const stamp = nowIso();
  return {
    id: uuid('interp'),
    plotId: item.plotId,
    round: item.round,
    sortieNo: item.sortieNo?.trim() || `架次-${String(item.round).padStart(3, '0')}`,
    packageId: pkg.packageId,
    source: pkg.source?.trim() || '无人机航测',
    interpretedRate: round1(item.interpretedRate),
    interpretedAliveCount:
      typeof item.interpretedAliveCount === 'number' && Number.isFinite(item.interpretedAliveCount)
        ? Math.round(item.interpretedAliveCount)
        : null,
    avgHeightCm:
      typeof item.avgHeightCm === 'number' && Number.isFinite(item.avgHeightCm)
        ? round1(item.avgHeightCm)
        : null,
    interpretedDate: item.interpretedDate?.trim() || pkg.flownAt || stamp.slice(0, 10),
    status: 'normal',
    suspendReason: '',
    backfilled: false,
    reconciledAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 2,
  };
}
