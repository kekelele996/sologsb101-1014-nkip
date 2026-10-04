/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Interpretation } from '../types/interpretation';
import { rateLevel, calcSurvivalRate } from './rate';
import { nowIso, today, uuid } from './id';
import { buildInterpretationRow, reconcileInterpretation, UPGRADE_PACKAGE_ID } from './reconcile';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 2;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  interpretations!: Table<Interpretation, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：新增航测判读表，已有验收按架次补齐判读来源 ----------
    this.version(3)
      .stores({
        interpretations: 'id, plotId, [plotId+round], packageId, status, sortieNo',
      })
      .upgrade(async (tx) => {
        // 已有数据没有判读来源：升级时按测次（架次）补齐一条判读记录，来源标为「升级补录」
        const surveys = await tx.table('surveys').toArray();
        const stamp = nowIso();
        const rows = (surveys as Survey[]).map((row) => ({
          id: uuid('interp'),
          plotId: row.plotId,
          round: row.round,
          sortieNo: `升级补录·架次${row.round}`,
          packageId: UPGRADE_PACKAGE_ID,
          source: '升级补录',
          interpretedRate: row.survivalRate,
          interpretedAliveCount: row.aliveCount,
          avgHeightCm: row.avgHeightCm,
          interpretedDate: row.date,
          status: 'normal' as const,
          suspendReason: '',
          backfilled: false,
          reconciledAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }));
        if (rows.length > 0) await tx.table('interpretations').bulkPut(rows);
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与航测判读 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.interpretations], async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.interpretations.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ------------------------------ 航测判读 ------------------------------ */

export async function listInterpretations(): Promise<Interpretation[]> {
  const rows = await db.interpretations.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function putInterpretation(row: Interpretation): Promise<void> {
  await db.interpretations.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeInterpretation(id: string): Promise<void> {
  await db.interpretations.delete(id);
}

/** 判读挂起复核通过：恢复为正常状态 */
export async function resolveInterpretation(id: string): Promise<void> {
  await db.interpretations.update(id, { status: 'normal', suspendReason: '', updatedAt: nowIso() });
}

/** 该地块是否存在挂起等复核的判读（挂起期间不生成补植计划） */
export async function hasSuspendedInterpretation(plotId: string): Promise<boolean> {
  const count = await db.interpretations
    .where('plotId')
    .equals(plotId)
    .filter((row) => row.status === 'suspended')
    .count();
  return count > 0;
}

export interface InterpretationImportResult {
  /** 实际写入的判读条数 */
  imported: number;
  /** 因判读包重复而跳过的条数 */
  duplicated: number;
  /** 由判读回填的测次数（此前无实测记录） */
  backfilled: number;
  /** 挂起等复核的条数 */
  suspended: number;
}

/**
 * 导入航测判读包（事务性：失败则整包回滚，现场测次照旧）。
 * - 同一个判读包（packageId）重复交回来只留一份：已存在则整包跳过
 * - 判读只回填还没实测的测次；已定级测次不被判读值顶掉
 * - 回填的测次按判读值派生成活率与等级
 */
export async function importInterpretationPackage(
  pkg: InterpretationPackageLike,
): Promise<InterpretationImportResult> {
  const result: InterpretationImportResult = { imported: 0, duplicated: 0, backfilled: 0, suspended: 0 };
  await db.transaction('rw', db.interpretations, db.surveys, db.plantings, db.plots, async () => {
    const [existingInterps, existingSurveys, plantings, plots] = await Promise.all([
      db.interpretations.toArray(),
      db.surveys.toArray(),
      db.plantings.toArray(),
      db.plots.toArray(),
    ]);

    // 同一个判读包只留一份：已存在同 packageId 则整包跳过
    if (existingInterps.some((row) => row.packageId === pkg.packageId)) {
      result.duplicated = pkg.items.length;
      return;
    }

    const plotIds = new Set(plots.map((row) => row.id));
    const totalByPlot = new Map<string, number>();
    for (const row of plantings) {
      totalByPlot.set(row.plotId, (totalByPlot.get(row.plotId) ?? 0) + row.count);
    }
    const surveyByPlotRound = new Map<string, Survey>();
    for (const row of existingSurveys) {
      surveyByPlotRound.set(`${row.plotId}__${row.round}`, row);
    }

    const interpRows: Interpretation[] = [];
    const newSurveys: Survey[] = [];
    for (const item of pkg.items) {
      if (!plotIds.has(item.plotId)) {
        throw new Error(`判读条目引用了不存在的地块：${item.plotId}`);
      }
      const key = `${item.plotId}__${item.round}`;
      const existingSurvey = surveyByPlotRound.get(key) ?? null;
      const row = buildInterpretationRow(item, pkg);
      const total = totalByPlot.get(item.plotId) ?? 0;
      const reconcile = reconcileInterpretation(row, existingSurvey, total);
      row.status = reconcile.status;
      row.suspendReason = reconcile.suspendReason;
      row.backfilled = existingSurvey === null;
      if (reconcile.status === 'suspended') result.suspended += 1;

      if (existingSurvey === null) {
        // 还没实测：判读回填该测次（已定级测次 existingSurvey 非空，不会走到这里）
        const aliveCount = row.interpretedAliveCount ?? Math.round((total * row.interpretedRate) / 100);
        const survivalRate = calcSurvivalRate(aliveCount, total);
        newSurveys.push({
          id: uuid('survey'),
          plotId: row.plotId,
          round: row.round,
          date: row.interpretedDate,
          aliveCount,
          avgHeightCm: row.avgHeightCm ?? 0,
          survivalRate,
          grade: rateLevel(survivalRate),
          gradeManual: false,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
          revision: ROW_REVISION,
        });
        result.backfilled += 1;
      }
      interpRows.push(row);
      result.imported += 1;
    }

    if (interpRows.length > 0) await db.interpretations.bulkPut(interpRows);
    if (newSurveys.length > 0) await db.surveys.bulkPut(newSurveys);
  });
  return result;
}

/** 判读包入参（结构与 InterpretationPackage 一致，避免循环依赖在此处用结构类型） */
export interface InterpretationPackageLike {
  packageId: string;
  source?: string;
  flownAt?: string;
  items: Array<{
    plotId: string;
    round: number;
    sortieNo?: string;
    interpretedRate: number;
    interpretedAliveCount?: number | null;
    avgHeightCm?: number | null;
    interpretedDate?: string;
  }>;
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  interpretations: Interpretation[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, interpretations] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.interpretations.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    interpretations,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.interpretations], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.interpretations.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.interpretations.bulkPut(snapshot.interpretations.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.interpretations], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
      db.interpretations.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, interpretations] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.interpretations.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, interpretations };
}
